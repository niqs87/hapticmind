/** Stub na web - odtwarzanie przez WebAudioPlayer w komponencie */
export async function playPcmBase64(_base64Pcm: string): Promise<void> {
  return Promise.resolve();
}

/** Stub – na web używamy WebAudioPlayer */
export class NativeAudioPlayer {
  addChunk(_base64: string): void {}
  finishTurn(): void {}
  interrupt(): void {}
}

/** Stub - na web nieużywany */
export class NativeAudioPlayer {
  addChunk(_base64: string): void {}
  finishTurn(): Promise<void> {
    return Promise.resolve();
  }
  interrupt(): void {}
}
