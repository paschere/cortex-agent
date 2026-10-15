import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
// Construye la extensión en dist/ con esbuild: sin frameworks, sin plantillas.
//   node build.mjs          → apunta al Cortex de producción (o CORTEX_ORIGIN)
//   node build.mjs --dev    → además deja hablar con http://localhost:3311
import { build } from 'esbuild';

const dev = process.argv.includes('--dev');
const origin = (process.env.CORTEX_ORIGIN ?? 'https://cortex-vertix.vercel.app').replace(/\/+$/, '');
const version = '0.1.0';
const out = new URL('./dist/', import.meta.url).pathname;

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: {
    background: 'src/background.ts',
    content: 'src/content.ts',
    sidepanel: 'src/sidepanel.ts',
    'consent-page': 'src/consent-page.ts',
  },
  outdir: out,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  define: { __CORTEX_ORIGIN__: JSON.stringify(origin) },
  logLevel: 'info',
});

cpSync(new URL('./static/', import.meta.url).pathname, out, { recursive: true });

// Iconos: un cuadrado redondeado índigo con un punto blanco, sin dependencias.
function png(size) {
  const px = Buffer.alloc(size * (size * 4 + 1));
  const r = size * 0.22;
  for (let y = 0; y < size; y += 1) {
    px[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const dx = Math.max(r - x, 0, x - (size - 1 - r));
      const dy = Math.max(r - y, 0, y - (size - 1 - r));
      const inside = dx * dx + dy * dy <= r * r;
      const cx = x - size / 2 + 0.5;
      const cy = y - size / 2 + 0.5;
      const dot = cx * cx + cy * cy <= (size * 0.2) ** 2;
      const i = y * (size * 4 + 1) + 1 + x * 4;
      const c = !inside ? [0, 0, 0, 0] : dot ? [247, 245, 239, 255] : [59, 52, 196, 255];
      px[i] = c[0];
      px[i + 1] = c[1];
      px[i + 2] = c[2];
      px[i + 3] = c[3];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(px)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const s of [16, 32, 48, 128]) writeFileSync(`${out}icon-${s}.png`, png(s));

const hosts = [`${origin}/*`];
if (dev) hosts.push('http://localhost:3311/*');
const manifest = {
  manifest_version: 3,
  name: 'Cortex en tu Chrome',
  version,
  description:
    'Deja que Cortex trabaje en tu propio Chrome, con tus sesiones abiertas, sitio por sitio y con tu permiso.',
  minimum_chrome_version: '120',
  icons: { 16: 'icon-16.png', 32: 'icon-32.png', 48: 'icon-48.png', 128: 'icon-128.png' },
  action: {
    default_title: 'Cortex en tu Chrome',
    default_icon: { 16: 'icon-16.png', 32: 'icon-32.png' },
  },
  side_panel: { default_path: 'sidepanel.html' },
  background: { service_worker: 'background.js' },
  // Mínimo imprescindible. Sin permisos de sitios: se piden uno por uno cuando
  // la persona aprueba (optional_host_permissions) y Chrome mismo los hace valer.
  permissions: ['storage', 'tabs', 'scripting', 'sidePanel', 'alarms'],
  host_permissions: hosts,
  optional_host_permissions: ['*://*/*'],
  content_security_policy: { extension_pages: "script-src 'self'; object-src 'self'" },
};
writeFileSync(`${out}manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Extensión lista en ${out} (Cortex: ${origin}${dev ? ' + localhost:3311' : ''})`);
