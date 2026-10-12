import { z } from 'zod';

/**
 * FLUJOS POR ESTADO. Un campo de opciones («Estado») puede declarar un flujo:
 * los estados en orden, qué saltos se permiten, quién (qué roles de la app)
 * hace cada salto, qué hay que dejar para ENTRAR a un estado (campos, foto,
 * firma, comentario) y a quién se avisa al entrar.
 *
 * El flujo vive DENTRO de la definición del campo (JSON de `trackers.fields`):
 * no hay migración. Este módulo es PURO —sin base, sin reloj, sin red— para que
 * el servidor (que hace cumplir), las pantallas (que pintan el avance y los
 * botones) y el chat (que lo arma) hablen el mismo idioma. La historia de cada
 * salto sale de los eventos de edición que ya guardan quién, cuándo y de qué a
 * qué (`custom_view_events`), sin tabla nueva.
 *
 * Es general: nada de esto sabe de bodegas, guías ni empresas. «Despachado» o
 * «Entregado» son simples nombres de opciones que la persona eligió.
 */

const KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ROLE_RE = /^[a-z][a-z0-9_]{1,31}$/;

export const FLOW_REQUIREMENT_KINDS = ['field', 'photo', 'signature', 'comment'] as const;
export type FlowRequirementKind = (typeof FLOW_REQUIREMENT_KINDS)[number];

export const FLOW_REQUIREMENT_LABEL: Record<FlowRequirementKind, string> = {
  field: 'Un dato',
  photo: 'Una foto',
  signature: 'Una firma',
  comment: 'Un comentario',
};

/** Algo que hay que dejar en la fila para entrar a un estado; `field` es el campo donde queda. */
export const flowRequirementSchema = z.object({
  kind: z.enum(FLOW_REQUIREMENT_KINDS),
  field: z.string().regex(KEY_RE),
});
export type FlowRequirement = z.infer<typeof flowRequirementSchema>;

export const flowTransitionSchema = z.object({
  from: z.string().trim().min(1).max(80),
  to: z.string().trim().min(1).max(80),
  /** Roles de la app que pueden hacer este salto; vacío = cualquiera que edite la fila. */
  roles: z.array(z.string().regex(ROLE_RE)).max(8).optional(),
});
export type FlowTransitionInput = z.infer<typeof flowTransitionSchema>;
export type FlowTransition = { from: string; to: string; roles: string[] };

export const flowNotifySchema = z.object({
  /** Roles de la app a quienes llega el aviso por la campana. */
  roles: z.array(z.string().regex(ROLE_RE)).min(1).max(8),
  /** Texto del aviso; admite {{nombre}} y {{campo}}. */
  message: z.string().trim().max(300).optional(),
});
export type FlowNotify = z.infer<typeof flowNotifySchema>;

export const flowSchema = z
  .object({
    /** Los estados en orden; el primero es donde nace cada fila. Son opciones del campo. */
    states: z.array(z.string().trim().min(1).max(80)).min(2).max(12),
    transitions: z.array(flowTransitionSchema).max(80).optional(),
    requirements: z.record(z.array(flowRequirementSchema).max(5)).optional(),
    notify: z.record(flowNotifySchema).optional(),
  })
  .superRefine((flow, ctx) => {
    const states = new Set(flow.states);
    if (states.size !== flow.states.length)
      ctx.addIssue({ code: 'custom', message: 'Hay estados repetidos.', path: ['states'] });
    const transitions = flow.transitions ?? [];
    for (const [i, t] of transitions.entries()) {
      if (!states.has(t.from) || !states.has(t.to))
        ctx.addIssue({
          code: 'custom',
          message: `El salto «${t.from}» → «${t.to}» nombra un estado que no existe.`,
          path: ['transitions', i],
        });
      if (t.from === t.to)
        ctx.addIssue({
          code: 'custom',
          message: `El salto «${t.from}» → «${t.to}» no lleva a ningún lado.`,
          path: ['transitions', i],
        });
    }
    const seen = new Set<string>();
    for (const [i, t] of transitions.entries()) {
      const k = `${t.from}\u0000${t.to}`;
      if (seen.has(k))
        ctx.addIssue({
          code: 'custom',
          message: `El salto «${t.from}» → «${t.to}» está repetido.`,
          path: ['transitions', i],
        });
      seen.add(k);
    }
    for (const key of [...Object.keys(flow.requirements ?? {}), ...Object.keys(flow.notify ?? {})])
      if (!states.has(key))
        ctx.addIssue({
          code: 'custom',
          message: `«${key}» tiene reglas pero no es un estado del flujo.`,
          path: ['states'],
        });
  });
