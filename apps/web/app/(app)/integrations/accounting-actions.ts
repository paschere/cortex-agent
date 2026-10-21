'use server';

import { canManageAccounting } from '@/lib/accounting/card';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  AlegraError,
  QuickBooksError,
  SiigoError,
  disconnectAccounting,
  getAccountingConnection,
  getAccountingProvider,
  openAccountingSession,
  requestAccountingSync,
  saveAccountingConnection,
  siigoWebhookUrl,
  updateAccountingSettings,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError, getEnv } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * Lo que la sección «Programas contables» de Integraciones puede escribir
 * (migración 0165). Todo pasa por las funciones de accounting/store.ts; aquí
 * sólo se decide QUIÉN (dueños y administradores) y se traduce el error.
 *
 * LA LLAVE. `connectAccountingProgram` es el único camino por el que entra una
 * llave pegada (Siigo, Alegra): llega del formulario, se prueba contra el
 * programa ANTES de guardarse y se guarda cifrada. QuickBooks no pega llave:
 * entra por Intuit (app/api/integrations/quickbooks). Ninguna acción la
 * devuelve, y ningún error la repite.
 */

export type AccountingActionResult = { ok: true; note?: string } | { ok: false; error: string };

const PATH = '/integrations';

function describe(err: unknown, fallback: string): string {
  if (
    err instanceof SiigoError ||
    err instanceof AlegraError ||
    err instanceof QuickBooksError ||
    err instanceof ValidationError ||
    err instanceof NotFoundError
  )
    return err.message;
  return fallback;
}

async function adminDb() {
  const user = await requireSession();
  if (!canManageAccounting(user.organization.role))
    throw new ValidationError(
      'Sólo quien administra el espacio puede conectar o cambiar el programa contable.',
    );
  return { user, db: getOrgScopedClient(user.organization.id) };
}

export async function connectAccountingProgram(input: {
  provider: string;
  credentials: Record<string, string>;
  entities: string[];
  intervalMinutes: number;
  notify: boolean;
}): Promise<AccountingActionResult> {
  try {
    const { user, db } = await adminDb();
    const provider = getAccountingProvider(input.provider);
    if (!provider) return { ok: false, error: 'Ese programa todavía no se puede conectar.' };
    if (provider.connect === 'oauth')
      return {
        ok: false,
        error: `${provider.name} se conecta entrando a su cuenta, con el botón de la tarjeta.`,
      };
    const credentials = Object.fromEntries(
      provider.credentialFields.map((f) => [
        f.key,
        String(input.credentials?.[f.key] ?? '').trim(),
      ]),
    );
    // Probar ANTES de guardar: una llave que no sirve no se guarda.
    const { token } = await provider.open(credentials).verify();
    const conn = await saveAccountingConnection(db, {
      provider: provider.id,
      credentials,
      token,
      entities: input.entities,
      intervalMinutes: input.intervalMinutes,
      notify: input.notify,
      userId: user.id,
    });
    await enqueueJob('accounting/run', {
      organizationId: user.organization.id,
      connectionId: conn.id,
    });
    revalidatePath('/onboarding');
    revalidatePath(PATH);
    return {
      ok: true,
      note: `${provider.name} quedó conectado. Ya empecé a traer los datos; te aviso en la campana cuando termine la primera carga.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo conectar. Inténtalo otra vez.') };
  }
}

export async function saveAccountingProgramSettings(input: {
  provider: string;
  entities: string[];
  intervalMinutes: number;
  notify: boolean;
  enabled: boolean;
}): Promise<AccountingActionResult> {
  try {
    const { db } = await adminDb();
    await updateAccountingSettings(db, input.provider, {
      entities: input.entities,
      intervalMinutes: input.intervalMinutes,
      notify: input.notify,
      enabled: input.enabled,
    });
    revalidatePath(PATH);
    return { ok: true, note: 'Guardado.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar.') };
  }
}

export async function syncAccountingProgramNow(input: {
  provider: string;
}): Promise<AccountingActionResult> {
  try {
    const { user, db } = await adminDb();
    const conn = await requestAccountingSync(db, input.provider);
    await enqueueJob('accounting/run', {
      organizationId: user.organization.id,
      connectionId: conn.id,
    });
    revalidatePath(PATH);
    return { ok: true, note: 'Sincronizando. Las tablas se actualizan en unos minutos.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo pedir la sincronización.') };
  }
}

export async function disconnectAccountingProgram(input: {
  provider: string;
}): Promise<AccountingActionResult> {
  try {
    const { db } = await adminDb();
    // Un programa con OAuth (QuickBooks): avisarle que el permiso ya no se usa.
    // Si no contesta, igual se desconecta.
    if (getAccountingProvider(input.provider)?.connect === 'oauth') {
      const conn = await getAccountingConnection(db, input.provider);
      if (conn)
        await openAccountingSession(db, conn.id)
          .then((session) => session.revoke?.())
          .catch(() => undefined);
    }
    await disconnectAccounting(db, input.provider);
    revalidatePath(PATH);
    return {
      ok: true,
      note: 'Desconectado. La llave se borró; las tablas y la cartera que ya se trajeron se quedan.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo desconectar.') };
  }
}

/**
 * Pide a Siigo que avise cuando cambien productos o existencias (0234): la
 * sincronización corre al minuto en vez de esperar sus 15 minutos. Es
 * configuración en Siigo, no datos, y sólo la pide quien administra.
 */
export async function enableSiigoStockWebhook(): Promise<AccountingActionResult> {
  try {
    const { user, db } = await adminDb();
    const conn = await getAccountingConnection(db, 'siigo');
    if (!conn) return { ok: false, error: 'Siigo no está conectado.' };
    const url = siigoWebhookUrl(getEnv().APP_BASE_URL, user.organization.id, conn.id);
    if (!url)
      return {
        ok: false,
        error:
          'Falta el secreto de avisos en esta instalación (ACCOUNTING_WEBHOOK_SECRET). Sin él no se puede recibir avisos de Siigo; la sincronización sigue cada 15 minutos.',
      };
    const session = await openAccountingSession(db, conn.id);
    if (!session.webhooks) return { ok: false, error: 'Siigo no ofrece avisos en esta cuenta.' };
    const { topics, failed } = await session.webhooks.subscribe(url);
    if (!topics.length)
      return {
        ok: false,
        error:
          'Siigo no aceptó el aviso (puede que su cuenta no lo tenga habilitado). La sincronización sigue cada 15 minutos.',
      };
    return {
      ok: true,
      note: failed.length
        ? `Siigo avisará de ${topics.length} de ${topics.length + failed.length} cambios de productos y existencias.`
        : 'Siigo avisará cuando cambien productos y existencias.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo activar el aviso de Siigo.') };
  }
}
