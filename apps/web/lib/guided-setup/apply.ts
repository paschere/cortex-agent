import 'server-only';

import {
  type ClientPayload,
  type CommitmentPayload,
  type FlowPayload,
  type RoutinePayload,
  type SetupItem,
  type SpacePayload,
  normalizeProposal,
  slugify,
} from '@/lib/guided-setup-shape';
import type { SupabaseClient } from '@supabase/supabase-js';
import { computeNextRun, createCommitment, isValidCron, registerClient } from '@cortex/agent-tools';

/**
 * DONDE LA CONVERSACIÓN SE VUELVE COSAS.
 *
 * ===========================================================================
 * NADA SE CREA SIN QUE ALGUIEN LO CONFIRME, Y LA GARANTÍA NO ES EL PROMPT
 * ===========================================================================
 * La entrevista propone; esto crea. Son dos peticiones distintas y entre las
 * dos hay una persona mirando la lista, con los campos exactos a la vista y una
 * casilla por ítem. El fallo que esto evita no es teórico: un onboarding que
 * genera quince rutinas plausibles deja al cliente con quince rutinas que
 * limpiar, y le enseña en el primer día que lo que este producto crea hay que
 * revisarlo. Es más barato no crear nada.
 *
 * La garantía es estructural, no de confianza:
 *
 *   1. Los ítems ya están en `guided_setup_items` con estado `proposed` desde
 *      antes de que la pantalla los muestre.
 *   2. `applySelection` no lee el cuerpo de la petición para saber QUÉ crear:
 *      lee esas filas y las cruza con los ids marcados (`pickProposed`).
 *   3. Cada payload se vuelve a pasar por el catálogo aquí, con
 *      `normalizeProposal`, aunque ya haya pasado al proponerse. Entre las dos
 *      validaciones hay una tabla y una red, y todo lo que atraviesa una red es
 *      entrada.
 *
 * ===========================================================================
 * Y TODO LO QUE SE CREA SE PUEDE DESHACER
 * ===========================================================================
 * Deshacer aquí significa BORRAR, no archivar. Un vencimiento descartado sigue
 * apareciendo en las listas del módulo con su motivo, que es lo correcto para
 * algo que existió de verdad y perdió vigencia — y es exactamente lo que no se
 * quiere para algo que se creó por error hace dos minutos. La papelera de un
 * onboarding es ruido con fecha.
 *
 * La única excepción es un cliente que ya existía: `registerClient` es
 * idempotente por identidad y completa el que hay en vez de duplicarlo. Ese
 * ítem queda como `merged` y no se puede deshacer, porque borrar esa fila
 * destruiría datos que no salieron de esta pantalla. La pantalla lo dice con
 * esas palabras en vez de esconder el botón.
 *
 * Y hay dos frenos más, para lo que sí se borra: un espacio con documentos
 * adentro y un cliente al que ya le colgaron contactos, dominios o vínculos no
 * se borran. En los dos casos, entre el momento de crearlo y el de deshacerlo
 * alguien puso algo suyo dentro.
 */

export interface ApplyOutcome {
  itemId: string;
  ok: boolean;
  /** 'created' | 'merged' | 'failed' */
  status: SetupItem['status'];
  targetTable?: string;
  targetId?: string;
  error?: string;
}

export interface CreateContext {
  db: SupabaseClient;
  userId: string;
  /** Necesario para una rutina: `scheduled_jobs.agent_id` no admite nulo. */
  agentId: string | null;
  /** Sólo un administrador puede crear un espacio de toda la empresa. */
  canCreateGlobalSpace: boolean;
  /** Hoy en Bogotá, `YYYY-MM-DD`. Se pasa para que el test no dependa del reloj. */
  today: string;
}

export async function createOne(ctx: CreateContext, item: SetupItem): Promise<ApplyOutcome> {
  // Segunda pasada por el catálogo. Ver la cabecera.
  const check = normalizeProposal(
    { kind: item.kind, title: item.title, rationale: item.rationale, payload: item.payload },
    ctx.today,
  );
  if (!check.ok) {
    return { itemId: item.id, ok: false, status: 'failed', error: check.reason };
  }

  try {
    switch (item.kind) {
      case 'commitment':
        return await createCommitmentItem(ctx, item, check.item.payload as CommitmentPayload);
      case 'routine':
        return await createRoutineItem(ctx, item, check.item.payload as RoutinePayload);
      case 'flow':
        return await createFlowItem(ctx, item, check.item.payload as FlowPayload);
      case 'client':
        return await createClientItem(ctx, item, check.item.payload as ClientPayload);
      case 'space':
        return await createSpaceItem(ctx, item, check.item.payload as SpacePayload);
    }
  } catch (err) {
    return { itemId: item.id, ok: false, status: 'failed', error: message(err) };
  }
}

