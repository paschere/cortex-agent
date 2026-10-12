/**
 * EL NAVEGADOR EN VIVO, CONTADO PASO A PASO.
 *
 * Funciones puras sobre las invocaciones que el chat ya tiene (nombre de la
 * herramienta, argumentos, resultado). Nada nuevo viaja por la red: cada acto
 * de la pestaña se redacta como una frase («Abrí dian.gov.co», «Hice clic en
 * “Consultar”») y de las mismas invocaciones sale cuál es la pestaña viva.
 *
 * Sin dependencias a propósito: lo importa un componente del navegador.
 */

export interface StepInvocation {
  toolCallId: string;
  toolName: string;
  state: string;
  args?: unknown;
  result?: unknown;
}

export type BrowserStepStatus = 'ok' | 'error' | 'waiting' | 'running';

export interface BrowserStep {
  id: string;
  tool: string;
  sessionId: string | null;
  status: BrowserStepStatus;
  /** La frase del paso según su estado: «Abrí…», «Abriendo…» o «No pude…». */
  sentence: string;
  /** Lo que Cortex está haciendo ahora mismo, para la línea de estado. */
  doing: string;
  /** Una foto de la página si el resultado trajo una. */
  thumb: string | null;
  /** Este paso espera algo de la persona (control, clave, código). */
  needsPerson: boolean;
  /** Milisegundos de época en que la pantalla vio el paso por primera vez. */
  at?: number;
}

export interface LiveSessionRef {
  sessionId: string;
  checkpointId?: string;
  ask?: string;
  fills?: string | null;
  /** Para la maqueta de desarrollo: una pantalla fija en vez de la sesión real. */
  fixture?: LiveFixture;
}

export interface LiveFixture {
  frame: string;
  url: string;
  title: string;
  width?: number;
  height?: number;
  help?: string;
}

const BROWSER_TOOLS = new Set([
  'browser_open_page',
  'browser_act',
  'browser_read_page',
  'browser_ask_person',
  'browser_request_secret',
  'browser_close_page',
  'browser_run_flow',
  'browser_submit_flow',
  'browser_resume_flow',
]);

const norm = (toolName: string) => toolName.replaceAll('.', '_');

