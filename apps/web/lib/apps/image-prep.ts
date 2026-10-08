/**
 * PREPARAR UNA IMAGEN EN EL NAVEGADOR (0215): reducirla, y para el ícono,
 * cuadrarla. Todo pasa por un canvas, y de ahí sale SIEMPRE un PNG o JPEG
 * nuevo: un SVG se dibuja y se convierte (nunca viaja ni se guarda como SVG, así
 * que no hay nada que sanear: el script que traiga no se ejecuta al dibujarlo
 * como imagen), y un archivo que sólo dice ser imagen no pasa del `Image`.
 *
 * Las cuentas (`fitSize`, `squareRect`) son puras y se prueban; `prepareImage`
 * es la parte con DOM.
 */

/** Cabe en un cuadrado de `max` px sin agrandarse. */
export function fitSize(w: number, h: number, max: number): { w: number; h: number } {
  const longest = Math.max(w, h, 1);
  const scale = Math.min(1, max / longest);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export type SquareMode = 'cover' | 'contain';

/**
 * Cómo se dibuja una imagen de `w`×`h` en un cuadrado de `size` px.
 * `cover` recorta al centro (llena el cuadrado); `contain` la deja entera con
 * margen a los lados (el ícono nunca pierde un pedazo del logo).
 */
export function squareRect(
  w: number,
  h: number,
  size: number,
  mode: SquareMode,
): {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
} {
  if (mode === 'cover') {
    const side = Math.min(w, h);
    return {
      sx: Math.round((w - side) / 2),
      sy: Math.round((h - side) / 2),
      sw: side,
      sh: side,
      dx: 0,
      dy: 0,
      dw: size,
      dh: size,
    };
  }
  const scale = size / Math.max(w, h, 1);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  return {
    sx: 0,
    sy: 0,
    sw: w,
    sh: h,
    dx: Math.round((size - dw) / 2),
    dy: Math.round((size - dh) / 2),
    dw,
    dh,
  };
}

export interface PreparedImage {
  blob: Blob;
  url: string;
  width: number;
  height: number;
}

async function decode(file: File): Promise<{ img: HTMLImageElement; revoke: () => void }> {
  const src = URL.createObjectURL(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('No se pudo leer esa imagen.'));
    el.src = src;
  });
  return { img, revoke: () => URL.revokeObjectURL(src) };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('No se pudo preparar la imagen.'))),
      type,
      quality,
    ),
  );
}

/** PNG de `max` px como mucho, conservando la transparencia. Un SVG sin tamaño se dibuja a `max`. */
export async function prepareImage(
  file: File,
  options: { max: number; square?: SquareMode; jpeg?: boolean },
): Promise<PreparedImage> {
  const { img, revoke } = await decode(file);
  try {
    const nw = img.naturalWidth || options.max;
    const nh = img.naturalHeight || options.max;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Este navegador no deja preparar la imagen.');
    if (options.square) {
      const size = Math.min(512, options.max);
      canvas.width = size;
      canvas.height = size;
      if (options.square === 'contain' || options.jpeg) {
        // Un ícono con fondo blanco: las tiendas de apps no aceptan transparencia.
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);
      }
      const r = squareRect(nw, nh, size, options.square);
      ctx.drawImage(img, r.sx, r.sy, r.sw, r.sh, r.dx, r.dy, r.dw, r.dh);
    } else {
      const { w, h } = fitSize(nw, nh, options.max);
      canvas.width = w;
      canvas.height = h;
      ctx.drawImage(img, 0, 0, w, h);
    }
    const blob = options.jpeg
      ? await toBlob(canvas, 'image/jpeg', 0.82)
      : await toBlob(canvas, 'image/png');
    return { blob, url: URL.createObjectURL(blob), width: canvas.width, height: canvas.height };
  } finally {
    revoke();
  }
}

/** Los píxeles de una imagen pequeña, para proponer sus colores (dominantColors). */
export async function samplePixels(file: File, side = 64): Promise<Uint8ClampedArray | null> {
  const { img, revoke } = await decode(file);
  try {
    const nw = img.naturalWidth || side;
    const nh = img.naturalHeight || side;
    const { w, h } = fitSize(nw, nh, side);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h).data;
  } finally {
    revoke();
  }
}
