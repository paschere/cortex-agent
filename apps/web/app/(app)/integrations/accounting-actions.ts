'use server';

import { canManageAccounting } from '@/lib/accounting/card';
import { enqueueJob } from '@/lib/jobs';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  SiigoError,
  disconnectAccounting,
  getAccountingProvider,
  requestAccountingSync,
  saveAccountingConnection,
  updateAccountingSettings,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * Lo que la sección «Programas contables» de Integraciones puede escribir
 * (migración 0165). Todo pasa por las funciones de accounting/store.ts; aquí
 * sólo se decide QUIÉN (dueños y administradores) y se traduce el error.
 *
 * LA LLAVE. `connectAccountingProgram` es el único camino por el que entra una
 * llave: llega del formulario, se prueba contra el programa ANTES de guardarse
 * y se guarda cifrada. Ninguna acción la devuelve, y ningún error la repite.
 */

export type AccountingActionResult = { ok: true; note?: string } | { ok: false; error: string };

const PATH = '/integrations';

function describe(err: unknown, fallback: string): string {
  if (err instanceof SiigoError || err instanceof ValidationError || err instanceof NotFoundError)
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
