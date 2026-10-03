'use server';

import type { ScreenResult } from '@/components/statements/types';
import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import {
  boardGenerate,
  boardPublicUrl,
  boardSend,
  runTool,
  saveBoardSettings,
  setBoardAccess,
  toolErrorMessage,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /informe-socios (0191).
 *
 * Armar y mandar pasan por las mismas herramientas del chat (`runTool`:
 * misma validación, misma auditoría a nombre de quien pulsó); el botón con su
 * confirmación ES la aprobación. Configurar y compartir son escrituras
 * internas de quien administra (el módulo lo vuelve a revisar).
 */

const PATH = '/informe-socios';

async function session() {
  const user = await requireSession();
  return { user, db: getOrgScopedClient(user.organization.id) };
}

async function cortexAgentId(organizationId: string): Promise<string | null> {
  const db = getOrgScopedClient(organizationId);
  const { data, error } = await db.from('agents').select('id').eq('slug', 'cortex').maybeSingle();
  if (error) return null;
  return (data as { id?: string } | null)?.id ?? null;
}

const NO_AGENT = 'Cortex todavía no está configurado en este espacio de trabajo.';

export async function generateBoardAction(
  period: string,
): Promise<ScreenResult & { id?: string; href?: string }> {
  try {
    const { user } = await session();
    const agentId = await cortexAgentId(user.organization.id);
    if (!agentId) return { ok: false, error: NO_AGENT };
    const ctx = buildToolContext({
      userId: user.id,
      agentId: agentId as UUID,
      organizationId: user.organization.id,
    });
    const out = await runTool(boardGenerate, { period }, ctx, { confirmed: true });
    revalidatePath(PATH);
    return {
      ok: true,
      id: out.id,
      href: workspaceHref(user.organization.id, `${PATH}/${out.id}`),
      note: out.fallback
        ? 'Listo. El resumen lo armó la plantilla: el modelo no contestó o escribió cifras que no están en los datos.'
        : 'Listo: quedó en borrador.',
    };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function saveBoardSettingsAction(input: {
  enabled: boolean;
  dayOfMonth: number;
  hour: number;
  recipients: string[];
}): Promise<ScreenResult> {
  try {
    const { user, db } = await session();
    const agentId = await cortexAgentId(user.organization.id);
    const s = await saveBoardSettings(
      db,
      {
        enabled: Boolean(input.enabled),
        dayOfMonth: Number(input.dayOfMonth),
        hour: Number(input.hour),
        recipients: Array.isArray(input.recipients)
          ? input.recipients.map(String).slice(0, 30)
          : [],
      },
      { userId: user.id, agentId },
    );
    revalidatePath(PATH);
    return {
      ok: true,
      note: s.enabled
        ? `Listo: el día ${s.dayOfMonth} de cada mes se arma el informe del mes anterior y te aviso. Mandarlo te lo pregunto.`
        : 'Guardado. El informe no se arma solo.',
    };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function setBoardAccessAction(
  id: string,
  input: {
    visibility: 'privado' | 'enlace' | 'contrasena';
    password?: string;
    days?: number | null;
    rotate?: boolean;
  },
): Promise<ScreenResult & { url?: string | null }> {
  try {
    const { user, db } = await session();
    const visibility = ['privado', 'enlace', 'contrasena'].includes(input.visibility)
      ? input.visibility
      : 'privado';
    const r = await setBoardAccess(
      db,
      id,
      {
        visibility,
        password: typeof input.password === 'string' ? input.password : undefined,
        days: input.days,
        rotate: input.rotate === true,
      },
      { userId: user.id },
    );
    revalidatePath(`${PATH}/${id}`);
    return {
      ok: true,
      url: r.shareToken ? boardPublicUrl(r.shareToken) : null,
      note:
        r.visibility === 'privado'
          ? 'El informe quedó privado: el enlace anterior ya no abre.'
          : r.visibility === 'contrasena'
            ? 'Listo: el enlace pide contraseña.'
            : 'Listo: cualquiera con el enlace lo puede ver.',
    };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}

export async function sendBoardAction(
  id: string,
  to: string[],
  message: string | null,
): Promise<ScreenResult> {
  try {
    const { user } = await session();
    const agentId = await cortexAgentId(user.organization.id);
    if (!agentId) return { ok: false, error: NO_AGENT };
    const ctx = buildToolContext({
      userId: user.id,
      agentId: agentId as UUID,
      organizationId: user.organization.id,
    });
    const out = await runTool(
      boardSend,
      { report: id, ...(to.length ? { to } : {}), ...(message?.trim() ? { message } : {}) },
      ctx,
      { confirmed: true },
    );
    revalidatePath(PATH);
    revalidatePath(`${PATH}/${id}`);
    return { ok: true, note: out.markdown };
  } catch (err) {
    return { ok: false, error: toolErrorMessage(err) };
  }
}
