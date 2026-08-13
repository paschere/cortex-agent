/**
 * Capturing a person's own tab — for the two things Cortex does with one.
 *
 * ---------------------------------------------------------------------------
 * TWO CONSUMERS, ONE PERMISSION AND ONE PROMISE
 * ---------------------------------------------------------------------------
 * `startTabRecording` samples a tab over minutes to learn a trámite.
 * `startTabView` holds a tab open and takes ONE frame each time somebody asks a
 * question about what they are looking at. They are different features and are
 * deliberately not mixed: one produces a procedure, the other produces an
 * answer, and neither can be reached from the other's screen.
 *
 * What they share is the only part that must never diverge: which surface the
 * browser is asked for, the refusal when it is not a tab, and the size a frame
 * is drawn at. Both go through `acquireTabStream` below. If the privacy
 * contract ever changes — a different `displaySurface`, a laxer check, a bigger
 * frame — it changes in one function, for both, or not at all.
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

import { WATCH_THUMB_H, WATCH_THUMB_W } from './screen-watch';

export interface CapturedFrame {
  base64: string;
  mimeType: string;
  atMs: number;
  /** How much of the picture changed since the previous kept frame, 0..1. */
  change: number;
  /**
   * Set only when `pairs` is on. `antes` is the tab as it was an instant before
   * a big change -- with the pointer still resting on whatever caused it.
   */
  phase?: 'antes' | 'despues';
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
  /**
   * Keep the frame from JUST BEFORE a big change as well as the one after it.
   *
   * ---------------------------------------------------------------------------
   * WHY IT MIGHT BE WORTH IT, AND WHY IT IS OFF
   * ---------------------------------------------------------------------------
   * A frame sampled after a change shows the RESULT. On a navigation, the thing
   * that was pressed to cause it is not in that picture -- it is on the page
   * that just went away -- so the extractor has to infer the click from the
   * destination. The frame before, with the pointer on the link, says it
   * outright. Same for a menu that opens and closes: the "after" is the page
   * with the menu gone.
   *
   * The catch is that the cap is on IMAGES, not on moments. Twenty frames spent
   * in pairs cover ten moments instead of twenty, and an errand whose middle
   * went unphotographed is a worse recording however well-explained its
   * beginning is. Which way that trades is a question about a model's reading,
   * and the only honest answer is a measurement:
   *
   *     pnpm browser:cases                 (sueltos)
   *     pnpm browser:cases -- --pairs      (pareja, same image budget)
   *
   * That measurement has not been run -- see docs/operations/browser.md § 5 --
   * so this ships able to do it and not doing it. Turning it on is one argument
   * at the call site, and it should be turned on by the number and not by the
   * argument above.
   */
  pairs?: boolean;
}

/** How different two frames must be, on a 0..1 scale, to be worth keeping. */
const CHANGE_THRESHOLD = 0.012;
/**
 * A change this large is a navigation or a full-page redraw: the page that
 * caused it is gone, and the frame before is the only evidence of what was on
 * it. Below this, the page is still there and the "after" frame shows it.
 */
const BIG_CHANGE = 0.18;
const SAMPLE_MS = 400;
/** Long edge of a kept frame. Enough to read a form label, small enough to send. */
const MAX_EDGE = 1280;
/** The thumbnail the difference is computed on. Cheap and noise-tolerant. */
const DIFF_W = 64;
const DIFF_H = 36;

export class NotATabError extends Error {
  /**
   * The default is the trámite wording, unchanged. The viewing surface passes
   * its own because "no se graba" is not the promise it makes — nothing there
   * is ever recorded — and a sentence that describes the wrong feature is worse
   * than a generic one.
   */
  constructor(
    message = 'Compartiste una ventana o la pantalla completa. Para enseñar un trámite hay que compartir SOLO la pestaña del portal: así no se graba nada de lo que tengas detrás.',
  ) {
    super(message);
    this.name = 'NotATabError';
  }
}

/**
 * Ask the browser for ONE TAB, and refuse anything else.
 *
 * The single place the constraints and the surface check live. Read the note at
 * the top of this file for why every claim in it is here rather than duplicated
 * per caller.
 */
async function acquireTabStream(notATabMessage?: string): Promise<MediaStream> {
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
    throw new NotATabError(notATabMessage);
  }

  return stream;
}

