import { driveGet } from '../gdrive/client';
import { XLSX_MIME } from '../kb/spreadsheets';
import type { ToolContext } from '../types';
import { docTypeKey } from './doc-types';
import type { FolderFile } from './plan';

/**
 * QUÉ HAY EN UNA CARPETA DE DRIVE (y en sus subcarpetas).
 *
 * Antes de proponer la tabla se mira qué hay: cuántas hojas de cálculo, cuántos
 * documentos, cuántas imágenes, cuántos archivos que no se pueden leer, y qué
 * subcarpetas. `listFolderTree` recorre el árbol por niveles con topes
 * (profundidad y archivos) y lo mismo usa la sincronización para saber qué
 * leer, así que lo que el inventario promete es lo que la corrida va a ver.
 *
 *   - La papelera se salta (`trashed = false`).
 *   - Un acceso directo a una carpeta se sigue UNA vez: las carpetas visitadas
 *     se recuerdan por id, así que un atajo que apunta hacia arriba no hace un
 *     bucle. Un acceso directo a un archivo es ese archivo.
 *   - La ruta («Cliente A / Octubre») es sólo informativa; la identidad de un
 *     archivo es su id.
 */

type DriveAccess = Pick<ToolContext, 'integrations' | 'signal'>;

const FOLDER_MIME = 'application/vnd.google-apps.folder';
const SHORTCUT_MIME = 'application/vnd.google-apps.shortcut';

/** Niveles de subcarpetas que se abren (la raíz es el 0). */
export const INVENTORY_MAX_DEPTH = 4;
/**
 * Archivos que se miran completos para proponer. Pasado este número no se
 * corta a ciegas: se toma una MUESTRA ESTRATIFICADA (por subcarpeta, por tipo
 * de documento y por extensión) y se estima cuántos hay de verdad.
 */
export const INVENTORY_MAX_FILES = 5000;
/** Cuántos archivos se listan (sólo metadatos) antes de contar los demás sin guardarlos. */
export const INVENTORY_LIST_FACTOR = 4;
/** Subcarpetas que se abren como máximo en un recorrido. */
export const INVENTORY_MAX_FOLDERS = 3000;

export type FileClass = 'sheet' | 'document' | 'image' | 'unreadable';

const SHEET_MIMES = new Set(['application/vnd.google-apps.spreadsheet', XLSX_MIME, 'text/csv']);
const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.presentation',
  'text/plain',
  'text/markdown',
]);
/** Los formatos que el modelo acepta como imagen. */
export const IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** La clase de un archivo y, si no se puede leer, por qué (en español). */
export function classifyFile(mimeType: string): { class: FileClass; reason?: string } {
  if (SHEET_MIMES.has(mimeType)) return { class: 'sheet' };
  if (DOCUMENT_MIMES.has(mimeType)) return { class: 'document' };
  if (IMAGE_MIMES.has(mimeType)) return { class: 'image' };
  if (mimeType === 'image/heic' || mimeType === 'image/heif')
    return {
      class: 'unreadable',
      reason: 'Es una foto HEIC (iPhone): no la puedo convertir aquí; guárdala como JPG o PNG.',
    };
  if (mimeType.startsWith('image/'))
    return { class: 'unreadable', reason: `No leo imágenes de este tipo (${mimeType}).` };
  if (mimeType === 'application/vnd.ms-excel')
    return {
      class: 'unreadable',
      reason: 'Es un Excel antiguo (.xls): guárdalo como .xlsx o ábrelo en Google Sheets.',
    };
  if (mimeType === 'application/msword')
    return {
      class: 'unreadable',
      reason: 'Es un Word antiguo (.doc): guárdalo como .docx o ábrelo en Google Docs.',
    };
  return { class: 'unreadable', reason: `No sé leer este tipo de archivo (${mimeType}).` };
}

export interface FolderNode {
  id: string;
  name: string;
  /** Ruta desde la carpeta conectada: «Cliente A / Octubre». */
  path: string;
  depth: number;
  /** Archivos que hay directamente en ella. */
  files: number;
}

export interface FolderTree {
  files: FolderFile[];
  folders: FolderNode[];
  /** Se llegó al tope de lo que se lista: hay más de los que se guardaron. */
  truncated: boolean;
  /** Archivos vistos en el recorrido, también los que no se guardaron (0205+). */
  seen?: number;
  /** Subcarpetas que no se abrieron por el tope de carpetas. */
  foldersLeft?: number;
  /** Subcarpetas que no se abrieron por la profundidad. */
  tooDeep: string[];
  /** Subcarpetas de la raíz que no se abrieron porque no se pidió recursivo. */
  skipped: string[];
  /** Subcarpetas que no se pudieron abrir (sin acceso). */
  problems: string[];
}