/** El flujo tal como se guarda en el campo (los listados vacíos pueden faltar). */
export type FlowDef = z.infer<typeof flowSchema>;
/** El flujo normalizado, que es el que usa todo el código. */
export interface Flow {
  states: string[];
  transitions: FlowTransition[];
  requirements: Record<string, FlowRequirement[]>;
  notify: Record<string, FlowNotify>;
}

export function normalizeFlow(def: FlowDef): Flow {
  return {
    states: def.states,
    transitions: (def.transitions ?? []).map((t) => ({
      from: t.from,
      to: t.to,
      roles: t.roles ?? [],
    })),
    requirements: def.requirements ?? {},
    notify: def.notify ?? {},
  };
}

/** Lo mínimo que se necesita de un campo; el campo real de una tabla cumple. */
export interface FlowFieldLike {
  key: string;
  label: string;
  type: string;
  options?: string[];
  flow?: FlowDef;
}

/** El campo con flujo de una tabla (el primero), o null. */
export function flowOf(
  fields: readonly FlowFieldLike[] | undefined,
): { field: FlowFieldLike; flow: Flow } | null {
  for (const f of fields ?? [])
    if (f.type === 'select' && f.flow) return { field: f, flow: normalizeFlow(f.flow) };
  return null;
}

/** Saltos «uno tras otro» para los estados dados: la forma más común de flujo. */
export function linearTransitions(
  states: readonly string[],
  roles: string[] = [],
): FlowTransition[] {
  return states.slice(0, -1).map((from, i) => ({ from, to: states[i + 1] as string, roles }));
}

/** El flujo es coherente con su campo y con los demás campos de la tabla. */
export function flowProblems(
  field: FlowFieldLike,
  flow: Flow,
  fields: readonly FlowFieldLike[],
): string[] {
  const out: string[] = [];
  const options = new Set(field.options ?? []);
  for (const s of flow.states)
    if (!options.has(s)) out.push(`El estado «${s}» no es una opción de «${field.label}».`);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const [state, reqs] of Object.entries(flow.requirements))
    for (const r of reqs) {
      const target = byKey.get(r.field);
      if (!target) {
        out.push(`Para entrar a «${state}» se pide «${r.field}», que no es un campo de la tabla.`);
        continue;
      }
      if (target.key === field.key)
        out.push(`Para entrar a «${state}» no se puede pedir el mismo campo del estado.`);
      if ((r.kind === 'photo' || r.kind === 'signature') && target.type !== 'file')
        out.push(
          `«${target.label}» guarda ${r.kind === 'photo' ? 'la foto' : 'la firma'} de «${state}» y tiene que ser un campo de archivo.`,
        );
      if (r.kind === 'comment' && target.type !== 'text' && target.type !== 'longtext')
        out.push(
          `«${target.label}» guarda el comentario de «${state}» y tiene que ser un campo de texto.`,
        );
    }
  return out;
}

/** Quien hace el salto: sus roles en la app (vacío fuera de una app) y si administra. */
export interface FlowActor {
  roles: string[];
  /** Owner/admin de la empresa: salta cualquier rol. */
  admin: boolean;
  /**
   * Fuera de una app (chat, tabla del equipo) no hay roles: no se comprueba
   * quién, sólo que el salto exista y sus requisitos se cumplan.
   */
  unscoped?: boolean;
}

export type FlowRule = 'unknown_state' | 'not_allowed' | 'role' | 'requirements' | 'initial';

export interface FlowCheck {
  ok: boolean;
  rule?: FlowRule;
  message?: string;
  missing?: FlowRequirement[];
}

/** ¿Hay un valor útil en la celda? (0 de un checkbox cuenta como vacío). */
export function isFilled(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'number') return Number.isFinite(v);
  const s = String(v).trim();
  return s !== '' && s !== '[]' && s !== '{}';
}

/** Requisitos de entrar a `to` que la fila (ya con el cambio puesto) no cumple. */
export function missingRequirements(
  flow: Flow,
  to: string,
  values: Record<string, unknown>,
): FlowRequirement[] {
  return (flow.requirements[to] ?? []).filter((r) => !isFilled(values[r.field]));
}

