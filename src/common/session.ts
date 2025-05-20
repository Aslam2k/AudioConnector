import { v4 as uuid } from 'uuid';
import { WebSocket } from 'ws';
import {
    JsonStringMap,
    MediaParameter
} from '../protocol/core';
import {
    ClientMessage,
    DisconnectParameters,
    DisconnectReason,
    EventParameters,
    SelectParametersForType,
    ServerMessage,
    ServerMessageBase,
    ServerMessageType
} from '../protocol/message';
import {
    BotResource,
    BotResponse
} from '../services/bot-service';
import {
    ASRService,
    Transcript
} from '../services/asr-service';
import { DTMFService } from '../services/dtmf-service';
import { MessageHandlerRegistry } from '../websocket/message-handlers/message-handler-registry';
import {
    BotTurnDisposition,
    EventEntityBargeIn,
    EventEntityBotTurnResponse
} from '../protocol/voice-bots';

export class Session {
    private MAXIMUM_BINARY_MESSAGE_SIZE = 64000;
    private disconnecting = false;
    private closed = false;
    private ws: WebSocket;

    private messageHandlerRegistry = new MessageHandlerRegistry();
    private asrService: ASRService | null = null;
    private dtmfService: DTMFService | null = null;
    private url: string;
    private clientSessionId: string;
    private conversationId: string | undefined;
    private lastServerSequenceNumber = 0;
    private lastClientSequenceNumber = 0;
    private inputVariables: JsonStringMap = {};
    private selectedMedia: MediaParameter | undefined;
    private selectedBot: BotResource | null = null;
    private isCapturingDTMF = false;
    private isAudioPlaying = false;

    constructor(ws: WebSocket, sessionId: string, url: string) {
        this.ws = ws;
        this.clientSessionId = sessionId;
        this.url = url;
    }

    close() {
        if (this.closed) return;
        try {
            this.ws.close();
        } catch {}
        this.closed = true;
    }

    setConversationId(conversationId: string) {
        this.conversationId = conversationId;
    }

    setInputVariables(inputVariables: JsonStringMap) {
        this.inputVariables = inputVariables;
    }

    setSelectedMedia(selectedMedia: MediaParameter) {
        this.selectedMedia = selectedMedia;
    }

    setIsAudioPlaying(isAudioPlaying: boolean) {
        this.isAudioPlaying = isAudioPlaying;
    }

    processTextMessage(data: string) {
        if (this.closed) return;
        const message = JSON.parse(data);

        if (message.seq !== this.lastClientSequenceNumber + 1) {
            console.log(`Invalid client sequence number: ${message.seq}.`);
            this.sendDisconnect('error', 'Invalid client sequence number.', {});
            return;
        }

        this.lastClientSequenceNumber = message.seq;

        if (message.serverseq > this.lastServerSequenceNumber) {
            console.log(`Invalid server sequence number: ${message.serverseq}.`);
            this.sendDisconnect('error', 'Invalid server sequence number.', {});
            return;
        }

        if (message.id !== this.clientSessionId) {
            console.log(`Invalid Client Session ID: ${message.id}.`);
            this.sendDisconnect('error', 'Invalid ID specified.', {});
            return;
        }

        const handler = this.messageHandlerRegistry.getHandler(message.type);
        if (!handler) {
            console.log(`Cannot find a message handler for '${message.type}'.`);
            return;
        }

        handler.handleMessage(message as ClientMessage, this);
    }

    createMessage<Type extends ServerMessageType, Message extends ServerMessage>(
        type: Type,
        parameters: SelectParametersForType<Type, Message>
    ): ServerMessage {
        const message: ServerMessageBase<Type, typeof parameters> = {
            id: this.clientSessionId,
            version: '2',
            seq: ++this.lastServerSequenceNumber,
            clientseq: this.lastClientSequenceNumber,
            type,
            parameters
        };
        return message as ServerMessage;
    }

    send(message: ServerMessage) {
        if (message.type === 'event') {
            console.log(`Sending an ${message.type} message: ${message.parameters.entities[0].type}.`);
        } else {
            console.log(`Sending a ${message.type} message.`);
        }
        this.ws.send(JSON.stringify(message));
    }