interface DriveItem {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  md5Checksum?: string;
  size?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

function esc(id: string): string {
  return id.replace(/\\/g, '').replace(/'/g, "\\'");
}

async function listChildren(drive: DriveAccess, folderId: string): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = {
      q: `'${esc(folderId)}' in parents and trashed = false`,
      fields:
        'nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,size,shortcutDetails(targetId,targetMimeType))',
      orderBy: 'modifiedTime desc',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    };
    if (pageToken) params.pageToken = pageToken;
    const page = await driveGet<{ nextPageToken?: string; files?: DriveItem[] }>(
      drive as ToolContext,
      '/files',
      params,
    );
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < 3000);
  return out;
}

/**
 * Los archivos de la carpeta y, si `recursive`, los de sus subcarpetas hasta
 * `maxDepth` niveles (la raíz es el nivel 0). Para en `maxFiles`.
 */
export async function listFolderTree(
  drive: DriveAccess,
  rootId: string,
  opts: { recursive?: boolean; maxDepth?: number; maxFiles?: number } = {},
): Promise<FolderTree> {
  const recursive = opts.recursive ?? false;
  const maxDepth = opts.maxDepth ?? INVENTORY_MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? INVENTORY_MAX_FILES * INVENTORY_LIST_FACTOR;
  const tree: FolderTree = {
    files: [],
    folders: [],
    seen: 0,
    foldersLeft: 0,
    truncated: false,
    tooDeep: [],
    skipped: [],
    problems: [],
  };
  const visited = new Set<string>([rootId]);
  const queue: Array<{ id: string; name: string; path: string; depth: number }> = [
    { id: rootId, name: '', path: '', depth: 0 },
  ];
  const seenFiles = new Set<string>();

  let opened = 0;
  while (queue.length) {
    const here = queue.shift();
    if (!here) break;
    if (opened >= INVENTORY_MAX_FOLDERS) {
      tree.foldersLeft = (tree.foldersLeft ?? 0) + 1 + queue.length;
      tree.truncated = true;
      break;
    }
    opened += 1;
    let items: DriveItem[];
    try {
      items = await listChildren(drive, here.id);
    } catch (err) {
      if (here.depth === 0) throw err;
      tree.problems.push(here.path || here.name);
      continue;
    }
    let count = 0;
    for (const item of items) {
      let id = item.id;
      let mime = item.mimeType;
      if (mime === SHORTCUT_MIME) {
        // Un acceso directo es lo que apunta: sin destino no hay nada que leer.
        if (!item.shortcutDetails?.targetId || !item.shortcutDetails.targetMimeType) continue;
        id = item.shortcutDetails.targetId;
        mime = item.shortcutDetails.targetMimeType;
      }
      const childPath = here.path ? `${here.path} / ${item.name}` : item.name;
      if (mime === FOLDER_MIME) {
        if (visited.has(id)) continue;
        if (!recursive) {
          tree.skipped.push(item.name);
          continue;
        }
        if (here.depth + 1 > maxDepth) {
          tree.tooDeep.push(childPath);
          continue;
        }
        visited.add(id);
        queue.push({ id, name: item.name, path: childPath, depth: here.depth + 1 });
        continue;
      }
      if (seenFiles.has(id)) continue; // el mismo archivo por un atajo y directo
      seenFiles.add(id);
      count += 1;
      tree.seen = (tree.seen ?? 0) + 1;
      if (tree.files.length >= maxFiles) {
        tree.truncated = true;
        continue;
      }
      tree.files.push({
        id,
        name: item.name,
        mimeType: mime,
        // Lo mismo que drive-sync: un documento nativo de Google no tiene md5.
        revision: item.md5Checksum ?? item.modifiedTime ?? '',
        modifiedTime: item.modifiedTime ?? null,
        size: item.size ? Number(item.size) : null,
        path: here.path,
      });
    }
    if (here.depth > 0)
      tree.folders.push({
        id: here.id,
        name: here.name,
        path: here.path,
        depth: here.depth,
        files: count,
      });
  }
  tree.files.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
  return tree;
}

