import { type BrowserStep, isBrowserTool, summarizeBrowserStep } from '@/lib/browser-live-steps';
import { type PlanInvocation, planFromInvocations } from '@/lib/plan-state';
import { toolDisplayName } from '@/lib/tool-labels';

/**
 * LA REPETICIÓN COMPARTIDA DE UNA TAREA — la parte pura (sin base de datos).
 *
 * Un enlace público muestra, de sólo lectura, el plan, la línea de pasos con sus
 * frases, las capturas y la respuesta final de UNA tarea. Todo sale de una FOTO
 * depurada que se toma al compartir (`buildSnapshot`); la página pública nunca
 * lee la conversación en vivo, así que nada de lo que se diga después en ella
 * puede colarse. La foto NUNCA lleva: argumentos de herramientas, resultados
 * crudos, claves, ni mensajes que no sean los de la tarea.
 */

export const SHARE_DEFAULT_DAYS = 7;
export const SHARE_MAX_DAYS = 30;
export const SHARE_MAX_ACTIVE_PER_TASK = 10;
export const SHARE_MAX_SHOTS = 40;
export const SHARE_MAX_SHOT_BYTES = 150_000;
export const SHARE_MAX_STEPS = 150;

// ---------------------------------------------------------------------------
// Enlace: token, caducidad, estado
// ---------------------------------------------------------------------------

/** 24 bytes al azar = 192 bits; 32 caracteres base64url. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function clampShareDays(raw: unknown): number {
  const n = typeof raw === 'number' ? Math.floor(raw) : Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return SHARE_DEFAULT_DAYS;
  return Math.min(n, SHARE_MAX_DAYS);
}

export function shareExpiry(now: Date, days: unknown): Date {
  return new Date(now.getTime() + clampShareDays(days) * 86_400_000);
}

export type ShareState = 'active' | 'expired' | 'revoked';

export function shareState(
  share: { expiresAt: string | Date; revokedAt: string | Date | null },
  now: Date,
): ShareState {
  if (share.revokedAt) return 'revoked';
  const exp = share.expiresAt instanceof Date ? share.expiresAt : new Date(share.expiresAt);
  if (Number.isNaN(exp.getTime()) || exp.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

/** Quién puede compartir / revocar: la dueña de la tarea o quien administra. */
export function canShareTask(
  viewer: { id: string; isManager: boolean },
  task: { userId: string },
): boolean {
  return viewer.isManager || viewer.id === task.userId;
}

export function canRevokeShare(
  viewer: { id: string; isManager: boolean },
  share: { createdBy: string },
  task: { userId: string },
): boolean {
  return viewer.isManager || viewer.id === share.createdBy || viewer.id === task.userId;
}

// ---------------------------------------------------------------------------
// Depuración del texto
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [oculto]'],
  [/\b(?:sk|pk|rk|xox[abp]|ghp|gho|ghs|AIza)[-_A-Za-z0-9]{16,}/g, '[clave oculta]'],
  [
    /\b(api[_ -]?key|token|secret|password|passwd|contraseña|clave|pin|otp|código)\b(\s*(?:es|:|=)\s*)(?!\[)[^\s,;)"']{3,}/gi,
    '$1$2[oculto]',
  ],
  [
    /([?&](?:token|key|sig|signature|access_token|apikey|api_key|code|auth)=)[^&\s)"']+/gi,
    '$1[oculto]',
  ],
  // Números de tarjeta (13-19 dígitos, con espacios o guiones).
  [/\b(?:\d[ -]?){13,19}\b/g, '[número oculto]'],
  // Cadenas largas de hex/base64: casi siempre una clave o un hash.
  [/\b[A-Fa-f0-9]{32,}\b/g, '[clave oculta]'],
  [/\b[A-Za-z0-9_-]{40,}\b/g, '[clave oculta]'],
];

