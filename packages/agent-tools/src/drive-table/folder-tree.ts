import { z } from 'zod';
import { registerTool } from '../index';
import { groupByDocType } from './doc-types';
import type { DriveAccess } from './engine';
import {
  type FolderTree,
  INVENTORY_LIST_FACTOR,
  INVENTORY_MAX_FILES,
  classifyFile,
  listFolderTree,
} from './inventory';
import { type PathPattern, describeValues, detectPathPatterns } from './path-fields';
import { resolveFolder } from './tools';

/**
 * LA ESTRUCTURA DE UNA CARPETA DE DRIVE, SIN ABRIR DOCUMENTOS.
 *
 * Para saber DÓNDE guardar o encontrar algo («el vuelo FEDEX 3325 de octubre»)
 * no hace falta leer ni un archivo: basta ver cómo se llaman las carpetas por
 * nivel y qué suele haber en cada una. Esta herramienta lista el árbol en
 * paralelo (mismo recorrido que el inventario, en modo liviano), reconoce el
 * patrón de los nombres de cada nivel (path-fields.ts: «33. FEDEX 3325
 * 07102026» → n.º, nombre, código, fecha) y devuelve un resumen por NIVEL, no
 * una lista de miles de carpetas. Sólo lee metadatos. No sustituye a
 * trackers.propose_from_drive_folder, que es para CREAR una tabla.
 */

const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
/** Pasado este tiempo se entrega lo listado hasta ahí y se dice. */
export const FOLDER_TREE_BUDGET_MS = 15_000;

export interface TreeLevel {
  level: number;
  /** Carpetas de este nivel. */
  folders: number;
  /** Algunas, tal cual se llaman (las más recientes por orden de lista). */
  examples: string[];
  /** El patrón de sus nombres, si lo hay. */
  pattern: {
    shape: string;
    matching: number;
    names: number;
    examples: Array<{ name: string; values: string }>;
    unmatched: string[];
  } | null;
  /** Qué archivos hay directamente en carpetas de este nivel (con `includeFiles`). */
  files?: {
    total: number;
    byClass: Record<string, number>;
    types: Array<{ type: string; count: number }>;
  };
}

export interface FolderTreeSummary {
  levels: TreeLevel[];
  totalFolders: number;
  totalFiles: number;
  truncated: boolean;
  timedOut: boolean;
  /** Carpetas más abajo del nivel pedido. */
  deeper: number;
  problems: string[];
  markdown: string;
}

const nf = (n: number) => n.toLocaleString('es-CO');

function fileLevel(path: string | undefined): number {
  return path ? path.split(' / ').length : 0;
}

