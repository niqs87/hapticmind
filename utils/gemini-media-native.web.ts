/** Stub na web - używamy WebAudioStreamer. API zgodne z NativeAudioStreamer. */
export const GEMINI_RECORDING_OPTIONS = {} as import('expo-audio').RecordingOptions;

export class NativeAudioStreamer {
  constructor(
    _recorder?: unknown,
    _sendAudio?: (base64: string) => void,
  ) {}
  start(): void {}
  stop(): void {}
}