function message(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.length > 300 ? `${text.slice(0, 297)}…` : text || 'No se pudo crear.';
}

/**
 * El módulo de Vencimientos no acepta una fecha sin fuente, y hace bien: una
 * fecha sin procedencia es una fecha que nadie puede verificar cuando avise.
 * Aquí la fuente es `manual` con el usuario que confirmó — es literalmente lo
 * que pasó: una persona lo dijo y otra (la misma) lo aprobó en pantalla. Eso
 * deja la fila en `confirmed` y vigilada desde el primer día, que es distinto
 * de lo extraído de un documento, que entra en `pending` a esperar a un humano.
 */
async function createCommitmentItem(
  ctx: CreateContext,
  item: SetupItem,
  payload: CommitmentPayload,
): Promise<ApplyOutcome> {
  const row = await createCommitment(ctx.db, {
    title: payload.title,
    detail: payload.detail ?? null,
    kind: payload.kind,
    dueOn: payload.dueOn,
    noticeDays: payload.noticeDays ?? null,
    counterparty: payload.counterparty ?? null,
    source: { kind: 'manual', userId: ctx.userId },
    createdBy: ctx.userId,
  });
  return {
    itemId: item.id,
    ok: true,
    status: 'created',
    targetTable: 'commitments',
    targetId: row.id,
  };
}

/**
 * Una rutina nacida de una entrevista corre como turno de agente con una
 * instrucción en español, no como una llamada fija a una herramienta: nadie
 * dijo «llama a commitments.due_soon con estos argumentos», dijo «todos los
 * lunes revísame qué se vence esta semana».
 *
 * Y nace SIN permiso de escribir sin supervisión. Es la diferencia entre una
 * rutina que te informa y una que actúa sola, y no es una decisión que se pueda
 * tomar por alguien en su primer día a partir de una frase hablada.
 */
async function createRoutineItem(
  ctx: CreateContext,
  item: SetupItem,
  payload: RoutinePayload,
): Promise<ApplyOutcome> {
  if (!ctx.agentId) {
    return {
      itemId: item.id,
      ok: false,
      status: 'failed',
      error: 'Este espacio todavía no tiene un agente al que colgarle la rutina.',
    };
  }
  if (!isValidCron(payload.cron, payload.timezone)) {
    return { itemId: item.id, ok: false, status: 'failed', error: 'Esa hora no se entiende.' };
  }
  const nextRun = computeNextRun(payload.cron, payload.timezone);

  const { data, error } = await ctx.db
    .from('scheduled_jobs')
    .insert({
      user_id: ctx.userId,
      agent_id: ctx.agentId,
      name: payload.name,
      kind: 'agent',
      instruction: payload.instruction,
      schedule_kind: 'cron',
      cron: payload.cron,
      timezone: payload.timezone,
      next_run_at: nextRun.toISOString(),
      allow_unattended_writes: false,
      notify_conversation: true,
      notify_email: false,
    })
    .select('id')
    .single();
  if (error) throw error;

  return {
    itemId: item.id,
    ok: true,
    status: 'created',
    targetTable: 'scheduled_jobs',
    targetId: (data as { id: string }).id,
  };
}

async function createFlowItem(
  ctx: CreateContext,
  item: SetupItem,
  payload: FlowPayload,
): Promise<ApplyOutcome> {
  const steps = payload.steps.map((s) => ({
    title: s.title,
    detail: s.detail,
    tools: [],
    checkpoint: s.checkpoint,
  }));

  // El slug es único por empresa. Un choque no es un error que mostrar: es un
  // nombre repetido, y la respuesta es un sufijo, no un mensaje rojo.
  let slug = slugify(payload.name);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await ctx.db
      .from('pipelines')
      .insert({
        slug,
        name: payload.name,
        description: payload.description,
        emoji: '🧭',
        intro: '',
        steps,
        instruction: '',
        params: [],
        created_by: ctx.userId,
      })
      .select('id')
      .single();

    if (!error) {
      return {
        itemId: item.id,
        ok: true,
        status: 'created',
        targetTable: 'pipelines',
        targetId: (data as { id: string }).id,
      };
    }
    if ((error as { code?: string }).code !== '23505') throw error;
    slug = `${slugify(payload.name).slice(0, 40)}-${attempt + 2}`;
  }
  return {
    itemId: item.id,
    ok: false,
    status: 'failed',
    error: 'Ya tienes un flujo con ese nombre.',
  };
}

