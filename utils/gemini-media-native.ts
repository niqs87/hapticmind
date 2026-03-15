/**
 * Natywny streamer audio dla Gemini Live API (expo-audio, iOS)
 * Format wejściowy wymagany przez API: PCM 16kHz, 16-bit, mono, little-endian
 *
 * Wymaga przekazania rejestratora z useAudioRecorder (hook musi być w komponencie).
 * Mikrofon NIGDY nie jest wyłączany — Gemini VAD automatycznie wykrywa mowę.
 * @see https://ai.google.dev/gemini-api/docs/live-guide
 */
import {
  type AudioRecorder,
  IOSOutputFormat,
  AudioQuality,
  RecordingPresets,
  type RecordingOptions,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const SAMPLE_RATE = 16000;
const CHUNK_MS = 300;

/** Wzmocnienie mikrofonu – 1.0 = brak. Zbyt wysokie (np. 2.0) może powodować clipping i zniekształconą transkrypcję. */
const MIC_GAIN = 1.2;

/** Opcje nagrywania PCM dla Gemini (16 kHz, LPCM na iOS) – bazuje na presetcie */
export const GEMINI_RECORDING_OPTIONS: RecordingOptions = {
  ...RecordingPresets.HIGH_QUALITY,
  extension: '.caf',
  sampleRate: SAMPLE_RATE,
  numberOfChannels: 1,
  bitRate: SAMPLE_RATE * 16,
  isMeteringEnabled: true,
  ios: {
    ...RecordingPresets.HIGH_QUALITY.ios,
    extension: '.caf',
    outputFormat: IOSOutputFormat.LINEARPCM,
    audioQuality: AudioQuality.MAX,
    sampleRate: SAMPLE_RATE,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
};

function bytesToString(bytes: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = 0; i < len && start + i < bytes.length; i++) s += String.fromCharCode(bytes[start + i]);
  return s;
}

/** Ekstrakcja PCM z CAF. CAF używa big-endian dla nagłówków. */
function extractPcmFromCaf(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    if (bytes.length < 8 || bytesToString(bytes, 0, 4) !== 'caff') return null;

    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const type = bytesToString(bytes, offset, 4);
      offset += 4;
      const dv = new DataView(bytes.buffer, bytes.byteOffset + offset);
      const chunkSizeRaw = dv.getBigUint64(0, false); // CAF: false = big-endian
      const chunkSize =
        chunkSizeRaw === BigInt('0xFFFFFFFFFFFFFFFF') ? -1 : Number(chunkSizeRaw);
      offset += 8;

      if (type === 'data') {
        const dataStart = offset + 4; // skip 4-byte editCount
        const dataEnd =
          chunkSize > 0 && chunkSize <= 0x7fffffff
            ? Math.min(offset + chunkSize, bytes.length)
            : bytes.length;
        if (dataEnd > dataStart) {
          return bytes.slice(dataStart, dataEnd);
        }
        return null;
      }
      if (chunkSize > 0 && chunkSize <= 0x7fffffff) offset += chunkSize;
      else break;
    }
    return null;
  } catch {
    return null;
  }
}

/** Fallback: ekstrakcja PCM z WAV (RIFF). Niektóre biblioteki zapisują WAV pod .caf. */
function extractPcmFromWav(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    if (bytes.length < 44 || bytesToString(bytes, 0, 4) !== 'RIFF' || bytesToString(bytes, 8, 4) !== 'WAVE')
      return null;

    let offset = 12;
    while (offset + 8 <= bytes.length) {
      const chunkId = bytesToString(bytes, offset, 4);
      const dv = new DataView(bytes.buffer, bytes.byteOffset + offset + 4);
      const size = dv.getUint32(0, true);
      offset += 8;

      if (chunkId === 'data') {
        const end = Math.min(offset + size, bytes.length);
        if (end > offset) return bytes.slice(offset, end);
        return null;
      }
      offset += size;
    }
    return null;
  } catch {
    return null;
  }
}

/** Ekstrakcja PCM – CAF lub WAV. */
function extractPcm(base64: string): Uint8Array | null {
  const pcm = extractPcmFromCaf(base64);
  return pcm ?? extractPcmFromWav(base64);
}