    sendAudio(bytes: Uint8Array) {
        if (bytes.length <= this.MAXIMUM_BINARY_MESSAGE_SIZE) {
            console.log(`Sending ${bytes.length} binary bytes in 1 message.`);
            this.ws.send(bytes, { binary: true });
        } else {
            let currentPosition = 0;
            while (currentPosition < bytes.length) {
                const sendBytes = bytes.slice(currentPosition, currentPosition + this.MAXIMUM_BINARY_MESSAGE_SIZE);
                console.log(`Sending ${sendBytes.length} binary bytes in chunked message.`);
                this.ws.send(sendBytes, { binary: true });
                currentPosition += this.MAXIMUM_BINARY_MESSAGE_SIZE;
            }
        }
    }

    sendBargeIn() {
        const bargeInEvent: EventEntityBargeIn = {
            type: 'barge_in',
            data: {}
        };
        const message = this.createMessage('event', {
            entities: [bargeInEvent]
        } as SelectParametersForType<'event', EventParameters>);
        this.send(message);
    }

    sendTurnResponse(disposition: BotTurnDisposition, text?: string, confidence?: number) {
        const botTurnResponseEvent: EventEntityBotTurnResponse = {
            type: 'bot_turn_response',
            data: { disposition, text, confidence }
        };
        const message = this.createMessage('event', {
            entities: [botTurnResponseEvent]
        } as SelectParametersForType<'event', EventParameters>);
        this.send(message);
    }

    sendDisconnect(reason: DisconnectReason, info: string, outputVariables: JsonStringMap) {
        this.disconnecting = true;
        const disconnectParameters: DisconnectParameters = { reason, info, outputVariables };
        const message = this.createMessage('disconnect', disconnectParameters);
        this.send(message);
    }

    sendClosed() {
        const message = this.createMessage('closed', {});
        this.send(message);
    }

    /**
     * Pick the Copilot bot for this session. Always exists.
     */
    checkIfBotExists(): Promise<boolean> {
        this.selectedBot = new BotResource();
        return Promise.resolve(true);
    }

    processBotStart() {
        if (!this.selectedBot) return;
        this.selectedBot.getInitialResponse()
            .then((response: BotResponse) => {
                if (response.text) {
                    this.sendTurnResponse(response.disposition, response.text, response.confidence);
                }
                if (response.audioBytes) {
                    this.sendAudio(response.audioBytes);
                }
            });
    }

    processBinaryMessage(data: Uint8Array) {
        if (this.disconnecting || this.closed || !this.selectedBot) return;
        if (this.isCapturingDTMF) return;
        if (this.isAudioPlaying) {
            this.asrService = null;
            this.dtmfService = null;
            return;
        }
        if (!this.asrService || this.asrService.getState() === 'Complete') {
            this.asrService = new ASRService()
                .on('error', (error: any) => {
                    if (this.isCapturingDTMF) return;
                    console.log(`Error during Speech Recognition.: ${error}`);
                    this.sendDisconnect('error', 'Error during Speech Recognition.', {});
                })
                .on('final-transcript', (transcript: Transcript) => {
                    if (this.isCapturingDTMF) return;
                    this.selectedBot!.getBotResponse(transcript.text)
                        .then((response: BotResponse) => {
                            if (response.text) {
                                this.sendTurnResponse(response.disposition, response.text, response.confidence);
                            }
                            if (response.audioBytes) {
                                this.sendAudio(response.audioBytes);
                            }
                            if (response.endSession) {
                                this.sendDisconnect('completed', '', {});
                            }
                        });
                });
        }
        this.asrService.processAudio(data);
    }

    processDTMF(digit: string) {
        if (this.disconnecting || this.closed || !this.selectedBot) return;
        if (this.isAudioPlaying) {
            this.asrService = null;
            this.dtmfService = null;
            return;
        }
        if (!this.isCapturingDTMF) {
            this.isCapturingDTMF = true;
            this.asrService = null;
        }
        if (!this.dtmfService || this.dtmfService.getState() === 'Complete') {
            this.dtmfService = new DTMFService()
                .on('error', (error: any) => {
                    console.log(`Error during DTMF Capture.: ${error}`);
                    this.sendDisconnect('error', 'Error during DTMF Capture.', {});
                })
                .on('final-digits', (digits) => {
                    this.selectedBot!.getBotResponse(digits)
                        .then((response: BotResponse) => {
                            if (response.text) {
                                this.sendTurnResponse(response.disposition, response.text, response.confidence);
                            }
                            if (response.audioBytes) {
                                this.sendAudio(response.audioBytes);
                            }
                            if (response.endSession) {
                                this.sendDisconnect('completed', '', {});
                            }
                            this.isCapturingDTMF = false;
                        });
                });
        }
        this.dtmfService.processDigit(digit);
    }
}