export function isBrowserTool(toolName: string): boolean {
  return BROWSER_TOOLS.has(norm(toolName));
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const quoted = (s: string) => (s ? `“${clip(s)}”` : '');

const THUMB_RE = /^(data:image\/(png|jpe?g|webp);base64,|https:\/\/|\/)/;

function thumbOf(result: unknown): string | null {
  const r = obj(result);
  const page = obj(r.page);
  for (const v of [r.screenshot, r.thumbnail, page.screenshot, page.thumbnail]) {
    if (typeof v === 'string' && THUMB_RE.test(v)) return v;
  }
  return null;
}

function errorOf(result: unknown): string | null {
  const r = obj(result);
  if ('__error' in r) return str(r.__error) || 'Falló';
  if (r.ok === false) return str(r.message) || 'No se pudo';
  return null;
}

/** [mientras ocurre, ya ocurrió, no se pudo] para cada gesto de browser.act. */
function actWords(args: Record<string, unknown>): [string, string, string] {
  const name = quoted(str(args.name));
  const action = str(args.action);
  const key = str(args.text);
  switch (action) {
    case 'click':
      return [
        `haciendo clic en ${name || 'un elemento'}`,
        `Hice clic en ${name || 'un elemento'}`,
        `hacer clic en ${name || 'un elemento'}`,
      ];
    case 'fill': {
      const field = name ? `el campo ${name}` : 'un campo';
      return [`escribiendo en ${field}`, `Escribí en ${field}`, `escribir en ${field}`];
    }
    case 'select':
      return [
        `eligiendo una opción en ${name || 'la lista'}`,
        `Elegí una opción en ${name || 'la lista'}`,
        `elegir la opción en ${name || 'la lista'}`,
      ];
    case 'check':
      return [
        `marcando ${name || 'la casilla'}`,
        `Marqué ${name || 'la casilla'}`,
        `marcar ${name || 'la casilla'}`,
      ];
    case 'press':
      return [
        `presionando ${key || 'una tecla'}`,
        `Presioné ${key || 'una tecla'}`,
        `presionar ${key || 'una tecla'}`,
      ];
    case 'goto': {
      const host = hostOf(str(args.url));
      const to = host || 'otra página';
      return [`yendo a ${to}`, `Fui a ${to}`, `ir a ${to}`];
    }
    case 'wait':
      return ['esperando que cargue', 'Esperé a que cargara la página', 'esperar la página'];
    case 'scroll': {
      const down = Number(args.scrollY ?? 800) >= 0;
      return down
        ? ['bajando la página', 'Bajé la página', 'bajar la página']
        : ['subiendo la página', 'Subí la página', 'subir la página'];
    }
    case 'select_text':
      return ['seleccionando texto', 'Seleccioné un texto', 'seleccionar el texto'];
    case 'copy':
    case 'copy_selection':
      return ['copiando un texto', 'Copié un texto', 'copiar el texto'];
    case 'paste':
      return ['pegando un texto', 'Pegué un texto', 'pegar el texto'];
    default:
      return ['dando un paso en la página', 'Di un paso en la página', 'dar el paso'];
  }
}

function pageSummary(result: unknown): string {
  const r = obj(result);
  const title = str(obj(r.page).title);
  const chars = Number(obj(r.content).totalCharacters);
  if (title) return ` «${clip(title, 50)}»`;
  if (Number.isFinite(chars) && chars > 0)
    return ` (${new Intl.NumberFormat('es-CO').format(chars)} caracteres)`;
  return '';
}

/** `null` si la invocación no es de la pestaña viva ni de un trámite. */
export function summarizeBrowserStep(inv: StepInvocation): BrowserStep | null {
  const tool = norm(inv.toolName);
  if (!BROWSER_TOOLS.has(tool)) return null;
  const args = obj(inv.args);
  const result = obj(inv.result);
  const done = inv.state === 'result';
  const waitingOk = done && result.__requires_confirmation === true;
  const failure = done && !waitingOk ? errorOf(inv.result) : null;
  const status: BrowserStepStatus = !done
    ? 'running'
    : waitingOk
      ? 'waiting'
      : failure
        ? 'error'
        : 'ok';
  const handoff = obj(result.handoff);
  const sessionId = str(args.sessionId) || str(result.sessionId) || str(handoff.sessionId) || null;
  const thumb = done ? thumbOf(inv.result) : null;
  let needsPerson = false;
  let doing = '';
  let ok = '';
  let fail = '';

  switch (tool) {
    case 'browser_open_page': {
      const host = hostOf(str(args.url)) || 'el sitio';
      doing = `abriendo ${host}`;
      ok = `Abrí ${host}`;
      fail = `No pude abrir ${host}`;
      if (waitingOk) ok = `Esperando tu OK para abrir ${host}`;
      break;
    }
    case 'browser_act':
      [doing, ok, fail] = actWords(args);
      fail = `No pude ${fail}`;
      break;
    case 'browser_read_page':
      doing = 'leyendo la página';
      ok = `Leí la página${pageSummary(inv.result)}`;
      fail = 'No pude leer la página';
      break;
    case 'browser_ask_person': {
      const why = str(args.reason) || str(result.reason);
      needsPerson = true;
      doing = 'esperando tu ayuda en la pantalla';
      ok = why ? `Esperando tu ayuda: ${clip(why, 90)}` : 'Esperando tu ayuda en la pantalla';
      fail = 'No pude pedirte el control';
      break;
    }
    case 'browser_request_secret': {
      const label = str(args.label) || str(result.label);
      needsPerson = true;
      doing = 'esperando tu clave';
      ok = label ? `Esperando: ${clip(label, 90)}` : 'Esperando tu clave';
      fail = 'No pude pedirte la clave';
      break;
    }
    case 'browser_close_page':
      doing = 'cerrando la pestaña';
      ok = 'Cerré la pestaña';
      fail = 'No pude cerrar la pestaña';
      break;
    default: {
      const flow = typeof args.flow === 'string' ? args.flow.trim() : '';
      const verb =
        tool === 'browser_submit_flow'
          ? 'Radiqué'
          : tool === 'browser_resume_flow'
            ? 'Retomé'
            : 'Corrí';
      const what = flow && !/^[0-9a-f-]{20,}$/i.test(flow) ? ` «${clip(flow, 40)}»` : '';
      doing =
        tool === 'browser_submit_flow'
          ? `radicando el trámite${what}`
          : tool === 'browser_resume_flow'
            ? `retomando el trámite${what}`
            : `haciendo el trámite${what}`;
      ok = `${verb} el trámite${what}`;
      fail = `El trámite${what} falló`;
      if (handoff.sessionId || obj(result.checkpoint).id) {
        needsPerson = true;
        const ask = str(handoff.ask);
        ok = ask ? `El trámite pide tu ayuda: ${clip(ask, 90)}` : `${ok} y espera tu ayuda`;
      }
    }
  }

  const sentence =
    status === 'running'
      ? `${doing.charAt(0).toUpperCase()}${doing.slice(1)}…`
      : status === 'error'
        ? `${fail}${failure && !/^(Falló|No se pudo)$/.test(failure) ? `: ${clip(failure, 100)}` : ''}`
        : ok;
  return {
    id: inv.toolCallId,
    tool,
    sessionId,
    status,
    sentence,
    doing: `Cortex está ${doing}…`,
    thumb,
    needsPerson: needsPerson && status === 'ok',
  };
}

export function browserSteps(invocations: readonly StepInvocation[]): BrowserStep[] {
  const out: BrowserStep[] = [];
  for (const inv of invocations) {
    const s = summarizeBrowserStep(inv);
    if (s) out.push(s);
  }
  return out;
}

/** La última pestaña viva que nombran las invocaciones y que nadie cerró. */
export function liveSessionOf(invocations: readonly StepInvocation[]): LiveSessionRef | null {
  let current: LiveSessionRef | null = null;
  for (const inv of invocations) {
    const tool = norm(inv.toolName);
    if (!BROWSER_TOOLS.has(tool) || inv.state !== 'result') continue;
    const r = obj(inv.result);
    if ('__error' in r || r.__requires_confirmation === true) continue;
    if (tool === 'browser_close_page') {
      const id = str(obj(inv.args).sessionId);
      if (!current || !id || id === current.sessionId) current = null;
      continue;
    }
    if (typeof r.sessionId === 'string' && r.sessionId && tool === 'browser_open_page') {
      current = { sessionId: r.sessionId };
      continue;
    }
    const h = obj(r.handoff);
    if (typeof h.sessionId === 'string' && h.sessionId) {
      const cp = obj(r.checkpoint);
      current = {
        sessionId: h.sessionId,
        ...(typeof cp.id === 'string' ? { checkpointId: cp.id } : {}),
        ...(typeof h.ask === 'string' ? { ask: h.ask } : {}),
        fills: typeof h.fills === 'string' ? h.fills : null,
      };
    }
  }
  return current;
}
