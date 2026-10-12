/**
 * LO QUE SALE DEL LECTOR DE CÓDIGOS — la parte pura.
 *
 * La cámara entrega un texto (`rawValue`) y, a veces, el formato. Antes de
 * ponerlo en un campo se limpia (los lectores meten caracteres de control y
 * espacios) y se decide qué es: un código NUEVO, el MISMO que la cámara sigue
 * viendo (se ignora, no suena dos veces) o un DUPLICADO (ya estaba en la lista
 * o en el formulario: suena distinto y se avisa, pero se deja a la persona decidir).
 */

/** El largo máximo de un texto corto de una tabla (TEXT_MAX de schema.ts). */
export const SCAN_MAX = 400;
/** La cámara ve el mismo código muchas veces por segundo: se ignora dentro de esta ventana. */
export const SCAN_DEBOUNCE_MS = 2500;

// Formatos de BarcodeDetector donde el código es sólo dígitos.
const NUMERIC_FORMATS = new Set(['ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf']);
// Formatos que sólo tienen mayúsculas: «ab-12» y «AB-12» son el mismo código.
const UPPER_FORMATS = new Set(['code_39', 'codabar']);

/**
 * Deja el código listo para guardar. Null = no sirve (vacío o larguísimo).
 *  - sin caracteres de control (GS, saltos, BOM) ni espacios en los extremos;
 *  - en formatos numéricos, sin espacios ni guiones; un UPC-A que el lector
 *    entrega como EAN-13 con un 0 delante vuelve a ser UPC-A;
 *  - en formatos de sólo mayúsculas, en mayúsculas.
 * Un QR (texto libre, enlaces) se respeta tal cual.
 */
export function normalizeScan(raw: unknown, format?: string | null): string | null {
  if (typeof raw !== 'string') return null;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: se quitan a propósito
  let code = raw.replace(/[\u0000-\u001f\u007f﻿]/g, '').trim();
  if (!code) return null;
  const f = (format ?? '').toLowerCase();
  if (NUMERIC_FORMATS.has(f)) {
    const digits = code.replace(/[\s-]/g, '');
    if (/^\d+$/.test(digits)) code = digits;
    if (f === 'upc_a' && code.length === 13 && code.startsWith('0')) code = code.slice(1);
  } else if (UPPER_FORMATS.has(f)) {
    code = code.toUpperCase();
  }
  return code.length > SCAN_MAX ? null : code;
}

export interface ScanEntry {
  code: string;
  /** Cuándo se aceptó esta lectura (ms). */
  at: number;
  /** La última vez que la cámara lo vio (ms): el rebote se mide desde aquí. */
  lastAt: number;
  /** Ya estaba antes de empezar a escanear, o se leyó otra vez más tarde. */
  duplicate: boolean;
}

export type ScanStatus = 'new' | 'duplicate' | 'ignored' | 'invalid';

export interface ScanResult {
  list: ScanEntry[];
  status: ScanStatus;
  code: string | null;
}

/**
 * Registra una lectura en la lista del escaneo continuo.
 *  - `ignored`: el mismo código dentro de la ventana de rebote (la cámara sigue
 *    apuntando a la misma etiqueta). No suma ni suena; mientras la cámara siga
 *    viéndolo, la ventana se renueva, así que hay que apartar la cámara.
 *  - `duplicate`: ya estaba en `existing` (lo que el formulario ya tenía) o se
 *    leyó antes en esta sesión y pasó la ventana. SUMA a la lista (la persona
 *    pudo tener dos cajas iguales) pero marcado, y suena distinto.
 *  - `new`: nunca visto.
 */
export function registerScan(
  list: ScanEntry[],
  raw: unknown,
  now: number,
  opts: { format?: string | null; existing?: Iterable<string>; debounceMs?: number } = {},
): ScanResult {
  const code = normalizeScan(raw, opts.format);
  if (!code) return { list, status: 'invalid', code: null };
  const debounce = opts.debounceMs ?? SCAN_DEBOUNCE_MS;
  const at = list.map((e) => e.code).lastIndexOf(code);
  const last = at >= 0 ? (list[at] as ScanEntry) : null;
  if (last && now - last.lastAt < debounce) {
    return {
      list: list.map((e, i) => (i === at ? { ...e, lastAt: now } : e)),
      status: 'ignored',
      code,
    };
  }
  const seenBefore = Boolean(last) || new Set(opts.existing ?? []).has(code);
  const entry: ScanEntry = { code, at: now, lastAt: now, duplicate: seenBefore };
  return { list: [...list, entry], status: seenBefore ? 'duplicate' : 'new', code };
}

/** Los códigos de un campo de varias líneas (uno por línea, sin vacíos). */
export function scanLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** El valor de un campo largo con estos códigos, uno por línea. */
export function joinScanLines(codes: string[]): string {
  return codes.join('\n');
}

/** Cuántos códigos repetidos hay en una lista de líneas (para «2 repetidos»). */
export function countRepeats(codes: string[]): number {
  return codes.length - new Set(codes).size;
}

export type FeedbackKind = 'ok' | 'duplicate' | 'error';

/** Patrón de vibración y tonos (Hz, ms) de cada resultado: lo distinto se oye y se siente. */
export function feedbackPlan(kind: FeedbackKind): {
  vibrate: number[];
  tones: Array<{ hz: number; ms: number }>;
} {
  switch (kind) {
    case 'ok':
      return { vibrate: [60], tones: [{ hz: 1500, ms: 90 }] };
    case 'duplicate':
      return {
        vibrate: [90, 70, 90],
        tones: [
          { hz: 600, ms: 110 },
          { hz: 450, ms: 160 },
        ],
      };
    case 'error':
      return { vibrate: [200], tones: [{ hz: 220, ms: 220 }] };
  }
}
