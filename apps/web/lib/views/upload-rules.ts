/**
 * REGLAS PURAS DE LA SUBIDA DE ARCHIVOS DE UN FORMULARIO (sin red ni base).
 * Las usan las dos rutas (/api/views/[id]/upload y /api/views/public/upload)
 * y el componente FileInput, para que el navegador rechace lo mismo que el
 * servidor antes de gastar datos móviles.
 */

export type FileAccept = 'image' | 'any';

export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const OTHER_MAX_BYTES = 20 * 1024 * 1024;
/** Subidas por hora y por vista en el enlace público. */
export const PUBLIC_UPLOADS_PER_HOUR = 200;
export const VIEW_FILES_BUCKET = 'view-files';

export const IMAGE_MIMES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

const DOC_MIMES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv',
  'text/plain': 'txt',
};

/** Algunos teléfonos mandan HEIC sin tipo o como octet-stream: se reconoce por la extensión. */
const EXT_MIMES: Record<string, string> = {
  heic: 'image/heic',
  heif: 'image/heif',
  csv: 'text/csv',
  txt: 'text/plain',
};

export function normalizeMime(mime: string, name = ''): string {
  const m = (mime.split(';')[0] ?? '').trim().toLowerCase();
  if (m && m !== 'application/octet-stream') return m === 'image/jpg' ? 'image/jpeg' : m;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return EXT_MIMES[ext] ?? m;
}

export function allowedMimes(accept: FileAccept): Record<string, string> {
  return accept === 'any' ? { ...IMAGE_MIMES, ...DOC_MIMES } : IMAGE_MIMES;
}

/** El atributo `accept` del <input type=file>. */
export function acceptAttribute(accept: FileAccept): string {
  return accept === 'any'
    ? `${Object.keys(allowedMimes('any')).join(',')},.heic,.heif,.csv,.txt`
    : 'image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif';
}

export type UploadCheck =
  | { ok: true; mime: string; ext: string; maxBytes: number }
  | { ok: false; error: string };

export function checkUpload(
  file: { name: string; type: string; size: number },
  accept: FileAccept,
): UploadCheck {
  if (!file.size) return { ok: false, error: 'El archivo está vacío.' };
  const mime = normalizeMime(file.type, file.name);
  const ext = allowedMimes(accept)[mime];
  if (!ext)
    return {
      ok: false,
      error:
        accept === 'any'
          ? 'Ese tipo de archivo no se acepta. Sube una foto, PDF, Word, Excel, CSV o texto.'
          : 'Sólo se aceptan fotos (JPG, PNG, WebP o HEIC).',
    };
  const maxBytes = mime in IMAGE_MIMES ? IMAGE_MAX_BYTES : OTHER_MAX_BYTES;
  if (file.size > maxBytes)
    return {
      ok: false,
      error: `El archivo pesa demasiado (máximo ${Math.round(maxBytes / 1024 / 1024)} MB).`,
    };
  return { ok: true, mime, ext, maxBytes };
}

export interface UploadFieldDef {
  key: string;
  type: string;
  accept?: FileAccept;
}

export type FormBlockLike = { id: string; type: string; fields?: string[] } | undefined;

/**
 * ¿Puede ESTE formulario recibir un archivo en ESTE campo? El bloque tiene que
 * ser un form de la vista, el campo uno de los que el bloque pide y de tipo
 * `file`. Devuelve el `accept` del campo (por defecto 'image').
 */
export function checkUploadTarget(
  block: FormBlockLike,
  fields: UploadFieldDef[],
  fieldKey: string,
): { ok: true; accept: FileAccept } | { ok: false; error: string } {
  if (!block || block.type !== 'form')
    return { ok: false, error: 'Ese formulario no está en esta vista.' };
  const allowed = block.fields?.length ? block.fields : fields.map((f) => f.key);
  const field = fields.find((f) => f.key === fieldKey);
  if (!field || !allowed.includes(fieldKey) || field.type !== 'file')
    return { ok: false, error: 'Ese campo no recibe archivos.' };
  return { ok: true, accept: field.accept === 'any' ? 'any' : 'image' };
}

export interface UploadedFile {
  url: string;
  name: string;
  mime: string;
  size: number;
}

/** Nombre de archivo mostrable: sin rutas ni caracteres de control, tope de largo. */
export function cleanFileName(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: se quitan a propósito
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[\u0000-\u001f]/g, '').trim();
  return (base || 'archivo').slice(0, 120);
}

/**
 * El valor de un campo `file` en la fila: un JSON {url,name,mime,size}, o un
 * arreglo de ellos si el campo es múltiple. Tolera un texto suelto con una URL
 * (datos escritos a mano o importados) y devuelve [] ante cualquier otra cosa.
 */
export function parseFileValue(value: string | null | undefined): UploadedFile[] {
  const raw = (value ?? '').trim();
  if (!raw) return [];
  if (/^(https?:\/\/|\/api\/)/.test(raw))
    return [{ url: raw, name: cleanFileName(raw.split('?')[0] ?? raw), mime: '', size: 0 }];
  try {
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.flatMap((it) => {
      if (!it || typeof it !== 'object') return [];
      const o = it as Record<string, unknown>;
      if (typeof o.url !== 'string' || !o.url) return [];
      return [
        {
          url: o.url,
          name: typeof o.name === 'string' && o.name ? o.name : 'archivo',
          mime: typeof o.mime === 'string' ? o.mime : '',
          size: typeof o.size === 'number' ? o.size : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}

export function serializeFileValue(files: UploadedFile[], multiple: boolean): string {
  if (!files.length) return '';
  return JSON.stringify(multiple ? files : files[0]);
}

export const MAX_FILES_PER_FIELD = 5;
