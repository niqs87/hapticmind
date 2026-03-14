/** Stub na web - używamy WebAudioStreamer */
export class NativeAudioStreamer {
  async start(_onAudio: (base64: string) => void): Promise<void> {
    return Promise.resolve();
  }
  stop(): void {}
}
