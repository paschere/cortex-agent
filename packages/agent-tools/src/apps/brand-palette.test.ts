import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { decodePng, sniffImage } from './brand-image';
import {
  accessibleVariants,
  brandFromHtml,
  contrast,
  hexToRgb,
  paletteFromPixels,
  suggestFont,
  suggestStyle,
} from './brand-palette';
import { buildBrandProposal, inferAppKind, proposalMarkdown } from './brand-tool';

/** Un PNG RGBA sin entrelazado, hecho a mano para probar el decodificador. */
function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}
function makePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const o = y * (width * 4 + 1) + 1 + x * 4;
      raw.set(pixel(x, y), o);
    }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

describe('PNG', () => {
  it('lo decodifica y reconoce su formato', () => {
    const png = makePng(4, 2, (x) => [x * 60, 10, 200, 255]);
    expect(sniffImage(png)).toBe('png');
    const img = decodePng(png);
    expect(img).toMatchObject({ width: 4, height: 2 });
    expect([...(img?.data.subarray(4, 8) ?? [])]).toEqual([60, 10, 200, 255]);
  });
  it('un archivo que no es PNG da null', () => {
    expect(decodePng(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});

describe('contraste', () => {
  it('la variante clara y la oscura llegan a 4.5:1', () => {
    for (const hex of ['#ffd400', '#1f6feb', '#00c2a8', '#e11d48', '#111111', '#4338ca']) {
      const v = accessibleVariants(hex);
      expect(v, hex).not.toBeNull();
      expect(v?.lightContrast ?? 0).toBeGreaterThanOrEqual(4.5);
      expect(v?.darkContrast ?? 0).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hexToRgb(v?.light ?? '#000') ?? [0, 0, 0], [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('un color que ya pasa no se toca', () => {
    const v = accessibleVariants('#1f3a8a');
    expect(v?.passesAsIs).toBe(true);
    expect(v?.light).toBe('#1f3a8a');
  });
  it('un amarillo no pasa como está y se oscurece', () => {
    const v = accessibleVariants('#ffd400');
    expect(v?.passesAsIs).toBe(false);
    expect(v?.light).not.toBe('#ffd400');
  });
  it('un valor que no es color da null', () => {
    expect(accessibleVariants('zzz')).toBeNull();
  });
});

describe('paletteFromPixels', () => {
  const fill = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]) => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
    return data;
  };
  it('ignora fondo blanco y toma el color grande como principal y el otro como acento', () => {
    const data = fill(40, 40, (x, y) =>
      x < 8 ? [255, 255, 255, 255] : y < 28 ? [31, 111, 235, 255] : [250, 140, 20, 255],
    );
    const p = paletteFromPixels(data);
    expect(p.monochrome).toBe(false);
    expect(p.primary?.hex).toBe('#1f6feb');
    expect(p.accent?.hex).toBe('#fa8c14');
    expect(p.accentDerived).toBe(false);
  });
  it('transparente no cuenta', () => {
    const data = fill(20, 20, (x) => (x < 10 ? [0, 0, 0, 0] : [200, 30, 60, 255]));
    expect(paletteFromPixels(data).primary?.hex).toBe('#c81e3c');
  });
  it('un solo color: el acento se deriva', () => {
    const data = fill(20, 20, () => [20, 160, 90, 255]);
    const p = paletteFromPixels(data);
    expect(p.accentDerived).toBe(true);
    expect(p.accent?.hex).toMatch(/^#[0-9a-f]{6}$/);
    expect(p.accent?.hex).not.toBe(p.primary?.hex);
  });
  it('logo gris o negro: monocromo con el tono oscuro', () => {
    const data = fill(20, 20, (x) => (x < 10 ? [255, 255, 255, 255] : [20, 20, 20, 255]));
    const p = paletteFromPixels(data);
    expect(p.monochrome).toBe(true);
    expect(p.primary?.hex).toBe('#141414');
    expect(p.accent).toBeNull();
  });
  it('de punta a punta con un PNG', () => {
    const png = makePng(30, 30, () => [225, 29, 72, 255]);
    const img = decodePng(png);
    expect(paletteFromPixels(img?.data ?? []).primary?.hex).toBe('#e11d48');
  });
});

describe('fuente y estilo', () => {
  it('elige por el tipo de negocio', () => {
    expect(suggestFont('Firma de abogados y notaría').font).toBe('serif');
    expect(suggestFont('Clínica veterinaria').font).toBe('rounded');
    expect(suggestFont('operación de bodega y logística').font).toBe('system');
    expect(suggestFont('algo cualquiera').font).toBe('system');
  });
  it('el estilo cambia con el tipo de app', () => {
    expect(suggestStyle('tv').theme.style).toBe('dark-panel');
    expect(suggestStyle('portal').theme.header).toBe('hero');
    expect(suggestStyle('operario').theme.layout).toBe('operator');
  });
});

describe('brandFromHtml', () => {
  const html = `<html><head><title>Ferretería Los Andes | Inicio</title>
  <meta name="theme-color" content="#0a7d4b">
  <meta property="og:site_name" content="Ferretería Los Andes">
  <meta property="og:image" content="/img/portada.png">
  <link rel="apple-touch-icon" href="/apple.png">
  <link rel="icon" href="/favicon.ico">
  <style>:root{--brand-primary:#0a7d4b} a{color:#0a7d4b} .b{background:#f59e0b} .c{color:#f59e0b} .d{color:#fff}</style></head>
  <body><img class="site-logo" src="/logo.png" alt="Los Andes"></body></html>`;
  it('saca nombre, color del tema, colores del CSS e imágenes ordenadas', () => {
    const h = brandFromHtml(html, 'https://losandes.co/');
    expect(h.siteName).toBe('Ferretería Los Andes');
    expect(h.themeColor).toBe('#0a7d4b');
    expect(h.cssColors[0]?.hex).toBe('#0a7d4b');
    expect(h.cssColors.map((c) => c.hex)).toContain('#f59e0b');
    expect(h.cssColors.map((c) => c.hex)).not.toContain('#ffffff');
    expect(h.imageCandidates[0]).toBe('https://losandes.co/logo.png');
    expect(h.imageCandidates).toContain('https://losandes.co/apple.png');
    expect(h.imageCandidates.some((u) => u.endsWith('.ico'))).toBe(false);
  });
});

describe('propuesta', () => {
  it('desde un logo: colores, fuente, estilo y apply listo', () => {
    const p = buildBrandProposal({
      origin: 'el logo de la app',
      palette: { primary: { hex: '#ffd400', share: 0.7 }, accent: { hex: '#1f3a8a', share: 0.3 }, accentDerived: false, monochrome: false },
      text: 'clínica veterinaria',
      kind: 'portal',
    });
    expect(p?.apply.brand).toEqual({ primary: '#ffd400', accent: '#1f3a8a', font: 'rounded' });
    expect(p?.warnings.join(' ')).toContain('AA');
    expect(p?.primary.lightContrast).toBeGreaterThanOrEqual(4.5);
    expect(p?.style.theme.header).toBe('hero');
    expect(proposalMarkdown(p as NonNullable<typeof p>)).toContain('nada se ha guardado');
  });
  it('sin logo cae a los colores de la página y lo dice', () => {
    const p = buildBrandProposal({
      origin: 'la página x.co',
      palette: null,
      hints: { siteName: 'X', themeColor: null, cssColors: [{ hex: '#0a7d4b', count: 5 }, { hex: '#f59e0b', count: 3 }], imageCandidates: [] },
      text: '',
      kind: 'mixto',
    });
    expect(p?.primary.source).toBe('#0a7d4b');
    expect(p?.accent?.source).toBe('#f59e0b');
    expect(p?.warnings.join(' ')).toContain('estilo de la página');
  });
  it('sin nada devuelve null', () => {
    expect(buildBrandProposal({ origin: 'x', palette: null, hints: null, text: '', kind: 'mixto' })).toBeNull();
  });
});

describe('inferAppKind', () => {
  const role = (read: unknown) => ({ permissions: { tables: { t: { read, create: true } } } });
  it('sin pantallas: mixto', () => expect(inferAppKind([], [])).toBe('mixto'));
  it('rol con filtro por atributo y cabecera hero: portal', () => {
    const spec = { blocks: [], theme: { header: 'hero' } } as never;
    expect(inferAppKind([spec], [role({ field: 'c', equals: '$user.c' })])).toBe('portal');
  });
});
