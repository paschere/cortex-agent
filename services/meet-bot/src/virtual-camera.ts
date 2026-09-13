import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';

/**
 * CÁMARA VIRTUAL DEL BOT.
 *
 * Chrome en Docker no tiene webcam. Sin un y4m decodificable Meet muestra
 * «Camera not found» para siempre (--use-file-for-fake-video-capture=/dev/null
 * no es un video). El y4m registra el dispositivo; lo que la sala VE es un
 * canvas (tarjeta con el nombre, o la imagen/video que configure MEET_CAMERA)
 * metido en getUserMedia, el mismo truco que el micro virtual.
 *
 *   MEET_CAMERA=off                         no enciende la cámara
 *   MEET_CAMERA=card                        (default) tarjeta con el nombre
 *   MEET_CAMERA=https://…/logo.png          imagen
 *   MEET_CAMERA=/app/brand/cortex.mp4       video en loop
 *   MEET_CAMERA_SUBTITLE=tomando notas
 *   MEET_CAMERA_COLOR=#7C6AF7
 */

export type CameraMode = 'off' | 'card' | 'image' | 'video';
export type CameraState = 'idle' | 'listening' | 'processing' | 'speaking';

export interface CameraPageConfig {
  mode: Exclude<CameraMode, 'off'>;
  name: string;
  subtitle: string;
  accent: string;
  mediaDataUrl?: string;
}

