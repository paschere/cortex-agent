'use server';

import type { AutopilotSettingsInput } from '@/components/autopilot/types';
import { buildPlanView } from '@/lib/autopilot/screen';
import { autopilotDryRun, decideAutopilotItem } from '@/lib/autopilot/server';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { qualifiedToolLabel } from '@/lib/tool-taxonomy';
import {
  bogotaToday,
  isCompanyManager,
  saveAutopilotSettings,
  settingsPatchSchema,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE CAMBIA DESDE /piloto. Cada export es un endpoint que cualquiera con
 * sesión puede llamar, así que cada uno vuelve a mirar quién es y qué puede:
 * configurar y decidir, sólo quien administra o es dueño (`isCompanyManager`);
 * el ensayo, cualquiera de la empresa (no escribe nada).
 */

function message(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : '';
  return text && text.length < 300 ? text : fallback;
}

export async function saveAutopilot(
  input: AutopilotSettingsInput,
): Promise<{ ok: boolean; note: string }> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  if (!(await isCompanyManager(db, user.id)))
    return { ok: false, note: 'Sólo un administrador o el dueño de la empresa cambia el piloto.' };
  const parsed = settingsPatchSchema.safeParse(input);
  if (!parsed.success) return { ok: false, note: 'Hay un dato que no entiendo. Revísalo.' };
  try {
    const saved = await saveAutopilotSettings(db, parsed.data, { userId: user.id });
    // El rastro: quién encendió, apagó o cambió el piloto, igual que si lo
    // hubiera pedido en el chat.
    await writeAuditEvent({
      db,
      userId: user.id,
      toolId: 'autopilot.configure',
      input: parsed.data,
      status: 'ok',
      latencyMs: 0,
      metadata: { via: 'piloto' },
    }).catch(() => undefined);
    revalidatePath('/piloto');
    revalidatePath('/dashboard');
    if (parsed.data.enabled === true)
      return { ok: true, note: 'Encendido. Mañana a primera hora hago la primera corrida.' };
    if (parsed.data.enabled === false && !saved.enabled)
      return { ok: true, note: 'Apagado. No hago nada más solo, desde ya.' };
    return { ok: true, note: 'Guardado.' };
  } catch (err) {
    logger.error('autopilot: no se pudo guardar la configuración', { err });
    return { ok: false, note: message(err, 'No pude guardar. Intenta de nuevo.') };
  }
}

export async function dryRunAutopilot() {
  const user = await requireSession();
  try {
    const { settings, plan } = await autopilotDryRun(user.organization.id, bogotaToday());
    return {
      ok: true as const,
      plan: buildPlanView(plan, settings, (id) => qualifiedToolLabel(id)),
    };
  } catch (err) {
    logger.error('autopilot: el ensayo falló', { err });
    return { ok: false as const, note: message(err, 'No pude armar el plan. Intenta de nuevo.') };
  }
}

export async function decideAutopilot(input: {
  itemId: string;
  decision: 'approve' | 'dismiss';
  contentHash: string;
}): Promise<{ ok: boolean; note: string }> {
  const user = await requireSession();
  if (input.decision !== 'approve' && input.decision !== 'dismiss')
    return { ok: false, note: 'Decisión desconocida.' };
  try {
    const r = await decideAutopilotItem({
      organizationId: user.organization.id,
      userId: user.id,
      itemId: String(input.itemId),
      decision: input.decision,
      contentHash: String(input.contentHash ?? ''),
    });
    revalidatePath('/piloto');
    return r.ok ? { ok: r.status !== 'failed', note: r.message } : { ok: false, note: r.message };
  } catch (err) {
    logger.error('autopilot: no se pudo decidir', { err });
    return { ok: false, note: message(err, 'No pude hacerlo. Intenta de nuevo.') };
  }
}
