/**
 * Natywny streamer audio dla Gemini Live API - iOS/Android
 * Wysyła PCM 16kHz w trybie burst (nagrywanie → stop → odczyt → wyślij)
 * Na iOS: LINEARPCM .caf. Na Android: wymaga dekodera - tymczasowo tylko iOS.
 */
import { Audio } from 'expo-av';
import { Recording } from 'expo-av/build/Audio/Recording';
import type { RecordingOptions } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';

const TARGET_SAMPLE_RATE = 16000;
const BURST_MS = 350;

/** Ekstrakcja PCM z pliku CAF (iOS LINEARPCM) */
function extractPcmFromCaf(base64: string): Uint8Array | null {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    // CAF header: 'caff'(4) + version(2) + flags(2) = 8 bytes
    if (bytes.length < 8 || String.fromCharCode(...bytes.slice(0, 4)) !== 'caff') return null;

    let offset = 8; // poprawny offset po nagłówku CAF
    while (offset + 12 <= bytes.length) {
      const type = String.fromCharCode(...bytes.slice(offset, offset + 4));
      offset += 4;
      const chunkSize = Number(
        new DataView(bytes.buffer).getBigUint64(offset, false)
      );
      offset += 8;
      if (type === 'data' && chunkSize > 4 && offset + chunkSize <= bytes.length) {
        // data chunk: 4 bytes edit count, then raw PCM
        const pcmStart = offset + 4;
        const pcmLen = chunkSize - 4;
        return bytes.slice(pcmStart, pcmStart + pcmLen);
      }
      offset += Number(chunkSize);
    }
    return null;
  } catch {
    return null;
  }
}

function pcmToBase64(pcm: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < pcm.length; i++) binary += String.fromCharCode(pcm[i]);
  return btoa(binary);
}

// Wartości literalne - unikamy importów enumów z expo-av (nie są poprawnie re-eksportowane)
const IOS_PCM_OPTIONS: RecordingOptions = {
  isMeteringEnabled: true,
  android: {
    extension: '.3gp',
    outputFormat: 1, // AndroidOutputFormat.THREE_GPP
    audioEncoder: 1, // AndroidAudioEncoder.AMR_NB
    sampleRate: 16000,
    numberOfChannels: 1,
    bitRate: 128000,
  },
  ios: {
    extension: '.caf',
    outputFormat: 'lpcm', // IOSOutputFormat.LINEARPCM
    audioQuality: 64, // IOSAudioQuality.MEDIUM
    sampleRate: TARGET_SAMPLE_RATE,
    numberOfChannels: 1,
    bitRate: TARGET_SAMPLE_RATE * 16,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
};

type SendAudioFn = (base64: string) => void;
export type OnLevelUpdateFn = (level: number) => void;

export class NativeAudioStreamer {
  private sendAudio: SendAudioFn;
  private onLevelUpdate?: OnLevelUpdateFn;
  private shouldRecord?: () => boolean;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private isStreaming = false;
  private recording: Recording | null = null;
  private busy = false;

  constructor(
    sendAudio: SendAudioFn,
    onLevelUpdate?: OnLevelUpdateFn,
    shouldRecord?: () => boolean
  ) {
    this.sendAudio = sendAudio;
    this.onLevelUpdate = onLevelUpdate;
    this.shouldRecord = shouldRecord;
  }

  async start(): Promise<void> {
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) throw new Error('Brak dostępu do mikrofonu');

    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
    });

    this.isStreaming = true;
    if (Platform.OS === 'ios') {
      this.recordAndSend(); // od razu pierwsza próbka
      this.intervalId = setInterval(() => this.recordAndSend(), BURST_MS);
    }
  }

  stop(): void {
    this.isStreaming = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.recording = null;
  }

  private async recordAndSend(): Promise<void> {
    if (!this.isStreaming || this.busy) return;
    if (this.shouldRecord && !this.shouldRecord()) return; // podczas odtwarzania nie nagrywaj
    this.busy = true;

    try {
      // Zawsze ustaw tryb przed nagraniem (zapisuje przed ewentualnym setPlaybackMode z odtwarzacza)
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      // Krótka pauza, żeby iOS zdążył zastosować tryb (EXAV _allowsAudioRecording)
      await new Promise((r) => setTimeout(r, 50));
      if (this.shouldRecord && !this.shouldRecord()) {
        this.busy = false;
        return; // ponowne sprawdzenie po sleep
      }

      const recording = new Recording();
      this.recording = recording;

      await recording.prepareToRecordAsync(IOS_PCM_OPTIONS);
      await recording.startAsync();

      // Metering w trakcie nagrywania – aktualizuj poziom co ~100ms dla płynnej wizualizacji
      let meteringId: ReturnType<typeof setInterval> | null = setInterval(async () => {
        try {
          const s = await recording.getStatusAsync();
          if (s.isRecording && s.metering !== undefined && this.onLevelUpdate) {
            // szum tła iPhone ≈ -45 dBFS, mowa ≈ -20..-5 dBFS
            // mapujemy -40..0 dBFS → 0..1 (poniżej -40 = cisza)
            const level = Math.max(0, Math.min(1, (s.metering + 40) / 40));
            this.onLevelUpdate(level);
          }
        } catch { /* ignoruj – nagrywanie mogło się już skończyć */ }
      }, 100);

      await new Promise((r) => setTimeout(r, BURST_MS));

      if (meteringId) { clearInterval(meteringId); meteringId = null; }

      if (!this.isStreaming) {
        this.onLevelUpdate?.(0);
        await recording.stopAndUnloadAsync();
        return;
      }

      // getURI() musi być wywołane PRZED stopAndUnloadAsync – po unload może być null
      const uri = recording.getURI();
      await recording.stopAndUnloadAsync();
      this.recording = null;
      if (!uri) {
        console.warn('[NativeAudioStreamer] brak URI nagrania');
        return;
      }

      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});

      const pcm = extractPcmFromCaf(base64);
      if (pcm && pcm.length > 0) {
        // Aktualizuj poziom z PCM (dokładniejszy RMS niż metering)
        if (this.onLevelUpdate) {
          let sum = 0;
          for (let i = 0; i < pcm.length; i += 2) {
            const s = new DataView(pcm.buffer).getInt16(pcm.byteOffset + i, true);
            sum += s * s;
          }
          const rms = Math.sqrt(sum / (pcm.length / 2)) / 32768;
          this.onLevelUpdate(Math.min(1, rms * 3));
        }
        this.sendAudio(pcmToBase64(pcm));
      } else {
        console.warn('[NativeAudioStreamer] extractPcmFromCaf zwróciło null – sprawdź format nagrania');
      }
    } catch (err) {
      console.warn('[NativeAudioStreamer] recordAndSend:', err);
    } finally {
      this.busy = false;
    }
  }
}
