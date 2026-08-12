/**
 * Capturing a trámite from the person's own tab.
 *
 * ---------------------------------------------------------------------------
 * ONE TAB, NEVER THE SCREEN
 * ---------------------------------------------------------------------------
 * `displaySurface: 'browser'` puts the browser's own picker on the Tab list
 * first. That is the narrowest thing the platform offers and it is what this
 * asks for, because the alternatives are genuinely worse: a whole screen
 * captures the notification that slides in from a different client, the window
 * behind, the messaging app. A tab captures the tab.
 *
 * The picker can still be overridden by the person -- browsers do not let a
 * page force the choice -- so `stopIfNotATab` below refuses anything that is
 * not a tab and says why, rather than quietly recording a desktop.
 * `selfBrowserSurface: 'exclude'` also removes Cortex's own tab from the list,
 * so a mis-click cannot record the screen they are recording from.
 *
 * ---------------------------------------------------------------------------
 * FRAMES, NOT VIDEO
 * ---------------------------------------------------------------------------
 * Nothing here creates a video file. There is no MediaRecorder, no Blob and no
 * upload of a stream: the capture is sampled into a canvas, and only the frames
 * where the page VISIBLY CHANGED are kept -- typically twelve to twenty for a
 * whole errand. Those go up in one request, get read by the model, and are gone
 * when it returns.
 *
 * Sampling on change rather than on a clock is what makes that possible. A
 * three-minute recording at even one frame a second is 180 images; the same
 * errand has perhaps fifteen moments where anything happened, and those fifteen
 * are the ones that describe it.
 *
 * ---------------------------------------------------------------------------
 * PAUSE IS A PRIVACY CONTROL, NOT A CONVENIENCE
 * ---------------------------------------------------------------------------
 * `pause()` stops sampling entirely. It is on screen as a large button the
 * whole time a recording is running, because somebody is going to need to open
 * another customer's record mid-errand, and the honest answer to that is a
 * button rather than a promise about what we do with the pixels afterwards.
 * A password field renders as dots and is therefore already invisible to the
 * camera, but a revealed password or a password manager overlay is not -- see
 * `enforceSecrets` in agent-tools for what happens if one gets through anyway.
 */

export interface CapturedFrame {
  base64: string;
  mimeType: string;
  atMs: number;
  /** How much of the picture changed since the previous kept frame, 0..1. */
  change: number;
}

export interface RecorderHandle {
  pause(): void;
  resume(): void;
  stop(): Promise<CapturedFrame[]>;
  readonly paused: boolean;
  readonly frameCount: number;
}

export interface RecorderOptions {
  maxFrames: number;
  onTick(state: { seconds: number; frames: number; paused: boolean }): void;
  /** Called when the person stops sharing from the browser's own bar. */
  onEnded(): void;
}

/** How different two frames must be, on a 0..1 scale, to be worth keeping. */
const CHANGE_THRESHOLD = 0.012;
const SAMPLE_MS = 400;
/** Long edge of a kept frame. Enough to read a form label, small enough to send. */
const MAX_EDGE = 1280;
/** The thumbnail the difference is computed on. Cheap and noise-tolerant. */
const DIFF_W = 64;
const DIFF_H = 36;

export class NotATabError extends Error {
  constructor() {
    super(
      'Compartiste una ventana o la pantalla completa. Para enseñar un trámite hay que compartir SOLO la pestaña del portal: así no se graba nada de lo que tengas detrás.',
    );
    this.name = 'NotATabError';
  }
}

