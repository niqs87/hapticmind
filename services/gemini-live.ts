/**
 * Serwis Gemini Live API - WebSocket client
 * @see https://ai.google.dev/gemini-api/docs/live-api/get-started-websocket
 * @see https://github.com/google-gemini/gemini-live-api-examples
 */

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

export type GeminiLiveMessageType =
  | 'TEXT'
  | 'AUDIO'
  | 'SETUP_COMPLETE'
  | 'INTERRUPTED'
  | 'TURN_COMPLETE'
  | 'TOOL_CALL'
  | 'ERROR'
  | 'INPUT_TRANSCRIPTION'
  | 'OUTPUT_TRANSCRIPTION';

export interface GeminiLiveResponse {
  type: GeminiLiveMessageType;
  data: string | { text: string; finished?: boolean } | object;
  endOfTurn: boolean;
}

export interface GeminiLiveCallbacks {
  onReceiveResponse?: (msg: GeminiLiveResponse) => void;
  onOpen?: () => void;
  onClose?: (reason?: string) => void;
  onError?: (msg: string) => void;
}

export class GeminiLiveService {
  private apiKey: string;
  private ws: WebSocket | null = null;
  private callbacks: GeminiLiveCallbacks = {};
  private connected = false;
  private wsUrl: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.wsUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
  }

  setCallbacks(callbacks: GeminiLiveCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.onopen = () => {
        this.connected = true;
        this.sendConfig();
        this.callbacks.onOpen?.();
        resolve();
      };

      this.ws.onerror = (event) => {
        this.connected = false;
        this.callbacks.onError?.('Błąd połączenia WebSocket');
        reject(new Error('WebSocket error'));
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        const reason = event.code !== 1000 ? ` (kod: ${event.code}${event.reason ? `, ${event.reason}` : ''})` : '';
        this.callbacks.onClose?.(reason);
      };

      this.ws.onmessage = (event) => this.handleMessage(event);
    });
  }

  private sendConfig() {
    const setupMessage = {
      setup: {
        model: `models/${MODEL_NAME}`,
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: 'Puck' },
            },
          },
        },
        systemInstruction: {
          parts: [{ text: 'Jesteś pomocnym asystentem głosowym. Odpowiadaj zwięźle po polsku.' }],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        // Wykrywanie końca mowy – serwer sam wie, kiedy przestałeś mówić
        // @see https://github.com/google-gemini/gemini-live-api-examples/blob/main/gemini-live-ephemeral-tokens-websocket/frontend/geminilive.js
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: false,
            silenceDurationMs: 1500, // Po 1.5 s ciszy = koniec wypowiedzi
            prefixPaddingMs: 300, // 300 ms przed początkiem mowy
            endOfSpeechSensitivity: 'END_SENSITIVITY_UNSPECIFIED',
            startOfSpeechSensitivity: 'START_SENSITIVITY_UNSPECIFIED',
          },
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS', // barge-in – możesz przerwać odpowiedź
        },
      },
    };
    this.send(setupMessage);
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleMessage(event: MessageEvent) {
    let jsonData: string;
    if (event.data instanceof Blob) {
      jsonData = await event.data.text();
    } else if (event.data instanceof ArrayBuffer) {
      jsonData = new TextDecoder().decode(event.data);
    } else {
      jsonData = event.data as string;
    }

    try {
      const data = JSON.parse(jsonData);
      const msg = this.parseResponse(data);
      if (msg) this.callbacks.onReceiveResponse?.(msg);
    } catch (err) {
      console.error('Gemini Live parse error:', err);
    }
  }

  private parseResponse(data: Record<string, unknown>): GeminiLiveResponse | null {
    const serverContent = data?.serverContent as Record<string, unknown> | undefined;
    const parts = (serverContent?.modelTurn as Record<string, unknown>)?.parts as Array<Record<string, unknown>> | undefined;

    const response: GeminiLiveResponse = {
      type: 'ERROR',
      data: '',
      endOfTurn: !!serverContent?.turnComplete,
    };

    if (data?.setupComplete) {
      response.type = 'SETUP_COMPLETE';
      return response;
    }
    if (serverContent?.turnComplete) {
      response.type = 'TURN_COMPLETE';
      return response;
    }
    if (serverContent?.interrupted) {
      response.type = 'INTERRUPTED';
      return response;
    }
    if (serverContent?.inputTranscription) {
      const it = serverContent.inputTranscription as Record<string, unknown>;
      response.type = 'INPUT_TRANSCRIPTION';
      response.data = {
        text: (it.text as string) || '',
        finished: (it.finished as boolean) ?? false,
      };
      return response;
    }
    if (serverContent?.outputTranscription) {
      const ot = serverContent.outputTranscription as Record<string, unknown>;
      response.type = 'OUTPUT_TRANSCRIPTION';
      response.data = {
        text: (ot.text as string) || '',
        finished: (ot.finished as boolean) ?? false,
      };
      return response;
    }
    if (data?.toolCall) {
      response.type = 'TOOL_CALL';
      response.data = data.toolCall as object;
      return response;
    }
    if (parts?.[0]?.text) {
      response.type = 'TEXT';
      response.data = parts[0].text as string;
      return response;
    }
    if (parts?.[0]?.inlineData) {
      const inline = parts[0].inlineData as Record<string, unknown>;
      response.type = 'AUDIO';
      response.data = (inline.data as string) || '';
      return response;
    }

    return null;
  }

  sendText(text: string) {
    this.send({
      realtimeInput: { text },
    });
  }

  sendAudio(base64Pcm: string) {
    this.send({
      realtimeInput: {
        audio: {
          data: base64Pcm,
          mimeType: 'audio/pcm;rate=16000',
        },
      },
    });
  }

  sendVideoFrame(base64Jpeg: string) {
    this.send({
      realtimeInput: {
        video: {
          data: base64Jpeg,
          mimeType: 'image/jpeg',
        },
      },
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }
}