export function transitionAllowed(flow: Flow, from: string, to: string): FlowTransition | null {
  return flow.transitions.find((t) => t.from === from && t.to === to) ?? null;
}

function actorMay(t: FlowTransition, actor: FlowActor): boolean {
  if (actor.admin || actor.unscoped || t.roles.length === 0) return true;
  return t.roles.some((r) => actor.roles.includes(r));
}

function reqText(flow: Flow, fields: readonly FlowFieldLike[], miss: FlowRequirement[]): string {
  const by = new Map(fields.map((f) => [f.key, f]));
  return miss
    .map(
      (r) =>
        `${FLOW_REQUIREMENT_LABEL[r.kind].toLowerCase()} («${by.get(r.field)?.label ?? r.field}»)`,
    )
    .join(', ');
}

/**
 * La regla que el servidor hace cumplir al escribir una fila: ¿se puede pasar
 * de `from` a `to` con `values` (la fila ya con el cambio) y este actor?
 * - Quedarse en el mismo estado siempre vale.
 * - Una fila nueva (`from` vacío) sólo nace en el primer estado (el admin, en cualquiera).
 * - Una fila con un estado fuera del flujo (valor viejo) puede entrar a cualquiera
 *   de los estados del flujo, para poder ordenar lo heredado.
 */
export function checkTransition(input: {
  flow: Flow;
  field: FlowFieldLike;
  fields: readonly FlowFieldLike[];
  from: string | null | undefined;
  to: string | null | undefined;
  values: Record<string, unknown>;
  actor: FlowActor;
}): FlowCheck {
  const { flow, field, actor } = input;
  const from = input.from === undefined || input.from === null ? '' : String(input.from);
  const to = input.to === undefined || input.to === null ? '' : String(input.to);
  if (from === to) return { ok: true };
  if (to === '') return { ok: true };
  if (!flow.states.includes(to))
    return {
      ok: false,
      rule: 'unknown_state',
      message: `«${to}» no es un estado del flujo de «${field.label}».`,
    };
  const first = flow.states[0] as string;
  if (from === '') {
    if (to !== first && !actor.admin)
      return {
        ok: false,
        rule: 'initial',
        message: `Una fila nueva empieza en «${first}», no en «${to}».`,
      };
  } else if (flow.states.includes(from)) {
    const t = transitionAllowed(flow, from, to);
    if (!t)
      return {
        ok: false,
        rule: 'not_allowed',
        message: `De «${from}» no se puede pasar a «${to}».`,
      };
    if (!actorMay(t, actor))
      return {
        ok: false,
        rule: 'role',
        message: `Tu rol no puede pasar de «${from}» a «${to}»${t.roles.length ? ` (lo hace: ${t.roles.join(', ')})` : ''}.`,
      };
  }
  const missing = missingRequirements(flow, to, input.values);
  if (missing.length)
    return {
      ok: false,
      rule: 'requirements',
      missing,
      message: `Para pasar a «${to}» falta: ${reqText(flow, input.fields, missing)}.`,
    };
  return { ok: true };
}

export interface FlowStep {
  state: string;
  status: 'done' | 'current' | 'todo';
}

export interface FlowNextMove {
  to: string;
  /** El actor puede hacer este salto (rol incluido). */
  allowed: boolean;
  /** Por qué no, en palabras de la persona. */
  reason?: string;
  /** Lo que se pide para entrar; se junta en una hoja al tocar el botón. */
  requires: Array<{
    kind: FlowRequirementKind;
    field: string;
    label: string;
    filled: boolean;
    /** Tipo del campo donde queda (para pedir lo justo en la hoja). */
    type: string;
    options?: string[];
  }>;
}

export interface ComputedFlow {
  field: string;
  label: string;
  current: string | null;
  steps: FlowStep[];
  next: FlowNextMove[];
  /** Quien mira puede hacer saltos (la pantalla es editable). */
  writable: boolean;
}

