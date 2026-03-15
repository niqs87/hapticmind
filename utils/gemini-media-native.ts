/**
 * Natywny streamer audio dla Gemini Live API (@speechmatics/expo-two-way-audio)
 * Format wejściowy: PCM 16kHz, 16-bit, mono – idealny dla Gemini Live.
 * Prawdziwy streaming (bez zapisu na dysk), AEC (Acoustic Echo Cancelling).
 * iOS + Android.
 */
import {
  addExpoTwoWayAudioEventListener,
  initialize as initTwoWayAudio,
  toggleRecording,
} from '@speechmatics/expo-two-way-audio';
import { Platform } from 'react-native';

export const initializeTwoWayAudio = initTwoWayAudio;
export const initialize = initTwoWayAudio;

type SendAudioFn = (base64: string) => void;
export type OnLevelUpdateFn = (level: number) => void;
export type StreamerState = 'idle' | 'recording' | 'sending';

function pcmToBase64(pcm: Uint8Array): string {
  let s = '';
  for (let i = 0; i < pcm.length; i++) s += String.fromCharCode(pcm[i]);
  return btoa(s);
}

export class NativeAudioStreamer {
  private sendAudio: SendAudioFn;
  private onLevelUpdate?: OnLevelUpdateFn;
  private onStateChange?: (s: StreamerState) => void;
  private subscription: { remove: () => void } | null = null;
  private volumeSubscription: { remove: () => void } | null = null;
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
    if (Platform.OS === 'web') return;
    this.isStreaming = true;
    try {
      await initTwoWayAudio();
      this.onStateChange?.('recording');

      this.subscription = addExpoTwoWayAudioEventListener(
        'onMicrophoneData',
        (ev) => {
          if (!this.isStreaming) return;
          const d = ev.data;
          const base64 =
            typeof d === 'string'
              ? d
              : d && d.length > 0
                ? pcmToBase64(d)
                : '';
          if (base64) this.sendAudio(base64);
        },
      );

      this.volumeSubscription = addExpoTwoWayAudioEventListener(
        'onInputVolumeLevelData',
        (ev) => {
          this.onLevelUpdate?.(Math.max(0, Math.min(1, ev.data)));
        },
      );

      toggleRecording(true);
    } catch (err) {
      console.warn('[NativeAudioStreamer]', err);
      this.isStreaming = false;
      this.onStateChange?.('idle');
      throw err;
    }
  }

  stop(): void {
    this.isStreaming = false;
    toggleRecording(false);
    this.volumeSubscription?.remove();
    this.volumeSubscription = null;
    this.subscription?.remove();
    this.subscription = null;
    this.onLevelUpdate?.(0);
    this.onStateChange?.('idle');
  }

  pause(): void {
    toggleRecording(false);
    this.onLevelUpdate?.(0);
  }

  resume(): void {
    if (this.isStreaming) toggleRecording(true);
  }
}
