import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  AUTOMATION_MAX_DEPTH,
  type AutomationEvent,
  type Values,
  automationIdempotencyKey,
  matchesTrigger,
  mayFire,
} from './match';
import {
  type AutomationTrigger,
  TRIGGER_KINDS,
  type TriggerKind,
  automationTriggerSchema,
} from './spec';

/**
 * EL ÚNICO PUNTO POR DONDE UN CAMBIO DE FILA SE VUELVE UN EVENTO (0210).
 *
 * Quien escribe filas (`upsertRow`, `submitViewForm`, `patchRow` de las
 * vistas, la regla de duplicados y las sincronizaciones de hojas, carpetas y
 * programas contables) llama aquí DESPUÉS de escribir, junto a
 * `applyDuplicateRule`. Esto no ejecuta nada: decide si alguna regla encendida
 * mira esa tabla y, si sí, deja UNA fila en `custom_app_automation_runs`
 * (`queued`, con el suceso adentro) y despierta al trabajo
 * `apps/automation.run`. La corrida de verdad ocurre fuera de la escritura.
 *
 * POR QUÉ UNA FILA Y NO SÓLO UN TRABAJO ENCOLADO. La fila es la cola durable:
 * si encolar falla (la cola parpadea, el proceso muere), el barrido de cada
 * minuto (`apps/automation.dispatch`) recoge todo lo `queued`. Y su clave
 * única es la idempotencia: la misma regla, sobre la misma fila y la misma
 * versión del suceso, deja una sola corrida aunque dos escritores o un
 * reintento lo emitan.
 *
 * BARATO PARA EL SISTEMA. Una escritura de fila paga como máximo UNA consulta
 * indexada («¿hay reglas encendidas que miren esta tabla?», con una memoria de
 * 10 s por tabla) y, si no hay ninguna, nada más. `emitAutomationEvent` nunca
 * lanza: una regla caída no puede tumbar el guardado de la fila de un operario.
 *
 * SIN BUCLES. Lo que escribe una automatización corre dentro de
 * `withAutomationOrigin`; el evento que nace de ahí lleva la cadena de reglas
 * y su profundidad, y `mayFire` descarta a la que ya está en la cadena y todo
 * lo que pase de `AUTOMATION_MAX_DEPTH`.
 */

export interface AutomationOrigin {
  chain: string[];
  depth: number;
}

const origin = new AsyncLocalStorage<AutomationOrigin>();

/** Todo lo que se escriba dentro de `fn` cuenta como hecho por estas reglas. */
export function withAutomationOrigin<T>(o: AutomationOrigin, fn: () => Promise<T>): Promise<T> {
  return origin.run(o, fn);
}

export function currentAutomationOrigin(): AutomationOrigin | null {
  return origin.getStore() ?? null;
}

/**
 * Quién despierta al trabajo. Lo registra la app web al arrancar
 * (`instrumentation-node.ts`): este paquete no puede importar la cola.
 * Sin despertador, el barrido de cada minuto hace el trabajo.
 */
type Waker = (runs: Array<{ id: string; organizationId: string }>) => Promise<void> | void;
let waker: Waker | null = null;
export function setAutomationWaker(fn: Waker | null): void {
  waker = fn;
}

const WATCH_TTL_MS = 10_000;
const watchCache = new Map<string, { at: number; value: boolean }>();

/** Olvida lo recordado (al guardar una regla en este proceso, y en las pruebas). */
export function forgetAutomationWatch(): void {
  watchCache.clear();
}

/** ¿Hay reglas encendidas que miren esta tabla? Una consulta indexada, recordada 10 s. */
export async function watchesTracker(
  db: SupabaseClient,
  trackerId: string,
  now = Date.now(),
): Promise<boolean> {
  const hit = watchCache.get(trackerId);
  if (hit && now - hit.at < WATCH_TTL_MS) return hit.value;
  try {
    const { data, error } = await db
      .from('custom_app_automations')
      .select('id')
      .eq('enabled', true)
      .eq('tracker_id', trackerId)
      .limit(1);
    if (error) return false;
    const value = (data ?? []).length > 0;
    watchCache.set(trackerId, { at: now, value });
    return value;
  } catch {
    return false;
  }
}

export interface EmitInput {
  kind: TriggerKind;
  trackerId: string;
  trackerSlug?: string;
  rowId: string;
  before?: Values | null;
  after: Values;
  label?: string;
  /** Hora de la escritura (ISO); sin ella, ahora. */
  version?: string;
  actor: AutomationEvent['actor'];
  viewId?: string;
  blockId?: string;
  screen?: string;
  decision?: 'approved' | 'rejected';
  reason?: string;
}

interface Candidate {
  id: string;
  app_id: string;
  trigger: unknown;
}