/** El avance y los botones de UNA fila, ya según el actor. Pura. */
export function buildFlowView(input: {
  flow: Flow;
  field: FlowFieldLike;
  fields: readonly FlowFieldLike[];
  current: string | null | undefined;
  values: Record<string, unknown>;
  actor: FlowActor;
  writable: boolean;
}): ComputedFlow {
  const { flow, field, actor } = input;
  const current =
    input.current === undefined || input.current === null || input.current === ''
      ? null
      : String(input.current);
  const at = current === null ? -1 : flow.states.indexOf(current);
  const steps: FlowStep[] = flow.states.map((state, i) => ({
    state,
    status: i === at ? 'current' : at >= 0 && i < at ? 'done' : 'todo',
  }));
  const labelOf = (key: string) => input.fields.find((f) => f.key === key)?.label ?? key;
  const from = current !== null && at >= 0 ? current : null;
  const moves: Array<{ to: string; t: FlowTransition | null }> =
    from === null
      ? flow.states.map((to) => ({ to, t: null }))
      : flow.transitions.filter((t) => t.from === from).map((t) => ({ to: t.to, t }));
  const next = moves.map(({ to, t }): FlowNextMove => {
    const requires = (flow.requirements[to] ?? []).map((r) => {
      const target = input.fields.find((f) => f.key === r.field);
      return {
        kind: r.kind,
        field: r.field,
        label: labelOf(r.field),
        filled: isFilled(input.values[r.field]),
        type: target?.type ?? 'text',
        ...(target?.options?.length ? { options: target.options } : {}),
      };
    });
    const allowed = t ? actorMay(t, actor) : true;
    return {
      to,
      allowed,
      ...(allowed ? {} : { reason: `Lo hace: ${t?.roles.join(', ') || 'otro rol'}` }),
      requires,
    };
  });
  return { field: field.key, label: field.label, current, steps, next, writable: input.writable };
}

export interface FlowHistoryEntry {
  at: string;
  by: string | null;
  from: string | null;
  to: string;
}

/** Los saltos de estado de una fila, del más nuevo al más viejo, desde sus eventos de edición. */
export function transitionHistory(
  events: ReadonlyArray<{
    at: string;
    by: string | null;
    changes: Record<string, { from?: unknown; to?: unknown }> | null;
  }>,
  fieldKey: string,
): FlowHistoryEntry[] {
  const out: FlowHistoryEntry[] = [];
  for (const e of events) {
    const c = e.changes?.[fieldKey];
    if (!c || c.to === undefined || c.to === null || c.to === '') continue;
    out.push({
      at: e.at,
      by: e.by,
      from: c.from === undefined || c.from === null || c.from === '' ? null : String(c.from),
      to: String(c.to),
    });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Resumen en una línea, para el chat y la confirmación. */
export function describeFlow(
  field: FlowFieldLike,
  flow: Flow,
  fields: readonly FlowFieldLike[],
): string {
  const labelOf = (key: string) => fields.find((f) => f.key === key)?.label ?? key;
  const lines = [`Flujo de «${field.label}»: ${flow.states.join(' → ')}.`];
  const restricted = flow.transitions.filter((t) => t.roles.length);
  for (const t of restricted) lines.push(`«${t.from}» → «${t.to}»: sólo ${t.roles.join(', ')}.`);
  for (const [state, reqs] of Object.entries(flow.requirements))
    lines.push(
      `Para entrar a «${state}»: ${reqs.map((r) => `${FLOW_REQUIREMENT_LABEL[r.kind].toLowerCase()} (${labelOf(r.field)})`).join(', ')}.`,
    );
  for (const [state, n] of Object.entries(flow.notify))
    lines.push(`Al entrar a «${state}» se avisa a ${n.roles.join(', ')}.`);
  return lines.join(' ');
}

/**
 * Las automatizaciones que implementan los avisos del flujo, con las vías que
 * ya existen (regla «cuando cambia el campo a X → avisar por la campana»). El
 * flujo NO manda nada por su cuenta: WhatsApp y correo se arman aparte, con sus
 * herramientas que piden confirmación.
 */
export function flowAutomationDrafts(input: {
  tracker: string;
  trackerName: string;
  field: FlowFieldLike;
  flow: Flow;
}): Array<{
  name: string;
  trigger: { type: 'row_updated'; tracker: string; field: string; to: string };
  actions: Array<{
    type: 'notify_member';
    members: never[];
    roles: string[];
    admins: false;
    title: string;
    body?: string;
  }>;
}> {
  return Object.entries(input.flow.notify).map(([state, n]) => ({
    name: `Flujo ${input.trackerName}: ${state}`.slice(0, 80),
    trigger: {
      type: 'row_updated' as const,
      tracker: input.tracker,
      field: input.field.key,
      to: state,
    },
    actions: [
      {
        type: 'notify_member' as const,
        members: [] as never[],
        roles: n.roles,
        admins: false as const,
        title: (n.message ?? `{{nombre}} pasó a ${state}`).slice(0, 160),
      },
    ],
  }));
}
