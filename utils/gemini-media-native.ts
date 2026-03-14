/**
 * Natywny streamer audio dla Gemini Live API (iOS)
 * Format wejściowy wymagany przez API: PCM 16kHz, 16-bit, mono, little-endian
 *
 * Mikrofon NIGDY nie jest wyłączany (nawet podczas playbacku) — Gemini VAD
 * automatycznie wykrywa mowę i obsługuje przerwania (interruptions).
 * @see https://ai.google.dev/gemini-api/docs/live-guide
 */
import { Audio } from 'expo-av';
import { Recording } from 'expo-av/build/Audio/Recording';
import type { RecordingOptions } from 'expo-av/build/Audio/Recording';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const SAMPLE_RATE = 16000;
const CHUNK_MS = 300;

function extractPcmFromCaf(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    if (bytes.length < 8 || String.fromCharCode(...bytes.slice(0, 4)) !== 'caff') return null;

    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
      offset += 4;
      const dv = new DataView(bytes.buffer, bytes.byteOffset);
      const chunkSize = Number(dv.getBigUint64(offset, false));
      offset += 8;

      if (type === 'data') {
        const dataStart = offset + 4; // skip 4-byte editCount
        const dataEnd = chunkSize > 0 && chunkSize < bytes.length
          ? Math.min(offset + Number(chunkSize), bytes.length)
          : bytes.length;
        if (dataEnd > dataStart) {
          return bytes.slice(dataStart, dataEnd);
        }
        return null;
      }
      if (chunkSize > 0) offset += Number(chunkSize);
      else break;
    }
    return null;
  } catch { return null; }
}

function pcmToBase64(pcm: Uint8Array): string {
  let s = '';
  for (let i = 0; i < pcm.length; i++) s += String.fromCharCode(pcm[i]);
  return btoa(s);
}

const IOS_RECORD_OPTIONS: RecordingOptions = {
  isMeteringEnabled: true,
  ios: {
    extension: '.caf',
    outputFormat: 'lpcm',
    audioQuality: 64,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    bitRate: SAMPLE_RATE * 16,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  android: {
    extension: '.3gp',
    outputFormat: 1,
    audioEncoder: 1,
    sampleRate: SAMPLE_RATE,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  web: {},
};

type SendAudioFn = (base64: string) => void;
export type OnLevelUpdateFn = (level: number) => void;
export type StreamerState = 'idle' | 'recording' | 'sending';

export class NativeAudioStreamer {
  private sendAudio: SendAudioFn;
  private onLevelUpdate?: OnLevelUpdateFn;
  private onStateChange?: (s: StreamerState) => void;
  private isStreaming = false;

  constructor(
    sendAudio: SendAudioFn,
    onLevelUpdate?: OnLevelUpdateFn,
    onStateChange?: (s: StreamerState) => void,
  ) {
    this.sendAudio = sendAudio;
    this.onLevelUpdate = onLevelUpdate;
    this.onStateChange = onStateChange;
  }

  async start(): Promise<void> {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) throw new Error('Brak dostępu do mikrofonu');

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false, // głośnik (jak telefon na stole)
    });

    this.isStreaming = true;
    if (Platform.OS === 'ios') this.runLoop();
  }

  stop(): void {
    this.isStreaming = false;
    this.onLevelUpdate?.(0);
    this.onStateChange?.('idle');
  }

  private async runLoop(): Promise<void> {
    while (this.isStreaming) {
      await this.recordAndSend();
    }
  }

  private async recordAndSend(): Promise<void> {
    const recording = new Recording();
    try {
      await recording.prepareToRecordAsync(IOS_RECORD_OPTIONS);
      await recording.startAsync();
      this.onStateChange?.('recording');

      const meteringId = setInterval(async () => {
        try {
          const s = await recording.getStatusAsync();
          if (s.isRecording && s.metering !== undefined) {
            const level = Math.max(0, Math.min(1, (s.metering + 40) / 40));
            this.onLevelUpdate?.(level);
          }
        } catch {}
      }, 100);

      await new Promise(r => setTimeout(r, CHUNK_MS));
      clearInterval(meteringId);

      if (!this.isStreaming) {
        await recording.stopAndUnloadAsync().catch(() => {});
        return;
      }

      this.onStateChange?.('sending');
      const uri = recording.getURI();
      await recording.stopAndUnloadAsync();
      if (!uri) return;

      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});

      const pcm = extractPcmFromCaf(base64);
      if (pcm && pcm.length > 0) {
        this.sendAudio(pcmToBase64(pcm));
      }
    } catch (err) {
      console.warn('[NativeAudioStreamer]', err);
      await new Promise(r => setTimeout(r, 100));
    }
  }
}
