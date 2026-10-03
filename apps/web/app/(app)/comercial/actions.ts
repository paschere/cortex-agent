'use server';

import type { GridRow } from '@/components/datagrid/types';
import { buildToolContext } from '@/lib/agent';
import type { ActionResult, TimelineEntryView } from '@/lib/crm/shape';
import { opportunityRow, timelineViews } from '@/lib/crm/views';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  CRM_LOST_REASONS,
  CRM_SOURCES,
  type CrmLostReasonKind,
  type CrmOpportunityPatch,
  type CrmOpportunitySource,
  bogotaToday,
  createCrmOpportunity,
  crmSendNps,
  getCrmOpportunity,
  loadCrmOpportunityTimeline,
  loadCrmStages,
  logCrmActivity,
  runTool,
  searchClients,
  setCrmActivityDone,
  updateCrmOpportunity,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /comercial (0193).
 *
 * Todo con el handle de la empresa de la sesión. Editar una celda, arrastrar
 * una tarjeta de etapa o crear una fila llama al almacén del paquete, que deja
 * la huella del cambio de etapa. Mandar la encuesta pasa por la MISMA
 * herramienta del chat (`crm.send_nps` con `runTool`): el clic de la persona
 * es la confirmación, y la auditoría y el correo son los mismos.
 */

const PATH = '/comercial';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(err: unknown, fallback: string): ActionResult {
  const message = err instanceof Error ? err.message : '';
  return { ok: false, error: message && message.length < 240 ? message : fallback };
}

async function session() {
  const user = await requireSession();
  return { user, db: getOrgScopedClient(user.organization.id), today: bogotaToday() };
}

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toDay(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  const d = value.slice(0, 10);
  return DAY_RE.test(d) ? d : null;
}

function toText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const t = String(value).trim();
  return t ? t : null;
}

/** «Nexa» → el cliente del hub si hay uno solo que se llame así. */
async function matchClient(db: SupabaseClient, name: string): Promise<string | null> {
  const hits = await searchClients(db, name, 5).catch(() => []);
  const exact = hits.filter((h) => h.client.name.toLowerCase() === name.trim().toLowerCase());
  return exact.length === 1 ? (exact[0]?.client.id ?? null) : null;
}

async function patchFrom(
  db: SupabaseClient,
  key: string,
  value: unknown,
): Promise<CrmOpportunityPatch> {
  switch (key) {
    case 'titulo': {
      const t = toText(value);
      if (!t) throw new Error('El negocio necesita un nombre.');
      return { title: t };
    }
    case 'cliente': {
      const t = toText(value);
      if (!t) throw new Error('Escribe el cliente.');
      return { clientName: t, clientId: await matchClient(db, t) };
    }
    case 'etapa':
      return { stage: String(value ?? '') };
    case 'valor':
      return { value: Math.max(0, toNumber(value) ?? 0) };
    case 'probabilidad': {
      const n = toNumber(value);
      return { probability: n === null ? null : Math.max(0, Math.min(100, Math.round(n))) };
    }
    case 'cierre':
      return { expectedClose: toDay(value) };
    case 'responsable':
      return { ownerUserId: toText(value) };
    case 'siguiente':
      return { nextStep: toText(value) };
    case 'siguiente_fecha':
      return { nextStepDue: toDay(value) };
    case 'origen': {
      const v = String(value ?? '');
      return {
        source: (CRM_SOURCES as readonly string[]).includes(v)
          ? (v as CrmOpportunitySource)
          : 'otro',
      };
    }
    case 'razon': {
      const v = String(value ?? '');
      return {
        lostReasonKind: (CRM_LOST_REASONS as readonly string[]).includes(v)
          ? (v as CrmLostReasonKind)
          : null,
      };
    }
    default:
      throw new Error('Esa columna no se edita aquí.');
  }
}

export async function editOpportunityCell(
  rowId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const { db, user } = await session();
  await updateCrmOpportunity(db, rowId, await patchFrom(db, key, value), {
    userId: user.id,
    origin: 'manual',
  });
  revalidatePath(PATH);
}

export async function bulkEditOpportunities(
  rowIds: string[],
  key: string,
  value: unknown,
): Promise<void> {
  const { db, user } = await session();
  const patch = await patchFrom(db, key, value);
  for (const id of rowIds.slice(0, 300))
    await updateCrmOpportunity(db, id, patch, { userId: user.id, origin: 'manual' });
  revalidatePath(PATH);
}

