/** Stub na web - używamy WebAudioStreamer. API zgodne z NativeAudioStreamer. */
export const GEMINI_RECORDING_OPTIONS = {} as Record<string, unknown>;

export class NativeAudioStreamer {
  constructor(
    _sendAudio?: (base64: string) => void,
    _onLevelUpdate?: (level: number) => void,
    _onStateChange?: (s: string) => void,
  ) {}
  start(): void {}
  stop(): void {}
  pause(): void {}
  resume(): void {}
}
