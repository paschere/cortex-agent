'use server';

import type { SetupItem } from '@/lib/guided-setup-shape';
import { type CreateContext, createOne, defaultAgentId, undoOne } from '@/lib/guided-setup/apply';
import {
  discardSession,
  getSession,
  listItems,
  markItem,
  markSessionApplied,
  pickProposed,
  proposedItem,
  skipRemaining,
} from '@/lib/guided-setup/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { bogotaToday, writeAuditEvent } from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';

const PATH = '/onboarding/entrevista';

/**
 * LOS CUATRO BOTONES QUE TIENE EL PLAN, Y LO QUE CADA UNO PROMETE.
 *
 * Crear, deshacer uno, deshacer todo, descartar. No hay un quinto: la
 * entrevista no edita lo que propuso. Si algo está mal, se desmarca y se le
 * dice a Cortex qué estaba mal — una lista de propuestas con campos editables
 * es un formulario, que es exactamente de lo que esta pantalla es la
 * alternativa.
 *
 * Ninguna de estas acciones confía en lo que le manden. `applySelection` recibe
 * ids y no objetos, y los cruza contra las filas que la sesión guardó como
 * `proposed`; `undoItem` sólo puede borrar la fila que su propio ítem anotó.
 */

export interface ApplyReport {
  ok: boolean;
  error?: string;
  created: number;
  merged: number;
  failed: number;
  items: SetupItem[];
}

/**
 * Crear lo que una persona marcó, y sólo eso.
 *
 * Se crea de a uno y cada resultado se anota antes de seguir. Es más lento que
 * un lote y es a propósito: si el tercero falla, los dos primeros ya están
 * anotados con su puntero y se pueden deshacer. Un lote transaccional dejaría
 * la alternativa de "todo o nada", y "nada" después de que alguien aprobó cinco
 * cosas es la peor de las dos.
 */
export async function applySelection(
  sessionId: string,
  itemIds: string[],
): Promise<ApplyReport> {
  const started = performance.now();
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const session = await getSession(db, sessionId);
  if (!session) return fail('Esa entrevista ya no está.');
  if (session.status === 'applied') return fail('Esto ya se había creado.');

  const chosen = await pickProposed(db, sessionId, itemIds);
  if (chosen.length === 0) {
    return fail('No marcaste nada, así que no creé nada.');
  }

  const ctx: CreateContext = {
    db,
    userId: user.id,
    agentId: await defaultAgentId(db),
    canCreateGlobalSpace: user.role === 'org_admin',
    today: bogotaToday(),
  };

  let created = 0;
  let merged = 0;
  let failed = 0;

  for (const item of chosen) {
    const outcome = await createOne(ctx, item);
    await markItem(db, item.id, {
      status: outcome.status,
      targetTable: outcome.targetTable ?? null,
      targetId: outcome.targetId ?? null,
      error: outcome.error ?? null,
      decidedBy: user.id,
    });
    if (outcome.status === 'created') created++;
    else if (outcome.status === 'merged') merged++;
    else failed++;
  }

  // Lo que se desmarcó también se anota. Un plan del que se aceptan dos de seis
  // dice algo que un plan aceptado entero no dice, y borrarlo lo perdería.
  const skipped = await skipRemaining(db, sessionId, user.id);

  await markSessionApplied(db, sessionId);

  await writeAuditEvent({
    db,
    userId: user.id as UUID,
    toolId: '__guided_setup_apply',
    input: { sessionId, chosen: chosen.length },
    status: failed > 0 ? 'error' : 'ok',
    latencyMs: Math.round(performance.now() - started),
    surface: 'web',
    decision: 'confirmed',
    metadata: {
      sessionId,
      proposed: chosen.length + skipped,
      created,
      merged,
      failed,
      skipped,
      kinds: chosen.map((i) => i.kind),
    },
  });

  revalidatePath(PATH);
  return { ok: true, created, merged, failed, items: await listItems(db, sessionId) };
}

export interface UndoReport {
  ok: boolean;
  error?: string;
  undone: number;
  items: SetupItem[];
}

export async function undoItem(itemId: string): Promise<UndoReport> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const item = await proposedItem(db, itemId);
  if (!item) return { ok: false, error: 'Eso ya no está.', undone: 0, items: [] };

  const result = await undoOne(db, item);
  if (!result.ok) {
    return { ok: false, error: result.error, undone: 0, items: await listItems(db, item.sessionId) };
  }
  await markItem(db, item.id, {
    status: 'undone',
    targetTable: item.targetTable,
    targetId: item.targetId,
    decidedBy: user.id,
    undone: true,
  });

  revalidatePath(PATH);
  return { ok: true, undone: 1, items: await listItems(db, item.sessionId) };
}

/**
 * Deshacer todo de una. Existe porque la reacción honesta a un plan que salió
 * mal no es desmarcar seis cosas una por una — es "quítame esto de encima".
 * Lo que no se pueda borrar se queda con su razón y el conteo lo refleja.
 */
export async function undoAll(sessionId: string): Promise<UndoReport> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);

  const session = await getSession(db, sessionId);
  if (!session) return { ok: false, error: 'Esa entrevista ya no está.', undone: 0, items: [] };

  let undone = 0;
  const blocked: string[] = [];
  for (const item of await listItems(db, sessionId)) {
    if (item.status !== 'created') continue;
    const result = await undoOne(db, item);
    if (result.ok) {
      await markItem(db, item.id, {
        status: 'undone',
        targetTable: item.targetTable,
        targetId: item.targetId,
        decidedBy: user.id,
        undone: true,
      });
      undone++;
    } else if (result.error) {
      blocked.push(`${item.title}: ${result.error}`);
    }
  }

  revalidatePath(PATH);
  return {
    ok: true,
    error: blocked.length > 0 ? blocked.join(' ') : undefined,
    undone,
    items: await listItems(db, sessionId),
  };
}

/** «Nada de esto sirve.» Se guarda igual: un plan rechazado entero enseña. */
export async function discardPlan(sessionId: string): Promise<{ ok: boolean; error?: string }> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const session = await getSession(db, sessionId);
  if (!session) return { ok: false, error: 'Esa entrevista ya no está.' };
  await discardSession(db, sessionId);
  revalidatePath(PATH);
  return { ok: true };
}

function fail(error: string): ApplyReport {
  return { ok: false, error, created: 0, merged: 0, failed: 0, items: [] };
}
