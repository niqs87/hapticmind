/**
 * Odtwarzanie audio PCM z Gemini Live API
 * Wyjście API: PCM 24kHz, 16-bit, mono, little-endian
 *
 * Głośnik + mikrofon: plugin withExpoAvSpeaker dodaje DefaultToSpeaker do expo-av,
 * więc audio idzie przez głośnik, mikrofon działa cały czas, przerwania głosowe działają.
 */
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';

const SAMPLE_RATE = 24000;
const INITIAL_BUFFER_MS = 200;

function createWavHeader(dataLength: number): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  v.setUint32(0, 0x52494646, false);            // "RIFF"
  v.setUint32(4, 36 + dataLength, true);
  v.setUint32(8, 0x57415645, false);            // "WAVE"
  v.setUint32(12, 0x666d7420, false);           // "fmt "
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);                     // PCM
  v.setUint16(22, 1, true);                     // mono
  v.setUint32(24, SAMPLE_RATE, true);
  v.setUint32(28, SAMPLE_RATE * 2, true);       // byteRate
  v.setUint16(32, 2, true);                     // blockAlign
  v.setUint16(34, 16, true);                    // bitsPerSample
  v.setUint32(36, 0x64617461, false);           // "data"
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
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

type SoundRef = { sound: import('expo-av').Audio.Sound; uri: string };

async function playRawPcm(
  pcmBytes: Uint8Array,
  onSoundCreated?: (ref: SoundRef) => void,
): Promise<void> {
  if (pcmBytes.length === 0) return;
  const header = createWavHeader(pcmBytes.length);
  const wav = new Uint8Array(header.byteLength + pcmBytes.length);
  wav.set(new Uint8Array(header), 0);
  wav.set(pcmBytes, 44);

  let bin = '';
  for (let i = 0; i < wav.length; i++) bin += String.fromCharCode(wav[i]);
  const b64 = btoa(bin);

  const uri = `${FileSystem.cacheDirectory}ga-${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(uri, b64, { encoding: FileSystem.EncodingType.Base64 });

  return new Promise((resolve, reject) => {
    Audio.Sound.createAsync({ uri }, { shouldPlay: true, volume: 1.0 })
      .then(({ sound }) => {
        onSoundCreated?.({ sound, uri });
        sound.setOnPlaybackStatusUpdate((status) => {
          if (status.isLoaded && status.didJustFinish) {
            sound.unloadAsync();
            FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
            resolve();
          }
        });
      })
      .catch(reject);
  });
}

export type NativeAudioPlayerCallbacks = {
  onPlayStart?: () => void;
  onPlayEnd?: () => void;
};

export class NativeAudioPlayer {
  private callbacks?: NativeAudioPlayerCallbacks;
  private queue: Uint8Array[] = [];
  private playing = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentSound: { sound: import('expo-av').Audio.Sound; uri: string } | null = null;

  constructor(callbacks?: NativeAudioPlayerCallbacks) {
    this.callbacks = callbacks;
  }

  addChunk(base64Pcm: string): void {
    this.queue.push(decode(base64Pcm));
    if (!this.playing && !this.timer) {
      this.timer = setTimeout(() => this.flush(), INITIAL_BUFFER_MS);
    }
  }

  finishTurn(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.flush();
  }

  /** Natychmiast zatrzymaj odtwarzanie, wyczyść kolejkę. Mikrofon i tak cały czas nagrywa i wysyła do API. */
  interrupt(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.queue = [];
    if (this.currentSound) {
      this.currentSound.sound.stopAsync().catch(() => {});
      this.currentSound.sound.unloadAsync().catch(() => {});
      FileSystem.deleteAsync(this.currentSound.uri, { idempotent: true }).catch(() => {});
      this.currentSound = null;
    }
    if (this.playing) {
      this.playing = false;
      this.callbacks?.onPlayEnd?.();
    }
  }

  private flush(): void {
    this.timer = null;
    if (this.queue.length === 0) {
      if (this.playing) {
        this.playing = false;
        this.callbacks?.onPlayEnd?.();
      }
      return;
    }

    if (!this.playing) {
      this.playing = true;
      this.callbacks?.onPlayStart?.();
    }

    const pcm = merge(this.queue.splice(0));
    playRawPcm(pcm, (ref) => { this.currentSound = ref; })
      .then(() => {
        this.currentSound = null;
        this.flush();
      })
      .catch(() => {
        this.currentSound = null;
        this.playing = false;
        this.callbacks?.onPlayEnd?.();
      });
  }
}
