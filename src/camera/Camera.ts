import { ok, err, type Result } from '../util/result'

export type CameraError = 'insecure-context' | 'unavailable' | 'denied' | 'no-camera'

export interface Capture {
  /** The full captured video frame. */
  canvas: HTMLCanvasElement
  /** performance.now() at the moment the frame was grabbed. */
  perfTimestamp: number
  width: number
  height: number
}

/** Wraps getUserMedia for a live rear-camera preview and single-frame capture. */
export class Camera {
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null

  get active(): boolean {
    return this.stream !== null
  }

  async start(video: HTMLVideoElement): Promise<Result<{ width: number; height: number }, CameraError>> {
    if (!window.isSecureContext) return err('insecure-context')
    if (!navigator.mediaDevices?.getUserMedia) return err('unavailable')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: 'environment' },
          // Ask for as much resolution as the device will give — a watch held at
          // the camera's focusing distance is small in frame, so detail matters.
          width: { ideal: 3840 },
          height: { ideal: 2160 },
        },
        audio: false,
      })
      this.stream = stream
      this.video = video
      video.srcObject = stream
      video.setAttribute('playsinline', '') // iOS: keep the preview inline, no fullscreen
      video.muted = true
      await video.play()
      return ok({ width: video.videoWidth, height: video.videoHeight })
    } catch (e) {
      const name = (e as DOMException)?.name
      if (name === 'NotAllowedError' || name === 'SecurityError') return err('denied')
      if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'NotReadableError')
        return err('no-camera')
      return err('unavailable')
    }
  }

  /** Grab the current frame. Timestamp is taken right before the draw. */
  capture(): Capture {
    const video = this.video
    if (!video) throw new Error('Camera.capture before start')
    const width = video.videoWidth
    const height = video.videoHeight
    const perfTimestamp = performance.now()
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(video, 0, 0, width, height)
    return { canvas, perfTimestamp, width, height }
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    if (this.video) {
      this.video.srcObject = null
      this.video = null
    }
  }
}