/** Encola las corridas de las reglas que este suceso dispara. Nunca lanza. */
export async function emitAutomationEvent(db: SupabaseClient, input: EmitInput): Promise<number> {
  try {
    if (!TRIGGER_KINDS.includes(input.kind)) return 0;
    const o = currentAutomationOrigin();
    const event: AutomationEvent = {
      kind: input.kind,
      trackerId: input.trackerId,
      trackerSlug: input.trackerSlug,
      rowId: input.rowId,
      before: input.before ?? null,
      after: input.after,
      label: input.label,
      version: input.version ?? new Date().toISOString(),
      actor: o ? { kind: 'automation', id: o.chain[o.chain.length - 1] ?? null } : input.actor,
      viewId: input.viewId,
      blockId: input.blockId,
      screen: input.screen,
      decision: input.decision,
      reason: input.reason,
      chain: o?.chain ?? [],
      depth: o?.depth ?? 0,
    };
    // Más profundo que el tope: ni se consulta.
    if (event.depth >= AUTOMATION_MAX_DEPTH) return 0;

    const { data, error } = await db
      .from('custom_app_automations')
      .select('id, app_id, trigger')
      .eq('enabled', true)
      .eq('tracker_id', input.trackerId)
      .eq('trigger_kind', input.kind)
      .limit(50);
    if (error || !data?.length) return 0;

    const matched: Candidate[] = [];
    let screenSlug = event.screen;
    for (const raw of data as Candidate[]) {
      const trigger = automationTriggerSchema.safeParse(raw.trigger);
      if (!trigger.success) continue;
      if (!mayFire(raw.id, event)) continue;
      // El slug de la pantalla sólo se busca si alguna regla lo pide.
      if (
        trigger.data.type === 'form_submitted' &&
        trigger.data.screen &&
        !screenSlug &&
        input.viewId
      ) {
        screenSlug = await screenSlugOf(db, input.viewId);
        event.screen = screenSlug;
      }
      if (matchesTrigger(trigger.data as AutomationTrigger, event, input.trackerSlug ?? null))
        matched.push(raw);
    }
    if (!matched.length) return 0;

    return await queueRuns(db, matched, event, `${input.kind}:${input.rowId}`);
  } catch {
    return 0;
  }
}

/**
 * Deja una corrida `queued` por regla (una sola por clave de idempotencia) y
 * despierta al trabajo. También lo usan el horario y el botón.
 */
export async function queueRuns(
  db: SupabaseClient,
  automations: Array<{ id: string; app_id: string }>,
  event: AutomationEvent,
  triggerRef: string,
): Promise<number> {
  if (!automations.length) return 0;
  const rows = automations.map((a) => ({
    id: randomUUID(),
    app_id: a.app_id,
    automation_id: a.id,
    trigger_ref: triggerRef,
    status: 'queued',
    next_attempt_at: new Date().toISOString(),
    event,
    depth: event.depth,
    idempotency_key: automationIdempotencyKey(a.id, event),
  }));
  const { data: inserted, error } = await db
    .from('custom_app_automation_runs')
    .upsert(rows, { onConflict: 'idempotency_key', ignoreDuplicates: true })
    .select('id, organization_id');
  if (error) return 0;
  const created = (inserted ?? []) as Array<{ id: string; organization_id: string }>;
  if (created.length && waker) {
    try {
      await waker(created.map((r) => ({ id: r.id, organizationId: r.organization_id })));
    } catch {
      // El barrido de cada minuto la recoge.
    }
  }
  return created.length;
}

async function screenSlugOf(db: SupabaseClient, viewId: string): Promise<string | undefined> {
  const { data } = await db
    .from('custom_app_screens')
    .select('slug')
    .eq('view_id', viewId)
    .maybeSingle();
  return (data as { slug?: string } | null)?.slug;
}

/**
 * Las sincronizaciones (hojas, carpetas, programas contables) escriben cientos
 * de filas de golpe sin decir cuáles. Si alguna regla mira la tabla, se leen
 * las filas que tocó la sincronización (por `updated_at >= desde`) y se emite
 * un evento por fila, con tope. Sin reglas, una sola consulta indexada.
 */
export async function emitSyncEvents(
  db: SupabaseClient,
  tracker: { id: string; slug: string },
  sinceIso: string,
  options: { limit?: number } = {},
): Promise<number> {
  try {
    if (!(await watchesTracker(db, tracker.id))) return 0;
    const { data, error } = await db
      .from('tracker_rows')
      .select('id, label, values, created_at, updated_at')
      .eq('tracker_id', tracker.id)
      .gte('updated_at', sinceIso)
      .order('updated_at', { ascending: true })
      .limit(options.limit ?? 200);
    if (error || !data?.length) return 0;
    let n = 0;
    for (const r of data as Array<{
      id: string;
      label: string;
      values: Values;
      created_at: string;
      updated_at: string;
    }>) {
      const created = new Date(r.created_at).getTime() >= new Date(sinceIso).getTime();
      n += await emitAutomationEvent(db, {
        kind: created ? 'row_created' : 'row_updated',
        trackerId: tracker.id,
        trackerSlug: tracker.slug,
        rowId: r.id,
        after: r.values ?? {},
        label: r.label,
        version: r.updated_at,
        actor: { kind: 'system' },
      });
    }
    return n;
  } catch {
    return 0;
  }
}
