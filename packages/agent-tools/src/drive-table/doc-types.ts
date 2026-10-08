import type { FolderFile } from './plan';

/**
 * TIPOS DE DOCUMENTO DE UNA CARPETA.
 *
 * Una carpeta de operación casi nunca tiene un solo tipo de archivo: junto a la
 * prealerta hay un manifiesto, un formulario de aduana, fotos. Agrupar por el
 * NOMBRE (sin consecutivos, fechas ni números) y la extensión deja ver cuántos
 * hay de cada tipo, sacar una muestra de cada uno, y decidir cuál sirve para qué
 * campo. Todo determinista: el mismo nombre da siempre el mismo tipo, así que la
 * sincronización clasifica cada archivo igual que la propuesta.
 *
 *   «33. FEDEX 3325 07102026 / PREALERTA 3325.pdf»  → tipo «prealerta · pdf»
 *   «MANIFIESTO AEROLINEAS (1).xlsx»                 → tipo «manifiesto aerolinea · xlsx»
 *
 * Dos nombres casi iguales («manifiesto aerolinea», «manifiesto aerolineas
 * fedex») se juntan si comparten el 60 % de sus palabras y la extensión.
 */

const SIMILARITY = 0.6;

function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function extOf(name: string, mimeType: string): string {
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(name);
  if (m) return (m[1] as string).toLowerCase();
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'gsheet';
  if (mimeType === 'application/vnd.google-apps.document') return 'gdoc';
  if (mimeType === 'application/pdf') return 'pdf';
  return (
    mimeType
      .split('/')
      .pop()
      ?.replace(/[^a-z0-9]+/gi, '')
      .toLowerCase()
      .slice(0, 8) || 'archivo'
  );
}

function stem(token: string): string {
  return token.length > 4 && token.endsWith('s') ? token.slice(0, -1) : token;
}

/** El «tipo en bruto» de un archivo: palabras del nombre sin números + extensión. */
export function docTypeKey(name: string, mimeType: string): string {
  const ext = extOf(name, mimeType);
  const base = fold(name.replace(/\.[A-Za-z0-9]{2,5}$/, ''))
    .replace(/\(\s*\d+\s*\)/g, ' ') // «(1)» de una copia
    .replace(/\b(copia|copy|final|scan|escaneado)\b/g, ' ');
  const words = base
    .split(/[^a-zñ]+/)
    .filter((w) => w.length > 1)
    .map(stem)
    .slice(0, 6);
  return `${words.join(' ') || 'sin nombre'}.${ext}`;
}

function tokensOf(key: string): { words: Set<string>; ext: string } {
  const i = key.lastIndexOf('.');
  return { words: new Set(key.slice(0, i).split(' ')), ext: key.slice(i + 1) };
}

/** ¿Dos tipos en bruto son el mismo tipo de documento? */
export function sameDocType(a: string, b: string): boolean {
  if (a === b) return true;
  const x = tokensOf(a);
  const y = tokensOf(b);
  if (x.ext !== y.ext) return false;
  let both = 0;
  for (const w of x.words) if (y.words.has(w)) both += 1;
  return both / new Set([...x.words, ...y.words]).size >= SIMILARITY;
}

/** A cuál de los tipos conocidos se parece más este archivo (o null). */
export function matchDocType(name: string, mimeType: string, types: string[]): string | null {
  const key = docTypeKey(name, mimeType);
  if (types.includes(key)) return key;
  let best: { type: string; score: number } | null = null;
  const x = tokensOf(key);
  for (const t of types) {
    if (!sameDocType(key, t)) continue;
    const y = tokensOf(t);
    let both = 0;
    for (const w of x.words) if (y.words.has(w)) both += 1;
    const score = both / new Set([...x.words, ...y.words]).size;
    if (!best || score > best.score) best = { type: t, score };
  }
  return best?.type ?? null;
}

export interface DocTypeGroup {
  /** El tipo en bruto representativo (el del grupo más numeroso). */
  key: string;
  /** Cómo se lo cuento a la persona: «manifiesto aerolinea (xlsx)». */
  label: string;
  ext: string;
  /** El mimeType del archivo más numeroso del grupo. */
  mimeType: string;
  count: number;
  /** Hasta 3 archivos de ejemplo, los más recientes primero. */
  examples: FolderFile[];
  /** En cuántas subcarpetas distintas aparece. */
  folders: number;
}

/** Agrupa los archivos por tipo de documento, del más numeroso al menos. */
export function groupByDocType(files: FolderFile[]): DocTypeGroup[] {
  const raw = new Map<string, FolderFile[]>();
  for (const f of files) {
    const key = docTypeKey(f.name, f.mimeType);
    const list = raw.get(key) ?? [];
    list.push(f);
    raw.set(key, list);
  }
  const ordered = [...raw.entries()].sort((a, b) => b[1].length - a[1].length);
  const groups: Array<{ key: string; files: FolderFile[] }> = [];
  for (const [key, list] of ordered) {
    const home = groups.find((g) => sameDocType(g.key, key));
    if (home) home.files.push(...list);
    else groups.push({ key, files: [...list] });
  }
  return groups
    .map((g) => {
      const t = tokensOf(g.key);
      const sorted = [...g.files].sort((a, b) =>
        (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''),
      );
      const first = g.files[0] as FolderFile;
      return {
        key: g.key,
        label: `${[...t.words].join(' ')} (${t.ext})`,
        ext: t.ext,
        mimeType: first.mimeType,
        count: g.files.length,
        examples: sorted.slice(0, 3),
        folders: new Set(g.files.map((f) => f.path ?? '')).size,
      };
    })
    .sort((a, b) => b.count - a.count);
}
