import { inflateSync } from 'node:zlib';
import { assertPublicHost } from '../external-mcp';

/**
 * LEER UNA IMAGEN DE LOGO EN EL SERVIDOR, SIN DEPENDENCIAS NUEVAS.
 *
 *   - PNG: se decodifica aquí con `zlib` (todos los tipos de color y las
 *     profundidades de 1 a 16 bits; sin entrelazado).
 *   - JPG y WebP: si `sharp` está instalado en el servidor (Next lo trae), se
 *     usa; si no, se devuelve null y la herramienta lo dice con claridad en vez
 *     de adivinar. Nada se instala por esto.
 *
 * Las descargas de una URL pasan por la misma barrera que `web.scrape`
 * (nada privado ni de metadatos, también tras resolver el DNS y tras cada
 * redirección) y tienen tope de tamaño y de tiempo.
 */

export interface RawImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes por píxel. */
  data: Uint8Array;
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_PIXELS = 8_000_000;

export function sniffImage(bytes: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  const b = (i: number) => bytes[i] ?? -1;
  if (PNG_SIG.every((v, i) => b(i) === v)) return 'png';
  if (b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return 'jpg';
  if (b(0) === 0x52 && b(1) === 0x49 && b(2) === 0x46 && b(3) === 0x46 && b(8) === 0x57 && b(9) === 0x45)
    return 'webp';
  return null;
}

const be32 = (b: Uint8Array, o: number) =>
  (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0;

/** PNG → RGBA. Null si no es un PNG que se pueda leer (entrelazado, corrupto, enorme). */
export function decodePng(bytes: Uint8Array): RawImage | null {
  if (sniffImage(bytes) !== 'png') return null;
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const len = be32(bytes, pos);
    const type = String.fromCharCode(
      bytes[pos + 4] ?? 0,
      bytes[pos + 5] ?? 0,
      bytes[pos + 6] ?? 0,
      bytes[pos + 7] ?? 0,
    );
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    if (body.length < len) return null;
    if (type === 'IHDR') {
      width = be32(body, 0);
      height = be32(body, 4);
      depth = body[8] ?? 0;
      colorType = body[9] ?? 0;
      interlace = body[12] ?? 0;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!width || !height || interlace !== 0 || width * height > MAX_PIXELS) return null;
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) return null;
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const bitsPerPixel = channels * depth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  if (raw.length < (stride + 1) * height) return null;

  // Quita los filtros línea por línea.
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)] ?? 0;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[src + x] ?? 0;
      const left = x >= bpp ? (px[dst + x - bpp] ?? 0) : 0;
      const up = y > 0 ? (px[dst - stride + x] ?? 0) : 0;
      const upLeft = y > 0 && x >= bpp ? (px[dst - stride + x - bpp] ?? 0) : 0;
      let v: number;
      switch (filter) {
        case 0:
          v = cur;
          break;
        case 1:
          v = cur + left;
          break;
        case 2:
          v = cur + up;
          break;
        case 3:
          v = cur + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = cur + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default:
          return null;
      }
      px[dst + x] = v & 0xff;
    }
  }

  const out = new Uint8Array(width * height * 4);
  const sample = (row: number, index: number): number => {
    // `index`-ésima muestra de la fila (de 1 a 16 bits), escalada a 0-255.
    if (depth === 8) return px[row + index] ?? 0;
    if (depth === 16) return px[row + index * 2] ?? 0;
    const perByte = 8 / depth;
    const byte = px[row + Math.floor(index / perByte)] ?? 0;
    const shift = 8 - depth * ((index % perByte) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  const scale = depth < 8 ? 255 / ((1 << depth) - 1) : 1;
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 255;
      if (colorType === 3) {
        const i = sample(row, x);
        r = palette?.[i * 3] ?? 0;
        g = palette?.[i * 3 + 1] ?? 0;
        b = palette?.[i * 3 + 2] ?? 0;
        a = trns?.[i] ?? 255;
      } else if (colorType === 0 || colorType === 4) {
        r = g = b = Math.round(sample(row, x * channels) * scale);
        if (colorType === 4) a = sample(row, x * channels + 1);
      } else {
        r = sample(row, x * channels);
        g = sample(row, x * channels + 1);
        b = sample(row, x * channels + 2);
        if (colorType === 6) a = sample(row, x * channels + 3);
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return { width, height, data: out };
}

/** Cualquier PNG/JPG/WebP → RGBA, o null si este servidor no puede leerlo. */
export async function decodeImage(bytes: Uint8Array): Promise<RawImage | null> {
  const kind = sniffImage(bytes);
  if (!kind) return null;
  if (kind === 'png') {
    const png = decodePng(bytes);
    if (png) return png;
  }
  try {
    // `sharp` puede no estar: el nombre va en una variable para que el empaquetador no lo exija.
    const name = 'sharp';
    const mod = (await import(/* webpackIgnore: true */ name)) as { default: unknown };
    type Sharp = {
      resize: (w: number, h: number, o: object) => Sharp;
      ensureAlpha: () => Sharp;
      raw: () => Sharp;
      toBuffer: (o: { resolveWithObject: true }) => Promise<{
        data: Uint8Array;
        info: { width: number; height: number; channels: number };
      }>;
    };
    const sharp = mod.default as unknown as (input: Uint8Array) => Sharp;
    const { data, info } = await sharp(bytes)
      .resize(256, 256, { fit: 'inside', withoutEnlargement: true })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (info.channels !== 4) return null;
    return { width: info.width, height: info.height, data: new Uint8Array(data) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Descargas con barrera
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (compatible; CortexBrandBot/1.0)';

export interface Fetched {
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Descarga una URL pública: https/http, sin red privada (ni tras redirigir), con tope de bytes y tiempo. */
export async function fetchPublic(
  rawUrl: string,
  options: { maxBytes: number; timeoutMs?: number; accept?: string; signal?: AbortSignal },
): Promise<Fetched> {
  let url = rawUrl;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 8000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Sólo direcciones http o https.');
    await assertPublicHost(url);
    const res = await fetch(url, {
      redirect: 'manual',
      signal,
      headers: { 'user-agent': UA, accept: options.accept ?? '*/*' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location') as string, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`La dirección respondió ${res.status}.`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > options.maxBytes) throw new Error('El archivo es demasiado grande.');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Sin contenido.');
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > options.maxBytes) {
        await reader.cancel();
        // Para una página basta el principio; para una imagen un archivo cortado no sirve.
        if (options.accept?.includes('html')) break;
        throw new Error('El archivo es demasiado grande.');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    return { url, contentType: res.headers.get('content-type') ?? '', bytes };
  }
  throw new Error('Demasiadas redirecciones.');
}