export interface ResolvedCamera {
  enabled: boolean;
  mode: CameraMode;
  page: CameraPageConfig | null;
  script: string | null;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.webm', '.mov']);
const MAX_IMAGE = 2_000_000;
const MAX_VIDEO = 8_000_000;

export function parseCameraSpec(raw?: string | null): { mode: CameraMode; ref?: string } {
  const spec = (raw ?? '').trim();
  if (!spec || /^(card|on|true|yes|default)$/i.test(spec)) return { mode: 'card' };
  if (/^(off|false|0|none|disabled)$/i.test(spec)) return { mode: 'off' };
  const ext = extname(spec.split('?')[0] ?? '').toLowerCase();
  if (VIDEO_EXT.has(ext)) return { mode: 'video', ref: spec };
  return { mode: 'image', ref: spec };
}

export function normalizeAccent(raw?: string | null): string {
  const hex = (raw ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? hex : '#7C6AF7';
}

/** Un frame 640×360 navy. Chrome lo recicla; basta para que el dispositivo exista. */
export function virtualCamY4mBytes(width = 640, height = 360): Buffer {
  const w = width & ~1;
  const h = height & ~1;
  const header = Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A0:0 C420\nFRAME\n`);
  const ySize = w * h;
  const uvSize = (w / 2) * (h / 2);
  const y = Buffer.alloc(ySize, 18);
  const u = Buffer.alloc(uvSize, 138);
  const v = Buffer.alloc(uvSize, 122);
  return Buffer.concat([header, y, u, v]);
}

export function virtualCamY4mPath(): string {
  const baked = '/app/virtual-cam.y4m';
  try {
    if (existsSync(baked)) return baked;
  } catch {
    /* */
  }
  const out = join(tmpdir(), 'cortex-virtual-cam.y4m');
  try {
    if (!existsSync(out)) writeFileSync(out, virtualCamY4mBytes());
  } catch {
    /* Chrome still sees a fake device; frames may be black until the canvas hijack. */
  }
  return out;
}

function guessMime(ref: string, fallback: string): string {
  const ext = extname(ref.split('?')[0] ?? '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  return fallback;
}

async function loadMediaDataUrl(ref: string, kind: 'image' | 'video'): Promise<string | null> {
  const cap = kind === 'video' ? MAX_VIDEO : MAX_IMAGE;
  const fallback = kind === 'video' ? 'video/mp4' : 'image/png';
  try {
    if (/^https?:\/\//i.test(ref)) {
      const res = await fetch(ref, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        console.log(`[cortex-meet] cámara: ${ref} → HTTP ${res.status}, uso la tarjeta`);
        return null;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length < 32 || bytes.length > cap) {
        console.log(`[cortex-meet] cámara: ${ref} pesa ${bytes.length} bytes, uso la tarjeta`);
        return null;
      }
      const mime =
        (res.headers.get('content-type') ?? '').split(';')[0].trim() || guessMime(ref, fallback);
      return `data:${mime};base64,${bytes.toString('base64')}`;
    }
    const bytes = readFileSync(ref);
    if (bytes.length < 32 || bytes.length > cap) {
      console.log(`[cortex-meet] cámara: ${ref} pesa ${bytes.length} bytes, uso la tarjeta`);
      return null;
    }
    return `data:${guessMime(ref, fallback)};base64,${bytes.toString('base64')}`;
  } catch (err) {
    console.log(
      `[cortex-meet] cámara: no pude leer ${ref} (${err instanceof Error ? err.message : err}), uso la tarjeta`,
    );
    return null;
  }
}

export function virtualCameraScript(cfg: CameraPageConfig): string {
  return `(() => {
  if (window.__cortexCamera) return;
  const CFG = ${JSON.stringify(cfg)};
  const W = 1280;
  const H = 720;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const media = CFG.mediaDataUrl
    ? (CFG.mode === 'video'
        ? Object.assign(document.createElement('video'), {
            src: CFG.mediaDataUrl,
            muted: true,
            loop: true,
            playsInline: true,
          })
        : Object.assign(new Image(), { src: CFG.mediaDataUrl }))
    : null;
  if (media && 'play' in media) {
    media.play().catch(function () {});
  }

  const CAMERA_STATES = {
    idle: { label: 'En la llamada', color: CFG.accent },
    listening: { label: 'Escuchando', color: '#59D9C2' },
    processing: { label: 'Pensando', color: '#A990FF' },
    speaking: { label: 'Respondiendo', color: '#F3B562' },
  };
  const STATE_ALIASES = {
    rest: 'idle', resting: 'idle', reposo: 'idle', ready: 'idle',
    listen: 'listening', escucha: 'listening', hearing: 'listening',
    process: 'processing', thinking: 'processing', procesando: 'processing',
    response: 'speaking', responding: 'speaking', respuesta: 'speaking', speak: 'speaking',
  };
  let cameraState = 'idle';
  let stateChangedAt = performance.now();

  function cover(srcW, srcH) {
    const scale = Math.max(W / srcW, H / srcH);
    const dw = srcW * scale;
    const dh = srcH * scale;
    return { x: (W - dw) / 2, y: (H - dh) / 2, w: dw, h: dh };
  }

  function paintCard(t) {
    const state = CAMERA_STATES[cameraState];
    const seconds = t / 1000;
    const transition = Math.min(1, (performance.now() - stateChangedAt) / 420);
    const g = ctx.createRadialGradient(W * 0.5, H * 0.45, 40, W * 0.5, H * 0.45, 720);
    g.addColorStop(0, '#15162A');
    g.addColorStop(0.58, '#090B16');
    g.addColorStop(1, '#05060C');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // A single continuous orbital spiral is the Cortex signature. Its motion
    // changes with the live state while the composition remains calm in Meet.
    const cx = W / 2;
    const cy = H * 0.39;
    const turns = cameraState === 'processing' ? 3.25 : 2.75;
    const speed = cameraState === 'processing' ? 1.35 : cameraState === 'speaking' ? 0.9 : 0.42;
    const breath = cameraState === 'listening' ? 1 + Math.sin(seconds * 3.1) * 0.055 : 1;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(seconds * speed);
    ctx.scale(breath, breath);
    ctx.lineCap = 'round';
    ctx.shadowColor = state.color;
    ctx.shadowBlur = cameraState === 'idle' ? 18 : 30;
    const spiral = ctx.createLinearGradient(-150, -120, 150, 120);
    spiral.addColorStop(0, 'rgba(255,255,255,0.06)');
    spiral.addColorStop(0.46, state.color);
    spiral.addColorStop(1, '#F4F0FF');
    ctx.strokeStyle = spiral;
    ctx.lineWidth = 7;
    ctx.globalAlpha = 0.72 + transition * 0.28;
    ctx.beginPath();
    for (let i = 0; i <= 260; i += 1) {
      const p = i / 260;
      const angle = p * Math.PI * 2 * turns;
      const radius = 8 + p * 137;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius * 0.82;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = '600 18px ui-sans-serif, -apple-system, system-ui, sans-serif';
    ctx.fillText('CORTEX', cx, H * 0.67);
    ctx.fillStyle = '#F7F5FF';
    ctx.font = '650 42px ui-sans-serif, -apple-system, system-ui, sans-serif';
    ctx.fillText((CFG.name || 'Cortex').slice(0, 28), cx, H * 0.735);

    const statusY = H * 0.825;
    const dotPulse = cameraState === 'idle' ? 0.85 : 0.78 + Math.sin(seconds * 4.2) * 0.22;
    ctx.beginPath();
    ctx.arc(cx - 70, statusY, 6 + dotPulse * 2, 0, Math.PI * 2);
    ctx.fillStyle = state.color;
    ctx.shadowColor = state.color;
    ctx.shadowBlur = 15;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(247,245,255,0.72)';
    ctx.font = '500 24px ui-sans-serif, -apple-system, system-ui, sans-serif';
    ctx.fillText(state.label, cx - 51, statusY + 1);

    if (CFG.subtitle && cameraState === 'idle') {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(247,245,255,0.38)';
      ctx.font = '450 18px ui-sans-serif, -apple-system, system-ui, sans-serif';
      ctx.fillText(String(CFG.subtitle).slice(0, 48), cx, H * 0.89);
    }
  }

  function paint() {
    try {
      if (media && CFG.mode === 'video' && media.readyState >= 2) {
        const box = cover(media.videoWidth || W, media.videoHeight || H);
        ctx.drawImage(media, box.x, box.y, box.w, box.h);
      } else if (media && CFG.mode === 'image' && media.complete && media.naturalWidth) {
        const box = cover(media.naturalWidth, media.naturalHeight);
        ctx.drawImage(media, box.x, box.y, box.w, box.h);
      } else {
        paintCard(Date.now());
      }
    } catch (e) {
      paintCard(Date.now());
    }
  }

  paint();
  setInterval(paint, 80);
  const stream = canvas.captureStream(12);
  const camTrack = stream.getVideoTracks()[0];
  if (camTrack) {
    camTrack.enabled = true;
    try { window.__cortexLocalVideoTrackId = camTrack.id; } catch (e) {}
  }

  function wantsVideo(constraints) {
    if (!constraints) return false;
    if (constraints.video === false || constraints.video == null) return false;
    return true;
  }

  const protoGUM = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = async function (constraints) {
    if (!wantsVideo(constraints) || !camTrack) return protoGUM.call(this, constraints);
    const real = await protoGUM.call(this, constraints);
    try {
      for (const t of real.getVideoTracks()) {
        real.removeTrack(t);
        try { t.stop(); } catch (e) {}
      }
    } catch (e) {}
    real.addTrack(camTrack);
    return real;
  };

  const protoEnum = MediaDevices.prototype.enumerateDevices;
  MediaDevices.prototype.enumerateDevices = async function () {
    const list = await protoEnum.call(this);
    if (list.some((d) => d.kind === 'videoinput')) return list;
    return [{
      deviceId: 'cortex-virtual-cam',
      groupId: 'cortex',
      kind: 'videoinput',
      label: 'Cortex Camera',
      toJSON() { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label }; },
    }, ...list];
  };

  const videoPcs = [];
  const PrevPC = window.RTCPeerConnection;
  if (PrevPC && !PrevPC.__cortexCamWrapped) {
    const Wrapped = new Proxy(PrevPC, {
      construct(Target, args) {
        const pc = new Target(...args);
        videoPcs.push(pc);
        return pc;
      },
    });
    Wrapped.__cortexCamWrapped = true;
    window.RTCPeerConnection = Wrapped;
  }

  async function hijackSenders() {
    let replaced = 0;
    let already = 0;
    if (!camTrack) return { replaced, already, pcs: videoPcs.length };
    for (const pc of videoPcs) {
      try {
        for (const sender of pc.getSenders()) {
          const t = sender.track;
          if (!t || t.kind !== 'video') continue;
          if (t.id === camTrack.id) { already += 1; t.enabled = true; continue; }
          try {
            await sender.replaceTrack(camTrack);
            camTrack.enabled = true;
            replaced += 1;
          } catch (e) {}
        }
      } catch (e) {}
    }
    return { replaced, already, pcs: videoPcs.length };
  }

  window.__cortexCamera = {
    setState: (next) => {
      const raw = String(next || '').trim().toLowerCase();
      const normalized = CAMERA_STATES[raw] ? raw : STATE_ALIASES[raw];
      if (!normalized) return false;
      if (normalized !== cameraState) {
        cameraState = normalized;
        stateChangedAt = performance.now();
        paint();
      }
      return true;
    },
    arm: async () => {
      paint();
      if (media && 'play' in media) media.play().catch(function () {});
      const hijack = await hijackSenders();
      return {
        mode: CFG.mode,
        track: camTrack && camTrack.readyState,
        hijack,
      };
    },
    status: () => ({
      mode: CFG.mode,
      state: cameraState,
      track: camTrack && camTrack.readyState,
      pcs: videoPcs.length,
    }),
  };
})();`;
}

export async function resolveVirtualCamera(input: {
  spec?: string | null;
  name: string;
  subtitle?: string | null;
  accent?: string | null;
}): Promise<ResolvedCamera> {
  const parsed = parseCameraSpec(input.spec);
  if (parsed.mode === 'off') {
    return { enabled: false, mode: 'off', page: null, script: null };
  }

  let mode: Exclude<CameraMode, 'off'> = parsed.mode;
  let mediaDataUrl: string | undefined;
  if ((mode === 'image' || mode === 'video') && parsed.ref) {
    const loaded = await loadMediaDataUrl(parsed.ref, mode);
    if (loaded) mediaDataUrl = loaded;
    else mode = 'card';
  }

  const page: CameraPageConfig = {
    mode,
    name: input.name.trim() || 'Cortex',
    subtitle: (input.subtitle ?? 'tomando notas').trim(),
    accent: normalizeAccent(input.accent),
    ...(mediaDataUrl ? { mediaDataUrl } : {}),
  };
  return { enabled: true, mode: page.mode, page, script: virtualCameraScript(page) };
}
