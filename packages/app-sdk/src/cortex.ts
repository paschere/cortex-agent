import { SLOW_BRIDGE_TIMEOUT_MS, call } from './bridge';
import type {
  ActionResult,
  ConfirmOptions,
  PickOptions,
  QueryOptions,
  ScanOptions,
  ScanResult,
  SdkAction,
  SdkField,
  SdkGeofence,
  SdkLocation,
  SdkPosition,
  SdkRow,
  SdkTable,
  SdkUser,
  UploadOptions,
  UploadResult,
} from './types';

/**
 * `cortex`: todas las operaciones como promesas. Se agrupan igual que en el
 * servidor (`tables.query` ↔ op `tables.query`). Las de `nav` y `ui` las
 * resuelve el propio host sin ir al servidor.
 */
export const cortex = {
  user: {
    /** Quién está usando la pantalla, con su rol y atributos. */
    me: () => call<SdkUser>('user.me'),
  },
  tables: {
    /** Las tablas que el rol puede leer, con sus campos. */
    list: () => call<SdkTable[]>('tables.list'),
    query: (table: string, opts: QueryOptions = {}) =>
      call<{ rows: SdkRow[]; fields?: SdkField[]; total?: number }>('tables.query', {
        table,
        ...opts,
      }),
    get: (table: string, id: string) => call<SdkRow>('tables.get', { table, id }),
    insert: (table: string, values: Record<string, unknown>) =>
      call<SdkRow>('tables.insert', { table, values }),
    update: (table: string, id: string, values: Record<string, unknown>) =>
      call<SdkRow>('tables.update', { table, id, values }),
    /**
     * Corre el botón de flujo con esa clave (`'tomar'`, `'cerrar'`, `'aprobar'`, `'rechazar'`…)
     * sobre una fila, igual que en las pantallas de bloques: mismo rol, mismos efectos y
     * mismas reglas. `reason` es el motivo (por ejemplo al rechazar).
     */
    action: (table: string, id: string, action: string, opts: { reason?: string } = {}) =>
      call<ActionResult>('tables.action', { table, id, action, reason: opts.reason }),
    /** Los botones de flujo de la tabla que el rol puede correr. */
    listActions: (table: string) => call<SdkAction[]>('tables.listActions', { table }),
  },
  files: {
    /**
     * Sube un archivo y lo AGREGA al campo de archivos de esa fila (respeta quién puede editar
     * ese campo). Las fotos se comprimen antes de subir. Pesa hasta 4 MB ya comprimido.
     */
    upload: (file: File | Blob, opts: UploadOptions) =>
      call<UploadResult>('files.upload', { ...opts, file }, { timeoutMs: SLOW_BRIDGE_TIMEOUT_MS }),
    /**
     * Abre el selector de archivos o la cámara y devuelve lo elegido (`[]` si se cancela).
     * Solo funciona dentro del navegador, y desde un toque de la persona (un botón).
     */
    pick: (opts: PickOptions = {}) => pickFiles(opts),
  },
  docs: {
    /**
     * Lee una foto o PDF (hasta 4 MB) con visión: devuelve los datos del encabezado y, si se
     * pide, un arreglo de renglones. Nada se guarda: la pantalla decide qué hacer con lo leído.
     */
    scan: (file: File | Blob, opts: ScanOptions = {}) =>
      call<ScanResult>('docs.scan', { ...opts, file }, { timeoutMs: SLOW_BRIDGE_TIMEOUT_MS }),
  },
  voice: {
    /** Pasa una grabación de voz a texto. */
    transcribe: (audio: Blob) =>
      call<{ text: string }>('voice.transcribe', { audio }, { timeoutMs: SLOW_BRIDGE_TIMEOUT_MS }),
  },
  location: {
    /**
     * La posición de quien usa la pantalla, con la zona de la app donde está. `null` si no hay
     * señal, no dio permiso o no aceptó compartir ubicación. La pide el marco de Cortex.
     */
    current: () => call<SdkPosition | null>('location.current'),
  },
  locations: {
    /** Última ubicación de cada persona (solo si el rol puede verlas). */
    live: () => call<SdkLocation[]>('locations.live'),
  },
  geofences: {
    list: () => call<SdkGeofence[]>('geofences.list'),
  },
  ai: {
    /** Pregunta corta al modelo rápido, con datos opcionales. Devuelve texto. */
    ask: (prompt: string, data?: unknown) => call<string>('ai.ask', { prompt, data }),
  },
  functions: {
    /** Función de servidor de la app (fase 2). */
    call: <T = unknown>(name: string, input?: unknown) =>
      call<T>('functions.call', { name, input }),
  },
  db: {
    /** SQL sobre la base propia de la app (fase 3). */
    query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      call<{ rows: T[] }>('db.query', { sql, params }),
  },
  nav: {
    /** Abre otra pantalla de la app, con campos prellenados si se quiere. */
    go: (target: { screen: string; prefill?: Record<string, string | number> }) =>
      call<void>('nav.go', target),
  },
  ui: {
    /** Muestra un aviso breve arriba del marco de la app. */
    toast: (text: string) => call<void>('ui.toast', { text }),
    /** Descarga un archivo (el marco lo hace: la pantalla no puede). `data` es un Blob o texto. */
    download: (filename: string, data: Blob | string, mime?: string) =>
      call<void>('ui.download', { filename, data, mime }),
    /** Pregunta «¿seguro?» con el diálogo de Cortex. `true` si la persona confirma. */
    confirm: (text: string, opts: ConfirmOptions = {}) =>
      call<boolean>('ui.confirm', { text, ...opts }),
  },
};

/** El selector de archivos de la propia pantalla (un `<input type=file>` que no se ve). */
function pickFiles(opts: PickOptions): Promise<File[]> {
  if (typeof document === 'undefined')
    return Promise.reject(new Error('El selector de archivos solo funciona en el navegador.'));
  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (opts.accept) input.accept = opts.accept;
    if (opts.capture) input.setAttribute('capture', opts.capture);
    if (opts.multiple) input.multiple = true;
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done(Array.from(input.files ?? [])));
    input.addEventListener('cancel', () => done([]));
    document.body.appendChild(input);
    input.click();
  });
}