const PERSONAL_PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[correo oculto]'],
  // NIT con puntos y guion: 900.123.456-7 / 900123456-7.
  [/\b\d{1,3}(?:\.\d{3}){2}-\d\b/g, '[NIT oculto]'],
  [/\b\d{9,10}-\d\b/g, '[NIT oculto]'],
  [/\b(NIT\.?\s*(?:No\.?|#|:)?\s*)\d[\d.\-]{5,}\d/gi, '$1[NIT oculto]'],
  [
    /\b((?:C\.?C\.?|cédula|cedula|documento)\s*(?:No\.?|#|:)?\s*)\d[\d.]{5,}\d/gi,
    '$1[documento oculto]',
  ],
  // Teléfonos: internacional (+57 300 123 4567) y celular colombiano.
  [/\+\d{1,3}[\s.-]?\(?\d{1,4}\)?(?:[\s.-]?\d{2,4}){2,4}/g, '[teléfono oculto]'],
  [/\b3\d{2}[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '[teléfono oculto]'],
];

/** Quita claves siempre y, si se pide, también datos personales (correos, teléfonos, NIT). */
export function redactText(text: string, opts: { personal: boolean }): string {
  let out = text;
  // Los correos y NIT primero: el patrón de tarjetas no debe comerse un NIT.
  if (opts.personal) for (const [re, to] of PERSONAL_PATTERNS) out = out.replace(re, to);
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

const SENSITIVE_TOOL_RE =
  /secret|password|passwd|credential|token|vault|apikey|api_key|oauth|clave/i;

export function isSensitiveTool(toolName: string): boolean {
  return SENSITIVE_TOOL_RE.test(toolName);
}

// ---------------------------------------------------------------------------
// La foto
// ---------------------------------------------------------------------------

export interface ReplayInvocation extends PlanInvocation {
  args?: unknown;
}

export interface ReplayStep {
  id: string;
  sentence: string;
  status: 'ok' | 'error' | 'waiting';
  kind: 'browser' | 'tool';
  /** Clave de la captura guardada con el enlace, si hay. */
  shot: string | null;
}

export interface ReplayPlan {
  title: string;
  steps: Array<{ label: string; status: string; note?: string }>;
}

export interface ReplaySnapshot {
  version: 1;
  title: string;
  request: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  companyName: string;
  ownerName: string | null;
  plan: ReplayPlan | null;
  steps: ReplayStep[];
  answer: string | null;
  hidePersonal: boolean;
}

export interface ShotRef {
  key: string;
  sessionId: string;
  shotId: string;
}

const SHOT_PATH = /^\/api\/browser\/live\/([A-Za-z0-9_-]{1,64})\/shot\/([A-Za-z0-9_-]{1,64})$/;

/** `/api/browser/live/<sesión>/shot/<foto>` → sus dos ids; cualquier otra cosa, null. */
export function parseShotPath(thumb: string | null): { sessionId: string; shotId: string } | null {
  if (!thumb) return null;
  const m = SHOT_PATH.exec(thumb.split('?')[0] ?? '');
  return m ? { sessionId: m[1] as string, shotId: m[2] as string } : null;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function stateOf(inv: ReplayInvocation): ReplayStep['status'] | 'running' {
  if (inv.state !== 'result') return 'running';
  const r = inv.result;
  if (r && typeof r === 'object') {
    const o = r as Record<string, unknown>;
    if ('__error' in o || o.ok === false) return 'error';
    if (o.__requires_confirmation === true) return 'waiting';
  }
  return 'ok';
}

const PLAN_TOOLS = new Set(['cortex_plan', 'cortex_plan_update']);

export interface BuildSnapshotInput {
  title: string;
  request: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  companyName: string;
  ownerName: string | null;
  answer: string | null;
  invocations: readonly ReplayInvocation[];
  hidePersonal: boolean;
  includeShots: boolean;
}

/**
 * La foto depurada + la lista de capturas a copiar. Pura: la misma entrada da la
 * misma foto, y lo que no se nombra aquí no sale en el enlace.
 */
export function buildSnapshot(input: BuildSnapshotInput): {
  snapshot: ReplaySnapshot;
  shots: ShotRef[];
} {
  const personal = input.hidePersonal;
  const clean = (s: string, n: number) => clip(redactText(s, { personal }), n);
  const steps: ReplayStep[] = [];
  const shots: ShotRef[] = [];

  for (const inv of input.invocations) {
    if (steps.length >= SHARE_MAX_STEPS) break;
    const name = inv.toolName.replaceAll('.', '_');
    if (PLAN_TOOLS.has(name)) continue;
    const state = stateOf(inv);
    if (state === 'running') continue;

    if (isBrowserTool(name)) {
      const b: BrowserStep | null = summarizeBrowserStep(inv);
      if (!b) continue;
      const askedPerson = name === 'browser_ask_person' || name === 'browser_request_secret';
      const sentence =
        name === 'browser_request_secret'
          ? 'Pidió una clave a la persona'
          : state === 'error'
            ? 'Un paso en la página no se pudo completar'
            : b.sentence;
      let shot: string | null = null;
      const ref = !askedPerson && input.includeShots ? parseShotPath(b.thumb) : null;
      if (ref && shots.length < SHARE_MAX_SHOTS) {
        shot = `p${shots.length}`;
        shots.push({ key: shot, ...ref });
      }
      steps.push({
        id: inv.toolCallId,
        sentence: clean(sentence, 160),
        status: state,
        kind: 'browser',
        shot,
      });
      continue;
    }

    const sentence = isSensitiveTool(name)
      ? 'Usó una credencial protegida'
      : state === 'error'
        ? `${toolDisplayName(inv.toolName)}: no se pudo completar`
        : state === 'waiting'
          ? `${toolDisplayName(inv.toolName)}: esperó el visto bueno`
          : toolDisplayName(inv.toolName);
    steps.push({
      id: inv.toolCallId,
      sentence: clean(sentence, 160),
      status: state,
      kind: 'tool',
      shot: null,
    });
  }

  const planState = planFromInvocations(input.invocations);
  const plan: ReplayPlan | null = planState
    ? {
        title: clean(planState.title, 90),
        steps: planState.steps.slice(0, 30).map((s) => ({
          label: clean(s.label, 120),
          status: s.status,
          ...(s.note ? { note: clean(s.note, 160) } : {}),
        })),
      }
    : null;

  return {
    snapshot: {
      version: 1,
      title: clean(input.title, 120),
      request: clean(input.request.replace(/\s+/g, ' ').trim(), 400),
      status: input.status,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      companyName: input.companyName,
      ownerName: input.ownerName,
      plan,
      steps,
      answer: input.answer ? clean(input.answer, 20_000) : null,
      hidePersonal: personal,
    },
    shots,
  };
}

/** Lee una foto guardada con desconfianza (es jsonb). */
export function parseSnapshot(value: unknown): ReplaySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Partial<ReplaySnapshot>;
  if (v.version !== 1 || typeof v.title !== 'string' || !Array.isArray(v.steps)) return null;
  return v as ReplaySnapshot;
}
