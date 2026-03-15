/**
 * Odtwarzanie audio PCM z Gemini Live API przez expo-two-way-audio.
 * Wyjście API: PCM 24kHz, 16-bit, mono, little-endian
 * expo-two-way-audio playPCMData: PCM 16kHz, 16-bit, mono
 *
 * Kluczowe: CAŁY audio flow (mic + playback) przechodzi przez expo-two-way-audio,
 * więc nie ma konfliktu AVAudioSession z expo-audio.
 */
import {
  initialize,
  playPCMData,
  tearDown,
  toggleRecording,
} from '@speechmatics/expo-two-way-audio';
import { Platform } from 'react-native';

function decode(base64: string): Uint8Array {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Resample PCM 16-bit mono z 24kHz do 16kHz (ratio 3:2).
 * Liniowa interpolacja – wystarczająca jakość dla mowy.
 */
function resample24to16(pcm24: Uint8Array): Uint8Array {
  const samples24 = pcm24.length / 2;
  const samples16 = Math.floor(samples24 * 2 / 3);
  const out = new Uint8Array(samples16 * 2);
  const view24 = new DataView(pcm24.buffer, pcm24.byteOffset, pcm24.byteLength);
  const viewOut = new DataView(out.buffer);

  for (let i = 0; i < samples16; i++) {
    const srcPos = i * 1.5;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;

    const s0 = idx < samples24 ? view24.getInt16(idx * 2, true) : 0;
    const s1 = idx + 1 < samples24 ? view24.getInt16((idx + 1) * 2, true) : s0;
    const interpolated = Math.round(s0 + frac * (s1 - s0));
    viewOut.setInt16(i * 2, Math.max(-32768, Math.min(32767, interpolated)), true);
  }

  return out;
}

export class NativeAudioPlayer {
  private interrupted = false;

  addChunk(base64Pcm: string): void {
    if (this.interrupted || Platform.OS === 'web') return;
    const pcm24 = decode(base64Pcm);
    if (pcm24.length === 0) return;
    const pcm16 = resample24to16(pcm24);
    try {
      playPCMData(pcm16);
    } catch (err) {
      if (__DEV__) console.warn('[NativeAudioPlayer] playPCMData error:', err);
    }
  }

  /**
   * Natychmiast zatrzymaj odtwarzanie.
   * tearDown() → speechPlayer.stop() + avAudioEngine.stop() (jedyny sposób na uciszenie natywnego playera).
   * Potem initialize() + toggleRecording(true) przywraca mikrofon.
   */
  async interrupt(): Promise<void> {
    this.interrupted = true;
    if (Platform.OS !== 'web') {
      try {
        tearDown();
        await initialize();
        toggleRecording(true);
      } catch {}
    }
    setTimeout(() => { this.interrupted = false; }, 200);
  }
}