async function createClientItem(
  ctx: CreateContext,
  item: SetupItem,
  payload: ClientPayload,
): Promise<ApplyOutcome> {
  const result = await registerClient(ctx.db, {
    name: payload.name,
    nit: payload.nit ?? null,
    city: payload.city ?? null,
    notes: payload.notes ?? null,
    createdBy: ctx.userId,
  });
  return {
    itemId: item.id,
    ok: true,
    status: result.created ? 'created' : 'merged',
    targetTable: 'clients',
    targetId: result.client.id,
  };
}

async function createSpaceItem(
  ctx: CreateContext,
  item: SetupItem,
  payload: SpacePayload,
): Promise<ApplyOutcome> {
  if (!ctx.canCreateGlobalSpace) {
    return {
      itemId: item.id,
      ok: false,
      status: 'failed',
      error: 'Un espacio de toda la empresa lo tiene que crear un administrador.',
    };
  }
  const { data, error } = await ctx.db
    .from('kb_collections')
    .insert({
      scope: 'global',
      scope_id: null,
      name: payload.name,
      description: payload.description || null,
      created_by: ctx.userId,
    })
    .select('id')
    .single();
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === '23505') {
      return {
        itemId: item.id,
        ok: false,
        status: 'failed',
        error: 'Ya existe un espacio con ese nombre.',
      };
    }
    throw error;
  }
  return {
    itemId: item.id,
    ok: true,
    status: 'created',
    targetTable: 'kb_collections',
    targetId: (data as { id: string }).id,
  };
}

// ---------------------------------------------------------------------------
// Deshacer
// ---------------------------------------------------------------------------

export interface UndoOutcome {
  ok: boolean;
  /** Por qué no, cuando no. Se muestra tal cual. */
  error?: string;
}

export async function undoOne(db: SupabaseClient, item: SetupItem): Promise<UndoOutcome> {
  if (item.status === 'merged') {
    return {
      ok: false,
      error: 'Ese cliente ya existía antes de la entrevista. No lo borro.',
    };
  }
  if (item.status !== 'created' || !item.targetTable || !item.targetId) {
    return { ok: false, error: 'Eso no se creó desde aquí.' };
  }

  try {
    if (item.targetTable === 'kb_collections') {
      const { count } = await db
        .from('kb_documents')
        .select('id', { count: 'exact', head: true })
        .eq('collection_id', item.targetId);
      if ((count ?? 0) > 0) {
        return { ok: false, error: 'Ese espacio ya tiene documentos adentro. No lo borro.' };
      }
    }
    if (item.targetTable === 'clients') {
      const used = await clientHasChildren(db, item.targetId);
      if (used) {
        return { ok: false, error: 'A ese cliente ya le colgaron cosas. No lo borro.' };
      }
    }

    const { error } = await db.from(item.targetTable).delete().eq('id', item.targetId);
    if (error) throw error;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: message(err) };
  }
}

async function clientHasChildren(db: SupabaseClient, clientId: string): Promise<boolean> {
  const tables = ['client_contacts', 'client_domains', 'client_links'] as const;
  for (const table of tables) {
    const { count } = await db
      .from(table)
      .select('id', { count: 'exact', head: true })
      .eq('client_id', clientId);
    if ((count ?? 0) > 0) return true;
  }
  return false;
}

/** El agente por defecto del espacio, al que se le cuelgan las rutinas. */
export async function defaultAgentId(db: SupabaseClient): Promise<string | null> {
  const { data } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (data) return (data as { id: string }).id;
  const { data: any_ } = await db.from('agents').select('id').limit(1);
  const rows = (any_ ?? []) as { id: string }[];
  return rows[0]?.id ?? null;
}