export interface FolderInventory {
  recursive: boolean;
  /** Archivos listados (todos los que se guardaron del recorrido). */
  total: number;
  /** Conteo por clase sobre TODOS los listados, no sólo la muestra. */
  counts: Record<FileClass, number>;
  /** Con muestra estratificada, éstas son las de la muestra. */
  sheets: FolderFile[];
  documents: FolderFile[];
  images: FolderFile[];
  unreadable: Array<FolderFile & { reason: string }>;
  folders: FolderNode[];
  truncated: boolean;
  tooDeep: string[];
  skipped: string[];
  problems: string[];
  maxDepth: number;
  maxFiles: number;
  /** Había más de `maxFiles`: las listas son una muestra representativa. */
  sampled: boolean;
  /** Tamaño de la muestra (= total cuando no se muestreó). */
  sampleSize: number;
  /** Cuántos archivos hay, estimado cuando no se alcanzó a contar todo. */
  estimatedTotal: number;
  /** La estimación es aproximada (se cortó el recorrido). */
  estimated: boolean;
  /** Estratos (subcarpeta × tipo × extensión) que cubre la muestra. */
  strata: number;
  /** Todos los archivos listados: la propuesta agrupa los tipos sobre esto. */
  all: FolderFile[];
}

/** Cuenta lo que hay por clase, con los nombres de lo que no se puede leer y las subcarpetas. */
export async function inventoryFolder(
  drive: DriveAccess,
  folderId: string,
  opts: { recursive?: boolean; maxDepth?: number; maxFiles?: number } = {},
): Promise<FolderInventory> {
  const maxDepth = opts.maxDepth ?? INVENTORY_MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? INVENTORY_MAX_FILES;
  const tree = await listFolderTree(drive, folderId, {
    ...opts,
    maxDepth,
    maxFiles: maxFiles * INVENTORY_LIST_FACTOR,
  });
  return inventoryOf(tree, { recursive: opts.recursive ?? false, maxDepth, maxFiles });
}

/**
 * Una muestra de `n` archivos que representa al conjunto: se reparte entre
 * ESTRATOS (subcarpeta × tipo de documento × extensión) en proporción a su
 * tamaño, con al menos un archivo por estrato mientras quepa; dentro de cada
 * estrato se toman archivos a intervalos regulares. Determinista: la misma
 * carpeta da la misma muestra.
 */
export function stratifiedSample(
  files: FolderFile[],
  n: number,
): { sample: FolderFile[]; strata: number } {
  if (files.length <= n) return { sample: files, strata: 0 };
  // Estratos finos (subcarpeta × tipo); si no caben en la muestra se agrupan por
  // la subcarpeta de más arriba (el mes, el cliente) y, al final, sólo por tipo:
  // mejor cubrir todo grueso que quedarse con los primeros estratos y olvidar el resto.
  const keyers: Array<(f: FolderFile) => string> = [
    (f) => `${f.path ?? ''}\u0000${docTypeKey(f.name, f.mimeType)}`,
    (f) => `${(f.path ?? '').split(' / ')[0]}\u0000${docTypeKey(f.name, f.mimeType)}`,
    (f) => docTypeKey(f.name, f.mimeType),
  ];
  let buckets = new Map<string, FolderFile[]>();
  for (const keyer of keyers) {
    buckets = new Map();
    for (const f of files) {
      const key = keyer(f);
      const list = buckets.get(key) ?? [];
      list.push(f);
      buckets.set(key, list);
    }
    if (buckets.size <= n) break;
  }
  // Dentro de un estrato, ordenados por ruta: tomar a intervalos regulares recorre las subcarpetas.
  const strata = [...buckets.values()]
    .map((list) =>
      list.sort((a, b) => (a.path ?? '').localeCompare(b.path ?? '') || a.id.localeCompare(b.id)),
    )
    .sort((a, b) => b.length - a.length);
  const kept = strata.slice(0, n);
  const total = kept.reduce((c, s) => c + s.length, 0);
  const quota = kept.map((s) => Math.max(1, Math.floor((s.length / total) * n)));
  // Sobran o faltan cupos por los redondeos: se reparte de a uno, del estrato más grande.
  let used = quota.reduce((c, q) => c + q, 0);
  for (let i = 0; used > n && i < 10 * kept.length; i++) {
    const j = i % kept.length;
    if ((quota[j] as number) > 1) {
      quota[j] = (quota[j] as number) - 1;
      used -= 1;
    }
  }
  for (let i = 0; used < n && i < 10 * kept.length; i++) {
    const j = i % kept.length;
    if ((quota[j] as number) < (kept[j] as FolderFile[]).length) {
      quota[j] = (quota[j] as number) + 1;
      used += 1;
    }
  }
  const sample: FolderFile[] = [];
  kept.forEach((s, i) => {
    const q = Math.min(quota[i] as number, s.length);
    for (let k = 0; k < q; k++) sample.push(s[Math.floor((k * s.length) / q)] as FolderFile);
  });
  sample.sort((a, b) => (b.modifiedTime ?? '').localeCompare(a.modifiedTime ?? ''));
  return { sample: sample.slice(0, n), strata: strata.length };
}

