// ./websocket/server.ts
import http from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import basicAuth from 'basic-auth';
import { ASRService } from './services/asr-service';
import { BotResource } from './services/bot-service';
import { TTSService } from './services/tts-service';

export class Server {
  private server: http.Server;
  private wss: WebSocketServer;

  constructor() {
    // Create an HTTP server (needed if you want to add REST endpoints later)
    this.server = http.createServer();

    // Attach a WebSocketServer at path /ws/audio
    this.wss = new WebSocketServer({
      server: this.server,
      path: '/ws/audio',
    });
  }

  public start(): void {
    // Wire up connection handler
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req));

    // Listen on the port (Azure will set process.env.PORT)
    const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
    this.server.listen(port, () => {
      console.log(`Audio Connector listening on port ${port}`);
    });
  }

  private async onConnection(ws: WebSocket, req: http.IncomingMessage) {
    // --- 1) Authenticate ---
    const creds = basicAuth(req);
    if (
      !creds ||
      creds.name !== process.env.BASIC_USER ||
      creds.pass !== process.env.BASIC_PASS
    ) {
      ws.close(1008, 'Unauthorized');
      return;
    }

    // --- 2) Instantiate services ---
    const asr = new ASRService();
    const tts = new TTSService();
    const bot = new BotResource();

    let isFirstTurn = true;

    // Choose the right handler for the first turn vs. follow-ups
    const handleTranscript = async (transcript: { text: string }) => {
      try {
        let botResp;
        if (isFirstTurn) {
          botResp = await bot.getInitialResponse();
          isFirstTurn = false;
        } else {
          botResp = await bot.getBotResponse(transcript.text);
        }
        // Send audio bytes back
        ws.send(botResp.audioBytes!);
        if (botResp.endSession) {
          ws.close();
        }
      } catch (err) {
        console.error('Bot handling error', err);
        ws.close(1011, 'Internal error');
      }
    };

    // --- 3) Wire ASR events ---
    asr
      .on('error', (e) => {
        console.error('ASR error', e);
        ws.close(1011, 'ASR error');
      })
      .on('final-transcript', handleTranscript);

    // --- 4) Receive raw audio from Genesys ---
    ws.on('message', (msg: Buffer) => {
      // msg is a chunk of μ-law or PCM audio
      asr.processAudio(new Uint8Array(msg));
    });

    // --- 5) Clean up on close ---
    ws.on('close', () => {
      console.log('Connection closed');
      // If you added an asr.shutdown(), call it here
    });
  }
}