/** Zastosuj wzmocnienie do PCM 16-bit LE. Mnoży próbki i obcina do zakresu int16. */
function applyGainToPcm16(pcm: Uint8Array, gain: number): Uint8Array {
  if (gain === 1 || pcm.length < 2) return pcm;
  const out = new Uint8Array(pcm.length);
  const dvIn = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const dvOut = new DataView(out.buffer, out.byteOffset, out.byteLength);
  for (let i = 0; i < pcm.length; i += 2) {
    const s = dvIn.getInt16(i, true);
    const amplified = Math.max(-32768, Math.min(32767, Math.round(s * gain)));
    dvOut.setInt16(i, amplified, true);
  }
  return out;
}

function pcmToBase64(pcm: Uint8Array): string {
  let s = '';
  for (let i = 0; i < pcm.length; i++) s += String.fromCharCode(pcm[i]);
  return btoa(s);
}

type SendAudioFn = (base64: string) => void;
export type OnLevelUpdateFn = (level: number) => void;
export type StreamerState = 'idle' | 'recording' | 'sending';

export class NativeAudioStreamer {
  private recorder: AudioRecorder;
  private sendAudio: SendAudioFn;
  private onLevelUpdate?: OnLevelUpdateFn;
  private onStateChange?: (s: StreamerState) => void;
  private isStreaming = false;
  private isPaused = false;

  constructor(
    recorder: AudioRecorder,
    sendAudio: SendAudioFn,
    onLevelUpdate?: OnLevelUpdateFn,
    onStateChange?: (s: StreamerState) => void,
  ) {
    this.recorder = recorder;
    this.sendAudio = sendAudio;
    this.onLevelUpdate = onLevelUpdate;
    this.onStateChange = onStateChange;
  }

  start(): void {
    if (Platform.OS !== 'ios') return;
    this.isStreaming = true;
    this.runLoop();
  }

  stop(): void {
    this.isStreaming = false;
    this.isPaused = false;
    this.onLevelUpdate?.(0);
    this.onStateChange?.('idle');
  }

  /** Wstrzymaj wysyłanie audio – podczas odtwarzania odpowiedzi AI (ogranicza echo). */
  pause(): void {
    this.isPaused = true;
    this.onLevelUpdate?.(0);
  }

  /** Wznów wysyłanie audio po zakończeniu odtwarzania. */
  resume(): void {
    this.isPaused = false;
  }

  private async runLoop(): Promise<void> {
    while (this.isStreaming) {
      await this.recordAndSend();
    }
  }

  private async recordAndSend(): Promise<void> {
    try {
      if (this.isPaused) {
        await new Promise((r) => setTimeout(r, 100));
        return;
      }

      await this.recorder.prepareToRecordAsync(GEMINI_RECORDING_OPTIONS);
      this.recorder.record();
      this.onStateChange?.('recording');

      const meteringId = setInterval(() => {
        try {
          const s = this.recorder.getStatus();
          if (s.isRecording && s.metering !== undefined) {
            const level = Math.max(0, Math.min(1, (s.metering + 40) / 40));
            this.onLevelUpdate?.(level);
          }
        } catch {}
      }, 100);

      await new Promise((r) => setTimeout(r, CHUNK_MS));
      clearInterval(meteringId);

      if (!this.isStreaming) {
        await this.recorder.stop().catch(() => {});
        return;
      }

      this.onStateChange?.('sending');
      await this.recorder.stop();
      const uri = this.recorder.getStatus().url ?? (this.recorder as { uri?: string | null }).uri;
      if (!uri) return;

      // iOS: krótkie opóźnienie – plik może jeszcze nie być zapisany na dysk
      await new Promise((r) => setTimeout(r, 80));

      const info = await FileSystem.getInfoAsync(uri).catch(() => null);
      if (!info?.exists) return;

      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});

      let pcm = extractPcm(base64);
      if (pcm && pcm.length > 0) {
        pcm = applyGainToPcm16(pcm, MIC_GAIN);
        this.sendAudio(pcmToBase64(pcm));
      }
    } catch (err) {
      if (String(err).includes('does not exist')) return;
      console.warn('[NativeAudioStreamer]', err);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}