/** The size a frame is drawn at, from the live track. Shared by both callers. */
function frameSizeOf(video: HTMLVideoElement): { width: number; height: number } {
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** A `<video>` already playing the shared tab, ready to be drawn from. */
async function playIntoVideo(stream: MediaStream): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  await video.play();
  return video;
}

export async function startTabRecording(options: RecorderOptions): Promise<RecorderHandle> {
  const stream = await acquireTabStream();
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('El navegador no entregó ningún video.');

  const video = await playIntoVideo(stream);

  const full = document.createElement('canvas');
  const fullCtx = full.getContext('2d');
  // The previous tick's picture, held as pixels rather than as a JPEG: drawing
  // into a canvas every 400ms is cheap, encoding one is not, and this is only
  // ever encoded on the ticks where it turns out to have been worth keeping.
  const held = document.createElement('canvas');
  const heldCtx = held.getContext('2d');
  let heldAtMs = 0;
  const thumb = document.createElement('canvas');
  thumb.width = DIFF_W;
  thumb.height = DIFF_H;
  const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });

  const frames: CapturedFrame[] = [];
  const startedAt = Date.now();
  let previous: Uint8ClampedArray | null = null;
  let paused = false;
  let stopped = false;

  /** The size a kept frame is drawn at. Same for the live one and the held one. */
  const frameSize = () => frameSizeOf(video);

  /** Keep the tab as it is right now, so it can be emitted later if it matters. */
  function hold(): void {
    if (!heldCtx || !options.pairs) return;
    const size = frameSize();
    held.width = size.width;
    held.height = size.height;
    heldCtx.drawImage(video, 0, 0, held.width, held.height);
    heldAtMs = Date.now() - startedAt;
  }

  function push(
    canvas: HTMLCanvasElement,
    atMs: number,
    change: number,
    phase?: 'antes' | 'despues',
  ) {
    // JPEG at 0.6: a portal is text on white, which compresses well, and the
    // model is reading words rather than admiring the rendering.
    const url = canvas.toDataURL('image/jpeg', 0.6);
    frames.push({
      base64: url.slice(url.indexOf(',') + 1),
      mimeType: 'image/jpeg',
      atMs,
      change,
      ...(options.pairs ? { phase: phase ?? 'despues' } : {}),
    });
  }

  function grab(change: number): void {
    if (!fullCtx) return;
    // A big change means the page that caused it is gone. Emit the one we were
    // holding first, so the pair reads antes → después in order.
    if (options.pairs && change >= BIG_CHANGE && held.width > 0) {
      push(held, heldAtMs, change, 'antes');
    }
    const size = frameSize();
    full.width = size.width;
    full.height = size.height;
    fullCtx.drawImage(video, 0, 0, full.width, full.height);
    push(full, Date.now() - startedAt, change, 'despues');

    // At the cap, drop the least eventful frame that is neither the first nor
    // the last. Trimming the tail instead would throw away the end of the
    // errand, which is the half that says what it produced.
    //
    // With pairs on, an `antes` frame goes first when its `despues` is equally
    // dull: losing the explanation of a moment costs less than losing the
    // moment, because the moment is a STEP and the explanation is only how that
    // step is worded.
    while (frames.length > options.maxFrames) {
      let dullest = 1;
      for (let i = 2; i < frames.length - 1; i++) {
        const change = frames[i]?.change ?? 1;
        const best = frames[dullest]?.change ?? 1;
        const givesUpLess = frames[i]?.phase === 'antes' && frames[dullest]?.phase !== 'antes';
        if (change < best || (change === best && givesUpLess)) dullest = i;
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
    // Whatever happened, this tick becomes the "before" that the next one may
    // turn out to need.
    hold();
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

// ===========================================================================
// WATCHING A TAB: one frame, taken when somebody asks
// ===========================================================================
/**
 * A shared tab that Cortex can look at, and only when it is spoken to.
 *
 * ---------------------------------------------------------------------------
 * NOTHING LEAVES THIS PAGE THAT NOBODY ASKED FOR. THAT IS THE WHOLE DESIGN.
 * ---------------------------------------------------------------------------
 * There is no interval here, no frame list and no upload of anything this file
 * decided by itself. The stream stays open so the person does not have to
 * re-authorise the tab for every question, and a BILLABLE frame is produced
 * exactly once per `grab()` — which the composer calls at the instant a question
 * is sent, and at no other instant.
 *
 * Streaming frames continuously would be the obvious build and it is the wrong
 * one twice over. It bills for every frame whether or not anybody asked
 * anything, and it means a piece of software is reading somebody's screen for
 * as long as the session is open, which is not what was agreed to and cannot be
 * made true again by a retention policy. The cost of an idle share is zero, and
 * that number is what makes "leave it on all afternoon" an honest suggestion.
 *
 * ONE THING IS SAMPLED, AND IT NEVER LEAVES THE BROWSER. `thumbnail()` exists
 * for the continuous mode — "mira y avísame" — which calls it every two seconds
 * to work out whether the picture changed at all. That is 1 296 pixels compared
 * against 1 296 pixels inside this tab: no network, no model, no cost. It is
 * precisely what makes continuous watching affordable, because the expensive
 * `grab()` still only runs on the handful of moments where something actually
 * happened. The sentence above survives intact: the cost of a share where
 * nothing changes is still zero, whichever mode it is in.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FRAME IS TAKEN AT SEND AND NOT WHEN THE COMPOSER IS FOCUSED
 * ---------------------------------------------------------------------------
 * People look at the thing, then come to Cortex and type. By the time they
 * press enter the shared tab is in the background — and a background tab keeps
 * the last picture it painted, which is precisely the picture they were looking
 * at when they decided to ask. Grabbing at send therefore captures the subject
 * of the question, not the room they walked into afterwards. Grabbing on focus
 * would take the same picture at a moment when the question does not exist yet,
 * which is a frame bought before anybody knows whether it is needed.
 *
 * `grab()` is deliberately SYNCHRONOUS so the composer can call it inside the
 * body it is about to post. An async grab would open a gap between the question
 * and the picture — small, but exactly long enough for a page to redraw.
 *
 * ---------------------------------------------------------------------------
 * QUALITY IS FREE, RESOLUTION IS NOT, AND HERE IS THE (ESTIMATED) BILL
 * ---------------------------------------------------------------------------
 * ESTIMATED, NOT MEASURED. Every figure below is arithmetic on Anthropic's
 * published image formula and on this repo's own prices and prompt sizes; not
 * one of them came from a live call, because none was made. See the note on
 * `glanceTokens` in lib/screen-glance.ts for what would confirm them.
 *
 * An image costs `width × height / 750` input tokens and nothing else — not the
 * bytes, not the JPEG quality, not what is on the screen. So the two knobs are
 * not equivalent at all:
 *
 *   QUALITY is free. The recording path encodes at 0.6 because it sends twenty
 *   frames and cares about upload size. One frame can afford 0.85, and the
 *   crispness is spent exactly where this feature lives or dies: 11px labels on
 *   a government portal. It costs upload bandwidth and not one cent of model.
 *
 *   RESOLUTION is the bill. A tab on an ordinary laptop arrives here as
 *   1280×720 after `MAX_EDGE`: 1 229 tokens, US$0,0037 at the US$3/Mtok this
 *   repo prices Sonnet 5 at (browser/cost.ts). Set against a turn measured from
 *   this repo — the tool schemas really offered plus the agent prompt, ≈12 000
 *   input tokens, of which the ≈9 200-token head is cached — a question with a
 *   picture costs roughly 18 % more than the same question without one:
 *   ≈US$0,0237 against ≈US$0,0200. Ten thousand screen questions in a month is
 *   about US$37 of image.
 *
 * WHICH IS WHY NOTHING IS SAMPLED. The same arithmetic run against the obvious
 * design is the argument for this one: streaming even one frame a second would
 * be 1 229 tokens EVERY SECOND — on the order of US$13 an hour per person, for
 * frames nobody asked a question about. One frame per question is not the
 * elegant choice, it is the only affordable one, and it happens to also be the
 * only one that can honestly say Cortex is not watching.
 *
 * Dropping the long edge to 1024 would save 443 tokens, US$0,0012 a question,
 * US$12 per ten thousand — and cost 20 % of the linear resolution of the small
 * print this exists to read. Not a trade worth making: what it buys is a
 * confident answer about a misread number. `MAX_EDGE` therefore stays where the
 * recorder put it, and the figure to watch instead is the prompt cache hit
 * rate, which moves a turn's cost by several times what the picture does.
 */
export interface ScreenGlance {
  base64: string;
  mimeType: string;
  /** Of the frame as sent. The model's price is a function of these two. */
  width: number;
  height: number;
  /** When the picture was taken, ISO 8601. Shown in the transcript. */
  takenAt: string;
}

export interface TabViewHandle {
  /** One frame of the shared tab, right now. Null once the share has ended. */
  grab(): ScreenGlance | null;
  /**
   * The shared tab reduced to a 48×27 thumbnail, as raw RGBA. Null once the
   * share has ended.
   *
   * ---------------------------------------------------------------------------
   * THE CHEAP HALF OF WATCHING, AND WHY IT IS A SEPARATE METHOD
   * ---------------------------------------------------------------------------
   * `grab()` produces something that costs money to look at: a full-size JPEG
   * that becomes `width × height / 750` input tokens the moment it is sent.
   * This produces something that costs a few microseconds of CPU and nothing
   * else, and it is what the continuous mode calls every two seconds. Comparing
   * two of these is how Cortex decides the screen changed WITHOUT a model — see
   * `frameChange` in lib/screen-watch.ts, where the arithmetic and the threshold
   * live and are tested.
   *
   * The two are deliberately not fused into one "grab if changed" method. The
   * decision has three more inputs than the picture — how long since the last
   * look, whether a turn is in flight, how much of the session's budget is left
   * — and every one of them is a rule about money that should be readable and
   * testable in Node, not buried in a canvas call.
   *
   * `willReadFrequently` matters here and nowhere else in this file: this is the
   * one canvas that is read back on a two-second interval for as long as somebody
   * leaves the feature on, and without the hint a browser keeps it on the GPU
   * and pays a stall to fetch it every time.
   */
  thumbnail(): Uint8ClampedArray | null;
  stop(): void;
  /** How many times this session has been looked at. Shown on screen. */
  readonly glances: number;
}

/** JPEG quality for a single glance. See the note above — this is not billed. */
const GLANCE_QUALITY = 0.85;

export async function startTabView(options: { onEnded(): void }): Promise<TabViewHandle> {
  const stream = await acquireTabStream(
    'Compartiste una ventana o la pantalla completa. Para que Cortex mire lo que estás viendo hay que compartir SOLO una pestaña: así no entra nada de lo que tengas detrás.',
  );
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error('El navegador no entregó ningún video.');

  const video = await playIntoVideo(stream);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  // The thumbnail the change check runs on. Allocated once, at a fixed size,
  // and reused for the whole session: the continuous mode draws into it every
  // two seconds and a per-tick allocation would be garbage by the minute.
  const thumb = document.createElement('canvas');
  thumb.width = WATCH_THUMB_W;
  thumb.height = WATCH_THUMB_H;
  const thumbCtx = thumb.getContext('2d', { willReadFrequently: true });

  let stopped = false;
  let glances = 0;

  // Stopping from the browser's own bar is the gesture most people will reach
  // for, and it has to be the same event as pressing the button in Cortex —
  // otherwise the strip keeps claiming a share that ended minutes ago, which is
  // the one lie this feature must never tell.
  track.addEventListener('ended', () => {
    if (!stopped) {
      stopped = true;
      options.onEnded();
    }
  });

  return {
    grab() {
      if (stopped || !ctx) return null;
      const size = frameSizeOf(video);
      if (size.width === 0 || size.height === 0) return null;
      canvas.width = size.width;
      canvas.height = size.height;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL('image/jpeg', GLANCE_QUALITY);
      glances++;
      return {
        base64: url.slice(url.indexOf(',') + 1),
        mimeType: 'image/jpeg',
        width: canvas.width,
        height: canvas.height,
        takenAt: new Date().toISOString(),
      };
    },
    thumbnail() {
      if (stopped || !thumbCtx) return null;
      // `videoWidth` directly, and not `frameSizeOf`, which substitutes 1280×720
      // when the track has not produced a frame yet. Drawing from a video with
      // no picture is a silent no-op, so the guard has to be the raw dimension:
      // otherwise the first real frame would read as a change against whatever
      // the canvas happened to contain.
      if (video.videoWidth === 0 || video.videoHeight === 0) return null;
      thumbCtx.drawImage(video, 0, 0, WATCH_THUMB_W, WATCH_THUMB_H);
      return thumbCtx.getImageData(0, 0, WATCH_THUMB_W, WATCH_THUMB_H).data;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      for (const t of stream.getTracks()) t.stop();
      video.srcObject = null;
      // The canvases still hold the last frame drawn into them. Painting over
      // them costs nothing and means the only copy of somebody's screen left in
      // this page's memory is a black rectangle.
      canvas.width = 0;
      canvas.height = 0;
      thumb.width = 0;
      thumb.height = 0;
    },
    get glances() {
      return glances;
    },
  };
}
