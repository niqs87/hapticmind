/**
 * Media utilities dla Gemini Live API - wersja Web
 * Wymaga getUserMedia, AudioContext - działa w przeglądarce (Expo web)
 * @see https://github.com/google-gemini/gemini-live-api-examples/blob/main/gemini-live-ephemeral-tokens-websocket/frontend/mediaUtils.js
 */

const INPUT_SAMPLE_RATE = 16000; // Gemini wymaga 16 kHz
const OUTPUT_SAMPLE_RATE = 24000; // Gemini zwraca 24 kHz

/** Wzmocnienie mikrofonu – 1.2 = delikatne. Zbyt wysokie może powodować clipping i zniekształconą transkrypcję. */
const MIC_GAIN = 1.2;

type SendAudioFn = (base64: string) => void;

/** Callback z poziomem głośności 0–1 do wizualizacji */
export type OnLevelUpdateFn = (level: number) => void;

export class WebAudioStreamer {
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private onAudio: SendAudioFn;
  private onLevelUpdate?: OnLevelUpdateFn;
  private isStreaming = false;
  private isMuted = false;
  private analyserAnimationId: number | null = null;

  constructor(onAudio: SendAudioFn, onLevelUpdate?: OnLevelUpdateFn) {
    this.onAudio = onAudio;
    this.onLevelUpdate = onLevelUpdate;
  }

  async start(): Promise<void> {
    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: INPUT_SAMPLE_RATE,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    this.audioContext = new (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)({
      sampleRate: INPUT_SAMPLE_RATE,
    });

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.isStreaming = true; // przed connect, żeby callback od razu obsługiwał
    this.processor.onaudioprocess = (e) => {
      if (!this.isStreaming || this.isMuted) return;
      const input = e.inputBuffer.getChannelData(0);
      if (this.onLevelUpdate) {
        const rms = Math.sqrt(input.reduce((s, x) => s + x * x, 0) / input.length);
        this.onLevelUpdate(Math.min(1, rms * 4));
      }
      const pcm = this.float32ToPcm16(input);
      const base64 = this.arrayBufferToBase64(pcm);
      this.onAudio(base64);
    };

    this.source.connect(this.processor);
    const silentGain = this.audioContext.createGain();
    silentGain.gain.value = 0;
    this.processor.connect(silentGain);
    silentGain.connect(this.audioContext.destination);
  }

  /** Wstrzymaj wysyłanie audio – podczas odtwarzania odpowiedzi AI (ogranicza echo). */
  pause(): void {
    this.isMuted = true;
    this.onLevelUpdate?.(0);
  }

  /** Wznów wysyłanie audio po zakończeniu odtwarzania. */
  resume(): void {
    this.isMuted = false;
  }

  stop() {
    this.isStreaming = false;
    this.isMuted = false;
    if (this.analyserAnimationId) {
      cancelAnimationFrame(this.analyserAnimationId);
      this.analyserAnimationId = null;
    }
    this.processor?.disconnect();
    this.source?.disconnect();
    this.mediaStream?.getTracks().forEach((t) => t.stop());
    this.mediaStream = null;
    this.audioContext?.close();
    this.processor = null;
    this.source = null;
    this.audioContext = null;
  }

  private float32ToPcm16(float32: Float32Array): ArrayBuffer {
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const s = Math.max(-1, Math.min(1, float32[i] * MIC_GAIN));
      int16[i] = s * 0x7fff;
    }
    return int16.buffer;
  }

  private arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }
}

export class WebAudioPlayer {
  private audioContext: AudioContext | null = null;
  private queue: Float32Array[] = [];
  private isPlaying = false;
  private nextStartTime = 0;

  async init() {
    if (this.audioContext) return;
    this.audioContext = new (window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)({
      sampleRate: OUTPUT_SAMPLE_RATE,
    });
  }

  async play(base64Pcm: string) {
    await this.init();
    if (this.audioContext?.state === 'suspended') {
      await this.audioContext.resume();
    }

    const binary = atob(base64Pcm);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = this.audioContext!.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
    buffer.copyToChannel(float32, 0);

    const source = this.audioContext!.createBufferSource();
    source.buffer = buffer;
    source.connect(this.audioContext!.destination);

    if (this.isPlaying) {
      this.nextStartTime = Math.max(this.nextStartTime, this.audioContext!.currentTime);
      source.start(this.nextStartTime);
      this.nextStartTime += buffer.duration;
    } else {
      source.start(0);
      this.nextStartTime = this.audioContext!.currentTime + buffer.duration;
      this.isPlaying = true;
    }

    source.onended = () => {
      this.isPlaying = this.queue.length > 0;
    };
  }

  interrupt() {
    this.nextStartTime = 0;
    this.queue = [];
  }
}
