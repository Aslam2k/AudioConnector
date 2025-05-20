import { JsonStringMap } from '../protocol/core';
import { BotTurnDisposition } from '../protocol/voice-bots';
import { TTSService } from './tts-service';

export class BotService {
  private conversationId = '';

  /** Kick off a Direct Line conversation and store the ID */
  async startConversation(): Promise<void> {
    const res = await fetch(
      `${process.env.DIRECTLINE_BASE}/v3/directline/conversations`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DIRECTLINE_SECRET}`,
        },
      }
    );
    const payload = (await res.json()) as { conversationId: string };
    this.conversationId = payload.conversationId;
  }

  /** Post a user message to the bot */
  async postMessage(text: string): Promise<void> {
    await fetch(
      `${process.env.DIRECTLINE_BASE}/v3/directline/conversations/${this.conversationId}/activities`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.DIRECTLINE_SECRET}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type: 'message', text }),
      }
    );
  }

  /** Fetch all activities in this conversation */
  async getActivities(): Promise<any[]> {
    const res = await fetch(
      `${process.env.DIRECTLINE_BASE}/v3/directline/conversations/${this.conversationId}/activities`,
      {
        headers: { 'Authorization': `Bearer ${process.env.DIRECTLINE_SECRET}` },
      }
    );
    const payload = (await res.json()) as { activities: any[] };
    return payload.activities || [];
  }
}

/*
 * BotResource now manages a live conversation.
 * You call getInitialResponse() once, then getBotResponse() on each user turn.
 */
export class BotResource {
  private tts = new TTSService();
  private botSvc = new BotService();
  private seenActivityIds = new Set<string>();

  /** Initialize the Direct Line convo and register the "welcome" update as seen */
  async getInitialResponse(): Promise<BotResponse> {
    await this.botSvc.startConversation();

    // mark existing activities (like the conversationUpdate) as seen
    const existing = await this.botSvc.getActivities();
    existing.forEach(a => this.seenActivityIds.add(a.id));

    // poll for the first bot-sent message (welcome)
    let welcome = '';
    while (!welcome) {
      await new Promise(r => setTimeout(r, 500));
      const acts = await this.botSvc.getActivities();
      for (const a of acts) {
        if (!this.seenActivityIds.has(a.id) && a.from?.id !== 'user' && a.text) {
          welcome = a.text;
          this.seenActivityIds.add(a.id);
          break;
        }
      }
    }

    const audio = await this.tts.getAudioBytes(welcome);
    return new BotResponse('match', welcome)
      .withConfidence(1.0)
      .withAudioBytes(audio);
  }

  /** Send the user’s transcript, wait for the next bot reply, then synthesize it */
  async getBotResponse(userInput: string): Promise<BotResponse> {
    await this.botSvc.postMessage(userInput);

    // poll for the next bot message
    let reply = '';
    while (!reply) {
      await new Promise(r => setTimeout(r, 500));
      const acts = await this.botSvc.getActivities();
      for (const a of acts) {
        if (!this.seenActivityIds.has(a.id) && a.from?.id !== 'user' && a.text) {
          reply = a.text;
          this.seenActivityIds.add(a.id);
          break;
        }
      }
    }

    const audio = await this.tts.getAudioBytes(reply);
    return new BotResponse('match', reply)
      .withConfidence(1.0)
      .withAudioBytes(audio);
  }
}

export class BotResponse {
  disposition: BotTurnDisposition;
  text: string;
  confidence?: number;
  audioBytes?: Uint8Array;
  endSession?: boolean;

  constructor(disposition: BotTurnDisposition, text: string) {
    this.disposition = disposition;
    this.text = text;
  }

  withConfidence(conf: number): this {
    this.confidence = conf;
    return this;
  }

  withAudioBytes(bytes: Uint8Array): this {
    this.audioBytes = bytes;
    return this;
  }

  withEndSession(end: boolean): this {
    this.endSession = end;
    return this;
  }
}
