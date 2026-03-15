/**
 * Odtwarzanie audio PCM z Gemini Live API (expo-audio)
 * Wyjście API: PCM 24kHz, 16-bit, mono, little-endian
 *
 * Jeden tryb audio (GEMINI_AUDIO_MODE) – bez przełączania record/playback.
 * Przerywanie wyłącznie przez użytkownika (hold mic).
 */
import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const PLAYBACK_STATUS_UPDATE = 'playbackStatusUpdate';

const SAMPLE_RATE = 24000;

/** Tryb nagrywania – playAndRecord (mikrofon). */
export const GEMINI_AUDIO_MODE = {
  allowsRecording: true,
  playsInSilentMode: true,
  interruptionMode: 'duckOthers' as const,
  shouldPlayInBackground: false,
  shouldRouteThroughEarpiece: false,
} as const;

/** Tryb odtwarzania – głośnik (allowsRecording: false). */
const PLAYBACK_SPEAKER_MODE = {
  ...GEMINI_AUDIO_MODE,
  allowsRecording: false,
} as const;

export async function ensureSpeaker() {
  if (Platform.OS === 'web') return;
  await setAudioModeAsync(PLAYBACK_SPEAKER_MODE).catch(() => {});
}

export async function restoreRecordingMode() {
  if (Platform.OS === 'web') return;
  await setAudioModeAsync(GEMINI_AUDIO_MODE).catch(() => {});
}

const INITIAL_BUFFER_MS = 200;

function createWavHeader(dataLength: number): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  v.setUint32(0, 0x52494646, false); // "RIFF"
  v.setUint32(4, 36 + dataLength, true);
  v.setUint32(8, 0x57415645, false); // "WAVE"
  v.setUint32(12, 0x666d7420, false); // "fmt "
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true); // byteRate
  v.setUint16(32, 2, true); // blockAlign
  v.setUint16(34, 16, true); // bitsPerSample
  v.setUint32(36, 0x64617461, false); // "data"
  v.setUint32(40, dataLength, true);
  return header;
}

function decode(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function merge(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export class NativeAudioPlayer {
  private queue: Uint8Array[] = [];
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private player: AudioPlayer | null = null;
  private currentUri: string | null = null;

  addChunk(base64Pcm: string): void {
    this.queue.push(decode(base64Pcm));
    if (!this.playing && !this.timer) {
      this.timer = setTimeout(() => this.flush(), INITIAL_BUFFER_MS);
    }
  }

  /** Natychmiast zatrzymaj odtwarzanie, wyczyść kolejkę. */
  interrupt(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.queue = [];
    if (this.player) {
      this.player.pause();
      if (this.currentUri) {
        FileSystem.deleteAsync(this.currentUri, { idempotent: true }).catch(() => {});
        this.currentUri = null;
      }
    }
    this.playing = false;
  }

  private flush(): void {
    this.timer = null;
    if (this.queue.length === 0) {
      this.playing = false;
      return;
    }

    if (!this.playing) this.playing = true;

    const pcm = merge(this.queue.splice(0));
    this.playRawPcm(pcm).catch(() => {
      this.currentUri = null;
      this.playing = false;
      this.flush();
    });
  }

  private async playRawPcm(pcmBytes: Uint8Array): Promise<void> {
    if (pcmBytes.length === 0) return;
    const header = createWavHeader(pcmBytes.length);
    const wav = new Uint8Array(header.byteLength + pcmBytes.length);
    wav.set(new Uint8Array(header), 0);
    wav.set(pcmBytes, 44);

    let bin = '';
    for (let i = 0; i < wav.length; i++) bin += String.fromCharCode(wav[i]);
    const b64 = btoa(bin);

    const uri = `${FileSystem.cacheDirectory}ga-${Date.now()}.wav`;
    await FileSystem.writeAsStringAsync(uri, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    this.currentUri = uri;

    if (Platform.OS !== 'web') {
      await ensureSpeaker();
    }

    const player = createAudioPlayer(null, { updateInterval: 100 });
    this.player = player;
    player.volume = 1.0;

    const sub = player.addListener(PLAYBACK_STATUS_UPDATE, (status: AudioStatus) => {
      if (status.isLoaded && status.didJustFinish) {
        sub.remove();
        player.remove();
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        this.currentUri = null;
        this.player = null;
        this.flush();
      }
    });

    player.replace({ uri });
    player.play();
  }
}