export async function startTabRecording(options: RecorderOptions): Promise<RecorderHandle> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      // Not honoured everywhere, and that is fine -- it is a preference for the
      // picker, and the check below is the enforcement.
      displaySurface: 'browser',
      frameRate: 8,
      /**
       * THE POINTER HAS TO BE IN THE PICTURE.
       *
       * Frames are kept where the page CHANGED, which means the model sees the
       * effect of a click and never the click. Two fields that both go from
       * empty to filled are indistinguishable afterwards; a pointer resting on
       * one of them in the frame before is unambiguous. Same for a button among
       * six on a toolbar.
       *
       * `cursor` is not in TypeScript's `MediaTrackConstraints` (it is a Screen
       * Capture extension), which is why this object is cast below. Browsers
       * that do not implement it ignore an unknown key rather than rejecting
       * the call, so asking costs nothing where it is not supported.
       */
      cursor: 'always',
    },
    audio: false,
    // Nothing about a trámite is audible, and a microphone permission on a
    // page that does not need one is a permission nobody should grant.
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'exclude',
    systemAudio: 'exclude',
    preferCurrentTab: false,
  } as DisplayMediaStreamOptions);

  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('El navegador no entregó ningún video.');

  const surface = (track.getSettings() as { displaySurface?: string }).displaySurface;
  if (surface && surface !== 'browser') {
    for (const t of stream.getTracks()) t.stop();
    throw new NotATabError();
  }

  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();

  const full = document.createElement('canvas');
  const fullCtx = full.getContext('2d');
  const thumb = document.createElement('canvas');
  thumb.width = DIFF_W;
  thumb.height = DIFF_H;
  const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });

  const frames: CapturedFrame[] = [];
  const startedAt = Date.now();
  let previous: Uint8ClampedArray | null = null;
  let paused = false;
  let stopped = false;

  function grab(change: number): void {
    if (!fullCtx) return;
    const width = video.videoWidth || 1280;
    const height = video.videoHeight || 720;
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    full.width = Math.round(width * scale);
    full.height = Math.round(height * scale);
    fullCtx.drawImage(video, 0, 0, full.width, full.height);
    // JPEG at 0.6: a portal is text on white, which compresses well, and the
    // model is reading words rather than admiring the rendering.
    const url = full.toDataURL('image/jpeg', 0.6);
    frames.push({
      base64: url.slice(url.indexOf(',') + 1),
      mimeType: 'image/jpeg',
      atMs: Date.now() - startedAt,
      change,
    });

    // At the cap, drop the least eventful frame that is neither the first nor
    // the last. Trimming the tail instead would throw away the end of the
    // errand, which is the half that says what it produced.
    if (frames.length > options.maxFrames) {
      let dullest = 1;
      for (let i = 2; i < frames.length - 1; i++) {
        if ((frames[i]?.change ?? 1) < (frames[dullest]?.change ?? 1)) dullest = i;
      }
      frames.splice(dullest, 1);
    }
  }

  function sample(): void {
    if (stopped || paused || !thumbCtx) return;
    thumbCtx.drawImage(video, 0, 0, DIFF_W, DIFF_H);
    const current = thumbCtx.getImageData(0, 0, DIFF_W, DIFF_H).data;
    if (!previous) {
      previous = new Uint8ClampedArray(current);
      grab(1);
      return;
    }
    let sum = 0;
    for (let i = 0; i < current.length; i += 4) {
      sum += Math.abs((current[i] ?? 0) - (previous[i] ?? 0));
    }
    const change = sum / (DIFF_W * DIFF_H * 255);
    if (change > CHANGE_THRESHOLD) {
      previous = new Uint8ClampedArray(current);
      grab(change);
    }
  }

  const sampler = window.setInterval(sample, SAMPLE_MS);
  const ticker = window.setInterval(
    () =>
      options.onTick({
        seconds: Math.round((Date.now() - startedAt) / 1000),
        frames: frames.length,
        paused,
      }),
    1000,
  );

  // The person can stop sharing from the browser's own bar; the page has to
  // notice, or the recorder sits there sampling a dead track.
  track.addEventListener('ended', () => {
    if (!stopped) options.onEnded();
  });

  async function stop(): Promise<CapturedFrame[]> {
    if (!stopped) {
      stopped = true;
      // One last frame: the result page is the whole reason the errand was run,
      // and a change-triggered sampler can easily miss the settled version of it.
      if (!paused) {
        try {
          grab(1);
        } catch {
          /* the track may already be gone; the frames we have are enough */
        }
      }
      window.clearInterval(sampler);
      window.clearInterval(ticker);
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
    }
    return frames;
  }

  return {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    stop,
    get paused() {
      return paused;
    },
    get frameCount() {
      return frames.length;
    },
  };
}

/** Whether this browser can share a tab at all. Safari cannot, today. */
export function canRecordTab(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function'
  );
}
