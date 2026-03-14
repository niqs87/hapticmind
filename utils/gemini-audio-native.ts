/**
 * Odtwarzanie audio PCM z Gemini Live API na iOS/Android
 * Buforuje chunki do jednego pliku (jak w oficjalnym przykładzie z workletem).
 * API wysyła wiele małych chunków - odtwarzanie każdego osobno powodowało szatkowanie.
 */
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';

const SAMPLE_RATE = 24000;

function createWavHeader(dataLength: number): ArrayBuffer {
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = SAMPLE_RATE * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const chunkSize = 36 + dataLength;

  view.setUint32(0, 0x52494646, false); // "RIFF"
  view.setUint32(4, chunkSize, true);
  view.setUint32(8, 0x57415645, false); // "WAVE"
  view.setUint32(12, 0x666d7420, false); // "fmt "
  view.setUint32(16, 16, true); // subchunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  view.setUint32(36, 0x64617461, false); // "data"
  view.setUint32(40, dataLength, true);

  return header;
}

/** Tryb odtwarzania - głośnik zamiast słuchawki (iOS wymaga allowsRecordingIOS: false dla głośnika) */
async function setPlaybackMode() {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: false,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
}

/** Przywrócenie trybu nagrywania po odtworzeniu */
async function setRecordingMode() {
  await Audio.setAudioModeAsync({
    allowsRecordingIOS: true,
    playsInSilentModeIOS: true,
    staysActiveInBackground: false,
    shouldDuckAndroid: true,
    playThroughEarpieceAndroid: false,
  });
}

export type NativeAudioPlayerCallbacks = {
  onPlayStart?: () => void;
  onPlayEnd?: () => void;
};

function base64ToPcmBytes(base64Pcm: string): Uint8Array {
  const binary = atob(base64Pcm);
  const pcmBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) pcmBytes[i] = binary.charCodeAt(i);
  return pcmBytes;
}

async function playPcmBytes(pcmBytes: Uint8Array, callbacks?: NativeAudioPlayerCallbacks): Promise<void> {
  if (pcmBytes.length === 0) return;
  callbacks?.onPlayStart?.();
  await setPlaybackMode();

  const header = createWavHeader(pcmBytes.length);
  const wavBuffer = new Uint8Array(header.byteLength + pcmBytes.length);
  wavBuffer.set(new Uint8Array(header), 0);
  wavBuffer.set(pcmBytes, 44);

  let binaryStr = '';
  for (let i = 0; i < wavBuffer.length; i++) {
    binaryStr += String.fromCharCode(wavBuffer[i]);
  }
  const base64Wav = btoa(binaryStr);

  const uri = `${FileSystem.cacheDirectory}gemini-audio-${Date.now()}.wav`;
  await FileSystem.writeAsStringAsync(uri, base64Wav, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const { sound } = await Audio.Sound.createAsync(
    { uri },
    { shouldPlay: true }
  );
  sound.setOnPlaybackStatusUpdate((status) => {
    if (status.isLoaded && status.didJustFinish) {
      callbacks?.onPlayEnd?.();
      sound.unloadAsync();
      FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      setRecordingMode(); // Przywróć tryb nagrywania dla mikrofonu
    }
  });
}

/** Buforuje chunki i odtwarza je jako jeden plik po zakończeniu tury (seamless playback) */
export class NativeAudioPlayer {
  private buffer: Uint8Array[] = [];
  private callbacks?: NativeAudioPlayerCallbacks;

  constructor(callbacks?: NativeAudioPlayerCallbacks) {
    this.callbacks = callbacks;
  }

  addChunk(base64Pcm: string): void {
    this.buffer.push(base64ToPcmBytes(base64Pcm));
  }

  finishTurn(): void {
    if (this.buffer.length === 0) return;
    const totalLen = this.buffer.reduce((s, b) => s + b.length, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of this.buffer) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.buffer = [];
    playPcmBytes(merged, this.callbacks).catch(() => {
      this.callbacks?.onPlayEnd?.();
    });
  }

  interrupt(): void {
    this.buffer = [];
  }
}