/** Puro: el árbol listado, resumido por nivel (determinista: mismos datos, misma salida). */
export function summarizeTree(
  tree: FolderTree,
  rootName: string,
  opts: { includeFiles: boolean; depth: number },
): FolderTreeSummary {
  const patterns = detectPathPatterns(tree.folders);
  const byLevelPattern = new Map<number, PathPattern>(patterns.map((p) => [p.level, p]));
  const folders = [...tree.folders].sort(
    (a, b) => a.depth - b.depth || a.path.localeCompare(b.path),
  );
  const depths = [...new Set(folders.map((f) => f.depth))].sort((a, b) => a - b);
  const levels: TreeLevel[] = depths.map((level) => {
    const here = folders.filter((f) => f.depth === level);
    const names = [...new Set(here.map((f) => f.name))];
    const pat = byLevelPattern.get(level);
    const out: TreeLevel = {
      level,
      folders: here.length,
      examples: names.slice(0, 5),
      pattern: pat
        ? {
            shape: pat.shape,
            matching: pat.matching,
            names: pat.names,
            examples: pat.examples.map((e) => ({ name: e.name, values: describeValues(e.values) })),
            unmatched: pat.unmatched,
          }
        : null,
    };
    return out;
  });
  if (opts.includeFiles) {
    // Archivos de la raíz = nivel 0; los de una carpeta de nivel N = nivel N.
    const byLevel = new Map<number, typeof tree.files>();
    for (const f of tree.files) {
      const l = fileLevel(f.path);
      byLevel.set(l, [...(byLevel.get(l) ?? []), f]);
    }
    for (const [l, files] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
      let lv = levels.find((x) => x.level === l);
      if (!lv) {
        lv = { level: l, folders: l === 0 ? 1 : 0, examples: [], pattern: null };
        levels.push(lv);
      }
      const byClass: Record<string, number> = {};
      for (const f of files) {
        const c = classifyFile(f.mimeType).class;
        byClass[c] = (byClass[c] ?? 0) + 1;
      }
      lv.files = {
        total: files.length,
        byClass,
        types: groupByDocType(files)
          .slice(0, 6)
          .map((g) => ({ type: g.label, count: g.count })),
      };
    }
    levels.sort((a, b) => a.level - b.level);
  }

  const lines: string[] = [];
  const seen = tree.seen ?? tree.files.length;
  lines.push(
    `«${rootName}»: ${nf(folders.length)} subcarpeta(s) hasta el nivel ${opts.depth}${opts.includeFiles ? `, ${nf(seen)} archivo(s)` : ''}.`,
  );
  for (const lv of levels) {
    const head =
      lv.level === 0
        ? 'En la carpeta raíz'
        : `Nivel ${lv.level} (${nf(lv.folders)} carpeta${lv.folders === 1 ? '' : 's'})`;
    const ex = lv.examples.length
      ? `: ${lv.examples.map((e) => `«${e}»`).join(', ')}${lv.folders > lv.examples.length ? '…' : ''}`
      : '';
    lines.push(`- **${head}**${lv.level === 0 ? '' : ex}`);
    if (lv.pattern)
      lines.push(
        `  - Los nombres siguen un patrón (${lv.pattern.shape}), en ${nf(lv.pattern.matching)} de ${nf(lv.pattern.names)}: ${lv.pattern.examples
          .map((e) => `«${e.name}» → ${e.values}`)
          .join(
            '; ',
          )}.${lv.pattern.unmatched.length ? ` No encajan: ${lv.pattern.unmatched.map((n) => `«${n}»`).join(', ')}.` : ''}`,
      );
    if (lv.files)
      lines.push(
        `  - Archivos directamente en ${lv.level === 0 ? 'la raíz' : 'estas carpetas'}: ${nf(lv.files.total)}${lv.files.types.length ? ` (${lv.files.types.map((t) => `${t.type} ×${nf(t.count)}`).join(', ')})` : ''}.`,
      );
  }
  if (tree.tooDeep.length)
    lines.push(
      `Hay ${nf(tree.tooDeep.length)} carpeta(s) más abajo del nivel ${opts.depth} que no abrí.`,
    );
  if (tree.timedOut)
    lines.push(
      `Se acabó el tiempo: abrí ${nf(folders.length)} carpetas y quedaron ${nf(tree.foldersLeft ?? 0)} sin abrir; el árbol está incompleto.`,
    );
  else if (tree.truncated)
    lines.push('El recorrido llegó a su tope de carpetas o archivos; hay más de lo que muestro.');
  if (tree.problems.length)
    lines.push(
      `No pude abrir: ${tree.problems
        .slice(0, 5)
        .map((p) => `«${p}»`)
        .join(', ')} (sin acceso).`,
    );

  return {
    levels,
    totalFolders: folders.length,
    totalFiles: seen,
    truncated: tree.truncated,
    timedOut: Boolean(tree.timedOut),
    deeper: tree.tooDeep.length,
    problems: tree.problems,
    markdown: lines.join('\n'),
  };
}

export const gdriveFolderTree = registerTool({
  id: 'gdrive.folder_tree',
  description:
    'See the STRUCTURE of a Google Drive folder in a few seconds, without opening any document: how many subfolders each level has, how they are named, and — when names follow a pattern like "33. FEDEX 3325 07102026" — which pieces they carry (sequence number, name, code, date or month), so you know how to find a given folder (a flight, a client, a month) and where to save a document. With `includeFiles` it also counts the files sitting at each level by type (e.g. "manifiesto aerolinea (xlsx) x300"). Lists in parallel, reads only names and types, never file contents. Use it to understand the layout or to decide where something goes; use gdrive.find_folder to locate one specific folder by name/path; do NOT use trackers.propose_from_drive_folder for this (that one is only for creating a table from the documents). Accepts a folder link, id or exact name. Read-only.',
  inputSchema: z.object({
    folder: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .describe('Google Drive folder link, id or exact name.'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(6)
      .optional()
      .describe('Levels of subfolders to open below the folder (default 3).'),
    includeFiles: z
      .boolean()
      .optional()
      .describe(
        'Also count the files at each level by document type (default true). False = folders only.',
      ),
  }),
  outputSchema: z.object({
    folder: z.object({ id: z.string(), name: z.string() }),
    levels: z.array(z.record(z.unknown())),
    totalFolders: z.number().int(),
    totalFiles: z.number().int(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
    markdown: z.string(),
  }),
  requiredScopes: [{ provider: 'google', scopes: [DRIVE_READONLY] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const drive: DriveAccess = { integrations: ctx.integrations, signal: ctx.signal };
    const folder = await resolveFolder(drive, input.folder);
    const depth = input.depth ?? 3;
    const includeFiles = input.includeFiles ?? true;
    ctx.onProgress?.('Listando las carpetas…');
    const tree = await listFolderTree(drive, folder.id, {
      recursive: true,
      maxDepth: depth,
      maxFiles: INVENTORY_MAX_FILES * INVENTORY_LIST_FACTOR,
      light: true,
      deadline: Date.now() + FOLDER_TREE_BUDGET_MS,
      onProgress: ctx.onProgress,
    });
    const s = summarizeTree(tree, folder.name, {
      includeFiles,
      depth,
    });
    return {
      folder,
      levels: s.levels as unknown as Record<string, unknown>[],
      totalFolders: s.totalFolders,
      totalFiles: s.totalFiles,
      truncated: s.truncated,
      timedOut: s.timedOut,
      markdown: s.markdown,
    };
  },
});
