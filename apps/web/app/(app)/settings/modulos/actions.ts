'use server';

import type { ModuleActionResult } from '@/components/modules/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type ModuleKey,
  enabledModules,
  isModuleKey,
  moduleByKey,
  presetByKey,
  previewModuleChanges,
  setModules,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE CAMBIA DESDE AJUSTES › MÓDULOS (y desde «Prenderlo» en la pantalla
 * de un módulo apagado). Cada export es un endpoint que cualquiera con sesión
 * puede llamar: `setModules` vuelve a mirar que sea administrador o dueño, y
 * la regla de dependencias vive allí, no aquí.
 */

function message(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : '';
  return text && text.length < 300 ? text : fallback;
}

function label(key: ModuleKey): string {
  return moduleByKey(key).label;
}

export async function toggleModule(key: string, enabled: boolean): Promise<ModuleActionResult> {
  const user = await requireSession();
  if (!isModuleKey(key)) return { ok: false, note: 'No conozco ese módulo.' };
  const db = getOrgScopedClient(user.organization.id);
  try {
    const { changed } = await setModules(db, {
      changes: [{ key, enabled }],
      userId: user.id,
      via: 'settings',
    });
    // El menú, la paleta y las pantallas leen esto en el layout.
    revalidatePath('/', 'layout');
    if (!changed.length) return { ok: true, note: 'Ya estaba así.' };
    const others = changed.filter((c) => c.key !== key).map((c) => label(c.key));
    if (!enabled) return { ok: true, note: `${label(key)} apagado. Los datos quedan guardados.` };
    return {
      ok: true,
      note: others.length
        ? `${label(key)} prendido, junto con ${others.join(' y ')}, que necesita.`
        : `${label(key)} prendido.`,
    };
  } catch (err) {
    return { ok: false, note: message(err, 'No pude guardar el cambio. Intenta de nuevo.') };
  }
}

/** Lo que haría un preset hoy, para enseñarlo antes de confirmar. */
export async function previewPreset(
  preset: string,
): Promise<{ ok: boolean; note: string; on: string[]; off: string[] }> {
  const user = await requireSession();
  const p = presetByKey(preset);
  if (!p) return { ok: false, note: 'No conozco ese tipo de empresa.', on: [], off: [] };
  const current = await enabledModules(getOrgScopedClient(user.organization.id), { fresh: true });
  const plan = previewModuleChanges(current, p);
  if (!plan.ok) return { ok: false, note: plan.message, on: [], off: [] };
  return {
    ok: true,
    note: plan.changes.length ? '' : 'Ya tienes prendido justo lo que sugiero.',
    on: plan.changes.filter((c) => c.enabled).map((c) => label(c.key)),
    off: plan.changes.filter((c) => !c.enabled).map((c) => label(c.key)),
  };
}

export async function applyPreset(preset: string): Promise<ModuleActionResult> {
  const user = await requireSession();
  const p = presetByKey(preset);
  if (!p) return { ok: false, note: 'No conozco ese tipo de empresa.' };
  const db = getOrgScopedClient(user.organization.id);
  try {
    const current = await enabledModules(db, { fresh: true });
    const plan = previewModuleChanges(current, p);
    if (!plan.ok) return { ok: false, note: plan.message };
    const { changed } = await setModules(db, {
      changes: plan.changes,
      userId: user.id,
      via: `preset:${p.key}`,
    });
    revalidatePath('/', 'layout');
    return {
      ok: true,
      note: changed.length
        ? `Listo: ${changed.length} ${changed.length === 1 ? 'módulo cambió' : 'módulos cambiaron'}. Cada uno se sigue moviendo suelto.`
        : 'Ya tenías prendido justo lo que sugiero.',
    };
  } catch (err) {
    return { ok: false, note: message(err, 'No pude guardar el cambio. Intenta de nuevo.') };
  }
}
