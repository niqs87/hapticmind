/**
 * Serwis Gemini Live API – WebSocket client
 * Model: gemini-2.5-flash-native-audio-preview-12-2025 (zalecany przez Google)
 * Audio wejście: PCM 16kHz, 16-bit, mono, little-endian
 * Audio wyjście: PCM 24kHz, 16-bit, mono, little-endian
 */

const MODEL = "gemini-2.5-flash-native-audio-preview-12-2025";
const WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export type GeminiLiveMessageType =
  | "AUDIO"
  | "TEXT"
  | "SETUP_COMPLETE"
  | "INTERRUPTED"
  | "TURN_COMPLETE"
  | "INPUT_TRANSCRIPTION"
  | "OUTPUT_TRANSCRIPTION";

export interface GeminiLiveResponse {
  type: GeminiLiveMessageType;
  data: string | { text: string; finished?: boolean } | object;
}

export interface GeminiLiveCallbacks {
  onOpen?: () => void;
  onSetupComplete?: () => void;
  onClose?: (reason?: string) => void;
  onError?: (msg: string) => void;
  onReceiveResponse?: (msg: GeminiLiveResponse) => void;
}

export class GeminiLiveService {
  private ws: WebSocket | null = null;
  private callbacks: GeminiLiveCallbacks = {};
  private connected = false;

  constructor(private apiKey: string) {}

  setCallbacks(cb: GeminiLiveCallbacks) {
    this.callbacks = { ...this.callbacks, ...cb };
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${WS_BASE}?key=${this.apiKey}`);

      this.ws.onopen = () => {
        this.connected = true;
        this.sendSetup();
        this.callbacks.onOpen?.();
        resolve();
      };

      this.ws.onerror = () => {
        this.connected = false;
        this.callbacks.onError?.("Błąd połączenia WebSocket");
        reject(new Error("WebSocket error"));
      };

      this.ws.onclose = (e) => {
        this.connected = false;
        const reason =
          e.code !== 1000
            ? ` (kod: ${e.code}${e.reason ? `, ${e.reason}` : ""})`
            : "";
        this.callbacks.onClose?.(reason);
      };

      this.ws.onmessage = (e) => this.handleMessage(e);
    });
  }

  private sendSetup() {
    this.send({
      setup: {
        model: `models/${MODEL}`,
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: "Puck" } },
          },
        },
        systemInstruction: {
          parts: [
            {
              text: `LANGUAGE RULE (HIGHEST PRIORITY): You MUST detect the language of the user's speech and ALWAYS respond in EXACTLY the same language. If the user speaks Polish, respond in Polish. If the user speaks English, respond in English. If the user speaks German, respond in German. Match the user's language precisely. NEVER default to a single language.

You are a helpful voice assistant. Keep your answers concise.

IMPORTANT: The user asks questions by holding a button and speaking. ALWAYS answer their question – do NOT automatically describe the camera view.
Camera video is context only – use it ONLY when the user asks e.g. "what do you see", "describe the room". For any other question (weather, counting, definitions, etc.) – answer the question and ignore the video.`,
            },
          ],
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: true, // Ręczne sygnały – hold-to-speak
            prefixPaddingMs: 500,
            silenceDurationMs: 1500,
          },
          activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
        },
      },
    });
  }

  // Wyślij audio PCM (base64, 16kHz, 16-bit, mono, little-endian)
  sendAudio(base64Pcm: string) {
    this.send({
      realtimeInput: {
        audio: { data: base64Pcm, mimeType: "audio/pcm;rate=16000" },
      },
    });
  }

  // Poinformuj serwer że mikrofon jest wyciszony — ważne dla VAD
  sendAudioStreamEnd() {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  /** Sygnał: użytkownik zaczął mówić (hold) – gdy VAD wyłączone */
  sendActivityStart() {
    this.send({ realtimeInput: { activityStart: {} } });
  }

  /** Sygnał: użytkownik skończył mówić (release) – gdy VAD wyłączone */
  sendActivityEnd() {
    this.send({ realtimeInput: { activityEnd: {} } });
  }

  // Wiadomość tekstowa od użytkownika
  sendText(text: string) {
    this.send({ realtimeInput: { text } });
  }

  // Klatka wideo (JPEG base64)
  sendVideoFrame(base64Jpeg: string) {
    this.send({
      realtimeInput: {
        video: { data: base64Jpeg, mimeType: "image/jpeg" },
      },
    });
  }

  disconnect() {
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }

  isConnected() {
    return this.connected && this.ws?.readyState === WebSocket.OPEN;
  }

  private send(msg: object) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleMessage(event: MessageEvent) {
    let text: string;
    if (event.data instanceof Blob) {
      text = await event.data.text();
    } else if (event.data instanceof ArrayBuffer) {
      text = new TextDecoder().decode(event.data);
    } else {
      text = event.data as string;
    }

    try {
      const raw = JSON.parse(text) as Record<string, unknown>;
      if (__DEV__) {
        const keys = Object.keys(raw).filter(
          (k) => k !== "serverContent" || !raw.serverContent,
        );
        const hasContent = !!(
          raw.setupComplete ??
          (raw.serverContent as Record<string, unknown>)?.modelTurn ??
          (raw.serverContent as Record<string, unknown>)?.inputTranscription ??
          (raw.serverContent as Record<string, unknown>)?.outputTranscription
        );
        if (hasContent || raw.setupComplete) {
          console.log(
            "[GeminiLive] <-",
            Object.keys(raw).join(","),
            raw.setupComplete
              ? "setupComplete"
              : (raw.serverContent as Record<string, unknown>)?.modelTurn
                ? "audio/text"
                : (raw.serverContent as Record<string, unknown>)
                      ?.inputTranscription
                  ? "inputTranscription"
                  : (raw.serverContent as Record<string, unknown>)
                        ?.outputTranscription
                    ? "outputTranscription"
                    : "?",
          );
        }
      }
      const msg = this.parseResponse(raw);
      if (!msg) return;
      if (msg.type === "SETUP_COMPLETE") {
        this.callbacks.onSetupComplete?.();
      }
      this.callbacks.onReceiveResponse?.(msg);
    } catch (err) {
      console.error("[GeminiLive] parse error:", err);
    }
  }

  private parseResponse(d: Record<string, unknown>): GeminiLiveResponse | null {
    const sc = d?.serverContent as Record<string, unknown> | undefined;
    const parts = (sc?.modelTurn as Record<string, unknown>)?.parts as
      | Record<string, unknown>[]
      | undefined;

    if (d?.setupComplete) return { type: "SETUP_COMPLETE", data: "" };
    if (sc?.turnComplete) return { type: "TURN_COMPLETE", data: "" };
    if (sc?.interrupted) return { type: "INTERRUPTED", data: "" };

    if (sc?.inputTranscription) {
      const it = sc.inputTranscription as Record<string, unknown>;
      return {
        type: "INPUT_TRANSCRIPTION",
        data: {
          text: (it.text as string) ?? "",
          finished: it.finished as boolean,
        },
      };
    }
    if (sc?.outputTranscription) {
      const ot = sc.outputTranscription as Record<string, unknown>;
      return {
        type: "OUTPUT_TRANSCRIPTION",
        data: {
          text: (ot.text as string) ?? "",
          finished: ot.finished as boolean,
        },
      };
    }
    if (parts?.[0]?.inlineData) {
      const inline = parts[0].inlineData as Record<string, unknown>;
      return { type: "AUDIO", data: (inline.data as string) ?? "" };
    }
    if (parts?.[0]?.text) {
      return { type: "TEXT", data: parts[0].text as string };
    }
    return null;
  }
}
