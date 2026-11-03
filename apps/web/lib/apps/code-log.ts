/**
 * EL REGISTRO DE UNA COMPILACIÓN → MARCAS EN EL EDITOR (apps con código, fase 4).
 *
 * Puro y sin dependencias (lo usa el componente del navegador; no importes
 * aquí nada de `@cortex/agent-tools`). Entiende los tres formatos que puede
 * traer el registro:
 *
 *   1. una línea: `screens/x.tsx:12:5: ERROR: No se pudo resolver "foo"`
 *   2. esbuild multilínea (formatMessages, sin color):
 *        ✘ [ERROR] Could not resolve "foo"
 *
 *            screens/x.tsx:12:5:
 *              12 │ import foo from "foo";
 *   3. tsc: `screens/x.tsx(12,5): error TS2304: Cannot find name 'x'.`
 */

export interface BuildDiagnostic {
  /** Ruta del archivo del proyecto, o null si el mensaje no dice dónde. */
  path: string | null;
  /** 1-based; 0 si no hay posición. */
  line: number;
  /** 1-based; 0 si no hay posición. */
  col: number;
  severity: 'error' | 'warning';
  message: string;
}

const sev = (s: string): 'error' | 'warning' => (/^warn/i.test(s) ? 'warning' : 'error');
const clean = (p: string) => p.replace(/^\.\//, '');

// `ruta.ext:12:5: ERROR: mensaje` | `ruta.ext:12:5:` (el mensaje viene de la línea ✘ anterior)
const POS_RE =
  /^\s*(?:[✘▲]\s*)?(\.{0,2}\/?[\w@./-]+\.[A-Za-z0-9]+):(\d+):(\d+):?\s*(?:\[?(ERROR|WARNING|error|warning)\]?:?\s*)?(.*)$/;
const HEAD_RE = /^\s*[✘▲X]?\s*\[(ERROR|WARNING)\]\s*(.*)$/i;
const TSC_RE = /^\s*([\w@./-]+\.[A-Za-z0-9]+)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+:\s*.*)$/i;

export function parseBuildDiagnostics(log: string): BuildDiagnostic[] {
  const out: BuildDiagnostic[] = [];
  const seen = new Set<string>();
  let pending: { severity: 'error' | 'warning'; message: string } | null = null;

  const push = (d: BuildDiagnostic) => {
    const key = `${d.path}|${d.line}|${d.col}|${d.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  };
  const flushPending = () => {
    // Un encabezado que nunca recibió posición sigue siendo un error del registro.
    if (pending) push({ path: null, line: 0, col: 0, ...pending });
    pending = null;
  };

  for (const line of log.split('\n')) {
    const tsc = TSC_RE.exec(line);
    if (tsc) {
      flushPending();
      push({
        path: clean(tsc[1] as string),
        line: Number(tsc[2]),
        col: Number(tsc[3]),
        severity: sev(tsc[4] as string),
        message: (tsc[5] as string).trim(),
      });
      continue;
    }
    const head = HEAD_RE.exec(line);
    if (head) {
      flushPending();
      pending = { severity: sev(head[1] as string), message: (head[2] as string).trim() };
      continue;
    }
    const pos = POS_RE.exec(line);
    if (pos) {
      const inline = (pos[5] as string).trim();
      const severity = pos[4] ? sev(pos[4]) : (pending?.severity ?? 'error');
      const message = inline || pending?.message || 'Error de compilación';
      pending = null;
      push({
        path: clean(pos[1] as string),
        line: Number(pos[2]),
        col: Number(pos[3]),
        severity,
        message,
      });
    }
  }
  flushPending();
  return out;
}

/** Las marcas de un archivo (las globales, sin ruta, no se pintan en el editor). */
export function diagnosticsFor(all: BuildDiagnostic[], path: string): BuildDiagnostic[] {
  return all.filter((d) => d.path === path && d.line > 0);
}
