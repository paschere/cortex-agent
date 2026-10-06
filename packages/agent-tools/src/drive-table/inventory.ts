import { driveGet } from '../gdrive/client';
import { XLSX_MIME } from '../kb/spreadsheets';
import type { ToolContext } from '../types';
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

export const INVENTORY_MAX_DEPTH = 3;
export const INVENTORY_MAX_FILES = 500;

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
  /** Se llegó al tope de archivos: hay más de los que se listaron. */
  truncated: boolean;
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
  const maxFiles = opts.maxFiles ?? INVENTORY_MAX_FILES;
  const tree: FolderTree = {
    files: [],
    folders: [],
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

  while (queue.length) {
    const here = queue.shift();
    if (!here) break;
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
      if (tree.files.length >= maxFiles) {
        tree.truncated = true;
        continue;
      }
      seenFiles.add(id);
      count += 1;
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
  total: number;
  counts: Record<FileClass, number>;
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
}

/** Cuenta lo que hay por clase, con los nombres de lo que no se puede leer y las subcarpetas. */
export async function inventoryFolder(
  drive: DriveAccess,
  folderId: string,
  opts: { recursive?: boolean; maxDepth?: number; maxFiles?: number } = {},
): Promise<FolderInventory> {
  const maxDepth = opts.maxDepth ?? INVENTORY_MAX_DEPTH;
  const maxFiles = opts.maxFiles ?? INVENTORY_MAX_FILES;
  const tree = await listFolderTree(drive, folderId, { ...opts, maxDepth, maxFiles });
  return inventoryOf(tree, { recursive: opts.recursive ?? false, maxDepth, maxFiles });
}

export function inventoryOf(
  tree: FolderTree,
  opts: { recursive: boolean; maxDepth: number; maxFiles: number },
): FolderInventory {
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
  };
  for (const f of tree.files) {
    const c = classifyFile(f.mimeType);
    inv.counts[c.class] += 1;
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
  const lines = [
    `En «${folderName}» hay ${inv.total} archivo(s)${parts.length ? `: ${parts.join(', ')}` : ''}.`,
  ];
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
  if (inv.truncated) lines.push(`Sólo conté los primeros ${inv.maxFiles} archivos; hay más.`);
  if (inv.problems.length)
    lines.push(`No pude abrir: ${inv.problems.map((p) => `«${p}»`).join(', ')} (sin acceso).`);
  for (const u of inv.unreadable.slice(0, 5)) lines.push(`- «${u.name}»: ${u.reason}`);
  return lines.join('\n');
}