export function inventoryOf(
  tree: FolderTree,
  opts: { recursive: boolean; maxDepth: number; maxFiles: number },
): FolderInventory {
  const { sample, strata } = stratifiedSample(tree.files, opts.maxFiles);
  const sampled = sample.length < tree.files.length;
  const seen = Math.max(tree.seen ?? tree.files.length, tree.files.length);
  // Si el recorrido se cortó por carpetas sin abrir, se estima con el promedio por carpeta.
  const opened = Math.max(1, tree.folders.length + 1);
  const left = tree.foldersLeft ?? 0;
  const estimatedTotal = left ? Math.round(seen + (seen / opened) * left) : seen;
  const inv: FolderInventory = {
    recursive: opts.recursive,
    total: tree.files.length,
    counts: { sheet: 0, document: 0, image: 0, unreadable: 0 },
    sheets: [],
    documents: [],
    images: [],
    unreadable: [],
    folders: tree.folders,
    truncated: tree.truncated,
    tooDeep: tree.tooDeep,
    skipped: tree.skipped,
    problems: tree.problems,
    maxDepth: opts.maxDepth,
    maxFiles: opts.maxFiles,
    sampled,
    sampleSize: sample.length,
    estimatedTotal,
    estimated: left > 0 || seen > tree.files.length,
    strata,
    all: tree.files,
  };
  for (const f of tree.files) inv.counts[classifyFile(f.mimeType).class] += 1;
  for (const f of sample) {
    const c = classifyFile(f.mimeType);
    if (c.class === 'sheet') inv.sheets.push(f);
    else if (c.class === 'document') inv.documents.push(f);
    else if (c.class === 'image') inv.images.push(f);
    else inv.unreadable.push({ ...f, reason: c.reason ?? 'No se puede leer.' });
  }
  return inv;
}

/** El inventario en una o dos frases para el chat. */
export function inventoryMarkdown(inv: FolderInventory, folderName: string): string {
  const parts = [
    inv.counts.sheet ? `${inv.counts.sheet} hoja(s) de cálculo` : '',
    inv.counts.document ? `${inv.counts.document} documento(s) (PDF, Word, Docs)` : '',
    inv.counts.image ? `${inv.counts.image} imagen(es)` : '',
    inv.counts.unreadable ? `${inv.counts.unreadable} que no puedo leer` : '',
  ].filter(Boolean);
  const nf = (n: number) => n.toLocaleString('es-CO');
  const lines = [
    `En «${folderName}» hay ${inv.estimated ? 'más de ' : ''}${nf(inv.estimated ? Math.max(inv.total, inv.estimatedTotal) : inv.total)} archivo(s)${parts.length ? `: ${parts.join(', ')}` : ''}.`,
  ];
  if (inv.sampled)
    lines.push(
      `Son más de ${nf(inv.maxFiles)}, así que para proponer miré una MUESTRA representativa de ${nf(inv.sampleSize)} archivos repartida por subcarpeta y por tipo de documento (${nf(inv.strata)} combinaciones). La sincronización sí lee todos.`,
    );
  if (inv.recursive && inv.folders.length)
    lines.push(
      `Incluí ${inv.folders.length} subcarpeta(s) (hasta ${inv.maxDepth} niveles): ${inv.folders
        .slice(0, 8)
        .map((f) => `«${f.path}» (${f.files})`)
        .join(', ')}${inv.folders.length > 8 ? '…' : ''}.`,
    );
  if (inv.skipped.length)
    lines.push(
      `Hay ${inv.skipped.length} subcarpeta(s) que NO incluí: ${inv.skipped
        .slice(0, 6)
        .map((n) => `«${n}»`)
        .join(', ')}.`,
    );
  if (inv.tooDeep.length)
    lines.push(
      `${inv.tooDeep.length} subcarpeta(s) están a más de ${inv.maxDepth} niveles y no entran.`,
    );
  if (inv.truncated)
    lines.push(
      `El recorrido llegó a su tope (${nf(inv.total)} archivos guardados); la cifra real es mayor (estimo unos ${nf(inv.estimatedTotal)}).`,
    );
  if (inv.problems.length)
    lines.push(`No pude abrir: ${inv.problems.map((p) => `«${p}»`).join(', ')} (sin acceso).`);
  for (const u of inv.unreadable.slice(0, 5)) lines.push(`- «${u.name}»: ${u.reason}`);
  return lines.join('\n');
}
