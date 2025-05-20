import * as sdk from 'microsoft-cognitiveservices-speech-sdk';

export class TTSService {
  private synthesizer: sdk.SpeechSynthesizer;

  constructor() {
    // 1) Create SpeechConfig from your Azure Speech resource
    const speechConfig = sdk.SpeechConfig.fromSubscription(
      process.env.SPEECH_KEY!,
      process.env.SPEECH_REGION!
    );
    // (Optional) choose a neural voice
    speechConfig.speechSynthesisVoiceName = 'en-US-JennyNeural';

    // 2) Create the synthesizer
    this.synthesizer = new sdk.SpeechSynthesizer(speechConfig);
  }

  /**
   * Converts the given text into speech bytes (Uint8Array).
   * @param text the text to synthesize
   * @returns Promise resolving to the raw audio bytes
   */
  getAudioBytes(text: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.synthesizer.speakTextAsync(
        text,
        result => {
          if (result.errorDetails) {
            return reject(new Error(result.errorDetails));
          }
          // result.audioData is an ArrayBuffer
          resolve(new Uint8Array(result.audioData));
        },
        error => {
          reject(error);
        }
      );
    });
  }
}
