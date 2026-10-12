/**
 * «ARCHIVOS DE LA TAREA»: TODO LO QUE SE PRODUJO DURANTE UNA TAREA O CONVERSACIÓN.
 *
 * No hay una tabla única de «archivos producidos»: cada herramienta guarda lo
 * suyo donde le tocó —presentaciones en `presentation_files`, informes en
 * `reports`, lo que baja un trámite del navegador en `kb_documents`— o deja un
 * enlace de descarga en el texto de la respuesta (un CSV, un Excel, un PDF).
 * Este módulo es la parte pura de juntarlos: normaliza cada fuente a una misma
 * forma, quita repetidos y ordena. Las consultas viven en `files-load.ts`.
 *
 * ATRIBUCIÓN. Un informe lleva `conversation_id` (exacto). Presentaciones y
 * documentos de trámite no: se atribuyen por QUIÉN los creó y CUÁNDO, dentro de
 * la ventana de la conversación o de la tarea. Dos conversaciones de la misma
 * persona trabajando a la vez pueden compartir un archivo en la lista; es el
 * costo de no tocar cada herramienta, y se prefiere a perder archivos.
 */

export const FILE_KINDS = [
  'pdf',
  'sheet',
  'doc',
  'slides',
  'csv',
  'image',
  'html',
  'other',
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_KIND_LABEL: Record<FileKind, string> = {
  pdf: 'PDF',
  sheet: 'Excel',
  doc: 'Documento',
  slides: 'Presentación',
  csv: 'CSV',
  image: 'Imagen',
  html: 'Informe',
  other: 'Archivo',
};

export type FileSource = 'presentation' | 'report' | 'document' | 'link';

export interface TaskFile {
  /** Estable: `${source}:${id}`. */
  id: string;
  source: FileSource;
  name: string;
  kind: FileKind;
  mime: string | null;
  sizeBytes: number | null;
  createdAt: string;
  /** A dónde ir para verlo o bajarlo. Ruta interna o https. */
  href: string;
  /** Se abre en otra pestaña (un enlace de fuera de la app). */
  external: boolean;
  /** Se puede subir a Drive con `gdrive.upload_file` (exige una URL firmada de /api/files/blob). */
  driveable: boolean;
}

const EXT_KIND: Record<string, FileKind> = {
  pdf: 'pdf',
  xlsx: 'sheet',
  xls: 'sheet',
  ods: 'sheet',
  csv: 'csv',
  tsv: 'csv',
  doc: 'doc',
  docx: 'doc',
  odt: 'doc',
  txt: 'doc',
  md: 'doc',
  ppt: 'slides',
  pptx: 'slides',
  key: 'slides',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  svg: 'image',
  html: 'html',
  htm: 'html',
};

const MIME_KIND: Array<[RegExp, FileKind]> = [
  [/pdf/i, 'pdf'],
  [/spreadsheet|excel/i, 'sheet'],
  [/csv/i, 'csv'],
  [/presentation|powerpoint/i, 'slides'],
  [/wordprocessing|msword|opendocument\.text|text\/plain|markdown/i, 'doc'],
  [/^image\//i, 'image'],
  [/html/i, 'html'],
];

export function extensionOf(name: string): string {
  const clean = name.split(/[?#]/)[0] ?? name;
  const dot = clean.lastIndexOf('.');
  return dot < 0 ? '' : clean.slice(dot + 1).toLowerCase();
}

export function fileKindOf(name: string, mime?: string | null): FileKind {
  const byExt = EXT_KIND[extensionOf(name)];
  if (byExt) return byExt;
  if (mime) for (const [re, kind] of MIME_KIND) if (re.test(mime)) return kind;
  return 'other';
}

/** «84 KB», «1,2 MB». */
export function humanSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1).replace('.', ',') : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1).replace('.', ',') : Math.round(mb)} MB`;
}

// ---------------------------------------------------------------------------
// Ventana de tiempo
// ---------------------------------------------------------------------------

/** Un poco de holgura: una presentación se guarda segundos después del mensaje del usuario. */
const PAD_BEFORE_MS = 5_000;
const PAD_AFTER_MS = 2 * 60_000;

export function windowFor(input: {
  from: string | null;
  to: string | null;
  now: Date;
}): { from: string; to: string } | null {
  if (!input.from) return null;
  const start = new Date(input.from).getTime();
  if (!Number.isFinite(start)) return null;
  const endRaw = input.to ? new Date(input.to).getTime() : input.now.getTime();
  const end = Number.isFinite(endRaw) ? Math.max(endRaw, start) : input.now.getTime();
  return {
    from: new Date(start - PAD_BEFORE_MS).toISOString(),
    to: new Date(end + PAD_AFTER_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Normalizadores por fuente
// ---------------------------------------------------------------------------

export interface PresentationRow {
  token: string;
  filename: string;
  size_bytes: number | null;
  created_at: string;
  expires_at: string;
}

export function fromPresentation(row: PresentationRow, now: Date): TaskFile | null {
  // Un enlace vencido ya no baja nada: no se lista como si sirviera.
  if (new Date(row.expires_at).getTime() <= now.getTime()) return null;
  return {
    id: `presentation:${row.token}`,
    source: 'presentation',
    name: row.filename,
    kind: fileKindOf(row.filename, 'application/pdf'),
    mime: 'application/pdf',
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    href: `/api/files/presentation/${row.token}`,
    external: false,
    // gdrive.upload_file sólo lee archivos con URL firmada de /api/files/blob.
    driveable: false,
  };
}

export interface ReportRow {
  id: string;
  title: string;
  generated_at: string;
}

export function fromReport(row: ReportRow): TaskFile {
  return {
    id: `report:${row.id}`,
    source: 'report',
    name: row.title,
    kind: 'html',
    mime: 'text/html',
    sizeBytes: null,
    createdAt: row.generated_at,
    href: `/reports/${row.id}`,
    external: false,
    driveable: false,
  };
}

export interface DocumentRow {
  id: string;
  title: string;
  mime: string | null;
  created_at: string;
  /** Ya con la URL firmada de corta vida, o nulo si no se pudo firmar. */
  downloadHref: string | null;
  sizeBytes: number | null;
}

export function fromDocument(row: DocumentRow): TaskFile | null {
  if (!row.downloadHref) return null;
  return {
    id: `document:${row.id}`,
    source: 'document',
    name: row.title,
    kind: fileKindOf(row.title, row.mime),
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    createdAt: row.created_at,
    href: row.downloadHref,
    external: false,
    driveable: row.downloadHref.startsWith('/api/files/blob/'),
  };
}

// ---------------------------------------------------------------------------
// Enlaces de descarga en el texto de la respuesta
// ---------------------------------------------------------------------------

const MD_LINK = /\[([^\]\n]{1,200})\]\((\S+?)\)/g;
const DOWNLOADABLE_EXT = new Set([
  'pdf',
  'xlsx',
  'xls',
  'csv',
  'docx',
  'doc',
  'pptx',
  'ppt',
  'zip',
]);

function internalPath(url: string, origin?: string): string | null {
  if (url.startsWith('/') && !url.startsWith('//')) return url;
  if (origin && url.startsWith(origin)) {
    const rest = url.slice(origin.length);
    return rest.startsWith('/') ? rest : null;
  }
  return null;
}

/**
 * Los enlaces de descarga que Cortex dejó escritos: los de este sitio
 * (`/api/files/...`) y los https que terminan en una extensión de documento.
 * Cada uno se lista una vez.
 */
export function filesFromText(
  text: string,
  at: string,
  opts: { origin?: string } = {},
): TaskFile[] {
  const out: TaskFile[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(MD_LINK)) {
    const label = (m[1] ?? '').trim();
    const url = (m[2] ?? '').replace(/[)>.,;]+$/, '');
    if (!url) continue;
    const internal = internalPath(url, opts.origin);
    const isFileRoute = internal?.startsWith('/api/files/') ?? false;
    const ext = extensionOf(internal ?? url);
    const looksLikeFile = DOWNLOADABLE_EXT.has(ext);
    const https = /^https:\/\//i.test(url);
    if (!isFileRoute && !(looksLikeFile && (internal || https))) continue;
    // Las rutas de presentaciones e informes ya salen de sus tablas, con nombre y tamaño.
    if (
      internal?.startsWith('/api/files/presentation/') ||
      internal?.startsWith('/api/files/report/')
    )
      continue;
    const href = internal ?? url;
    if (seen.has(href)) continue;
    seen.add(href);
    const name = label || href.split('/').pop() || 'archivo';
    out.push({
      id: `link:${href}`,
      source: 'link',
      name,
      kind: fileKindOf(looksLikeFile ? `x.${ext}` : name),
      mime: null,
      sizeBytes: null,
      createdAt: at,
      href,
      external: !internal,
      driveable: false,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Juntar
// ---------------------------------------------------------------------------

/** Quita repetidos (mismo id o mismo href) y deja lo más reciente primero. */
export function collectFiles(
  ...lists: Array<ReadonlyArray<TaskFile | null | undefined>>
): TaskFile[] {
  const byId = new Map<string, TaskFile>();
  const hrefs = new Set<string>();
  for (const list of lists) {
    for (const f of list) {
      if (!f) continue;
      if (byId.has(f.id) || hrefs.has(f.href)) continue;
      byId.set(f.id, f);
      hrefs.add(f.href);
    }
  }
  return [...byId.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** El mensaje que se escribe en el chat para subir un archivo a Drive (pide confirmación como siempre). */
export function driveUploadPrompt(
  file: Pick<TaskFile, 'name' | 'href' | 'mime' | 'sizeBytes'>,
): string {
  const ref = JSON.stringify({
    url: file.href,
    name: file.name,
    mime: file.mime ?? 'application/octet-stream',
    size: file.sizeBytes ?? 0,
  });
  return `Guarda en mi Drive el archivo «${file.name}». Busca la carpeta adecuada con gdrive.find_folder, dime cuál usarías y súbelo con gdrive.upload_file cuando yo lo apruebe. El archivo es: ${ref}`;
}