export async function createOpportunityRow(values: Record<string, unknown>): Promise<GridRow> {
  const { db, user, today } = await session();
  const title = toText(values.titulo);
  const clientName = toText(values.cliente);
  if (!title) throw new Error('El negocio necesita un nombre.');
  if (!clientName) throw new Error('Escribe el cliente.');
  const { stages } = await loadCrmStages(db);
  const stage = typeof values.etapa === 'string' && values.etapa ? values.etapa : stages[0]?.key;
  const created = await createCrmOpportunity(
    db,
    {
      title,
      clientName,
      clientId: await matchClient(db, clientName),
      value: Math.max(0, toNumber(values.valor) ?? 0),
      stage,
      probability: toNumber(values.probabilidad),
      expectedClose: toDay(values.cierre),
      ownerUserId: toText(values.responsable) ?? user.id,
      nextStep: toText(values.siguiente),
      nextStepDue: toDay(values.siguiente_fecha),
      source:
        typeof values.origen === 'string' &&
        (CRM_SOURCES as readonly string[]).includes(values.origen)
          ? (values.origen as CrmOpportunitySource)
          : 'otro',
    },
    { userId: user.id },
  );
  revalidatePath(PATH);
  return opportunityRow(created, stages, today);
}

/** La línea de tiempo de un negocio, al abrirlo (lo del embudo y lo del cliente). */
export async function opportunityTimeline(
  id: string,
): Promise<{ items: TimelineEntryView[]; missing: string[]; error?: string }> {
  const { db, today } = await session();
  try {
    const opp = await getCrmOpportunity(db, id);
    if (!opp) return { items: [], missing: [], error: 'Esa oportunidad ya no existe.' };
    const t = await loadCrmOpportunityTimeline(db, opp, { today });
    return { items: timelineViews(t.items, today), missing: t.missing };
  } catch {
    return { items: [], missing: [], error: 'No pude leer la línea de tiempo.' };
  }
}

export async function logActivityAction(input: {
  opportunityId?: string | null;
  clientId?: string | null;
  kind: 'call' | 'meeting' | 'email' | 'note' | 'task';
  title: string;
  body?: string | null;
  dueOn?: string | null;
  ownerUserId?: string | null;
}): Promise<ActionResult> {
  const { db, user, today } = await session();
  try {
    if (!input.title.trim()) return { ok: false, error: 'Escribe qué pasó o qué hay que hacer.' };
    let clientId = input.clientId ?? null;
    let owner = input.ownerUserId ?? null;
    if (input.opportunityId) {
      const opp = await getCrmOpportunity(db, input.opportunityId);
      if (!opp) return { ok: false, error: 'Esa oportunidad ya no existe.' };
      clientId = opp.client_id;
      owner = owner ?? (input.kind === 'task' ? opp.owner_user_id : null);
    } else if (clientId && input.kind === 'task' && !owner) {
      const { data, error } = await db
        .from('clients')
        .select('owner_user_id')
        .eq('id', clientId)
        .maybeSingle();
      if (error) throw error;
      owner = (data as { owner_user_id?: string | null } | null)?.owner_user_id ?? null;
    }
    await logCrmActivity(db, {
      opportunityId: input.opportunityId ?? null,
      clientId,
      kind: input.kind,
      title: input.title,
      body: input.body ?? null,
      dueOn: input.kind === 'task' ? (toDay(input.dueOn) ?? today) : null,
      ownerUserId: owner ?? user.id,
      origin: 'manual',
      createdBy: user.id,
    });
    revalidatePath(PATH);
    return { ok: true, note: input.kind === 'task' ? 'Tarea creada.' : 'Anotado.' };
  } catch (err) {
    return fail(err, 'No pude anotarlo.');
  }
}

export async function completeTaskAction(id: string, done: boolean): Promise<ActionResult> {
  const { db } = await session();
  try {
    await setCrmActivityDone(db, id, done);
    revalidatePath(PATH);
    return { ok: true, note: done ? 'Hecha.' : 'Reabierta.' };
  } catch (err) {
    return fail(err, 'No pude marcarla.');
  }
}

/** Mandar la encuesta por correo o sólo crear el enlace: la herramienta del chat. */
export async function sendSurveyAction(input: {
  client: string;
  email?: string | null;
  linkOnly: boolean;
}): Promise<ActionResult> {
  const { db, user } = await session();
  const { data, error } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (error || !data?.id)
    return { ok: false, error: 'Cortex no está configurado en este espacio.' };
  const ctx = buildToolContext({
    userId: user.id as UUID,
    agentId: data.id as UUID,
    organizationId: user.organization.id,
  });
  try {
    const email = input.email?.trim();
    const out = (await runTool(
      crmSendNps,
      {
        client: input.client,
        ...(email ? { to: [email] } : {}),
        ...(input.linkOnly ? { linkOnly: true } : {}),
      },
      ctx,
      { confirmed: true },
    )) as { link: string; markdown: string; via: string };
    revalidatePath(PATH);
    return {
      ok: true,
      note: input.linkOnly ? 'Enlace listo: cópialo y mándalo por WhatsApp.' : out.markdown,
      link: out.link,
    };
  } catch (err) {
    return fail(err, 'No pude crear la encuesta.');
  }
}
