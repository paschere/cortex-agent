'use server';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  ManagementError,
  advanceCollectionWorkflow,
  cancelCollectionWorkflow,
  computeNextRun,
  listCollectionInvoices,
  loadCollectionProof,
  readCollectionWorkflow,
  readManagementEvents,
  readWorkflowHistory,
  saveManagementCase,
  saveManagementProfile,
  startCollectionWorkflow,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const optionsSchema = z.object({
  id: z.string().uuid().optional(),
  revision: z.number().int().nonnegative().optional(),
});
export async function saveCase(input: unknown, options: unknown = {}) {
  const user = await requireSession();
  try {
    const parsed = optionsSchema.parse(options);
    await saveManagementCase(getOrgScopedClient(user.organization.id), user.id, input, {
      ...parsed,
      humanReview: true,
    });
    revalidatePath('/management');
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof ManagementError
          ? error.message
          : error instanceof Error && !(error instanceof z.ZodError)
            ? error.message
            : 'Revisa los campos del asunto.',
    };
  }
}
export async function saveProfile(input: unknown, revision: number) {
  const user = await requireSession();
  if (user.role !== 'org_admin')
    return { ok: false as const, error: 'Solo un administrador puede configurar la gerencia.' };
  try {
    await saveManagementProfile(
      getOrgScopedClient(user.organization.id),
      user.id,
      input,
      z.number().int().nonnegative().parse(revision),
    );
    revalidatePath('/management');
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      error:
        error instanceof ManagementError
          ? error.message
          : 'Revisa los campos de configuración y los manuales.',
    };
  }
}
export async function caseHistory(id: string) {
  const user = await requireSession();
  try {
    return {
      ok: true as const,
      events: await readManagementEvents(
        getOrgScopedClient(user.organization.id),
        z.string().uuid().parse(id),
      ),
    };
  } catch {
    return { ok: false as const, error: 'No se pudo cargar el historial.' };
  }
}

export async function startDailyBrief() {
  const user = await requireSession();
  try {
    const result = await getOrgScopedClient(user.organization.id).rpc('management_start_daily', {
      p_actor_id: user.id,
      p_next_run: computeNextRun('0 8 * * 1-5', 'America/Bogota').toISOString(),
    });
    if (result.error)
      return {
        ok: false as const,
        error:
          result.error.code === 'P0001'
            ? result.error.message
            : 'No se pudo activar el parte diario.',
      };
    revalidatePath('/schedules');
    return {
      ok: true as const,
      jobId: result.data[0].job_id as string,
      status: result.data[0].job_status as string,
    };
  } catch {
    return { ok: false as const, error: 'No se pudo activar el parte diario.' };
  }
}

export async function loadWorkflow(caseId: string) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    const id = z.string().uuid().parse(caseId);
    const run = await readCollectionWorkflow(db, id);
    return {
      ok: true as const,
      run,
      invoices: await listCollectionInvoices(db),
      history: run ? await readWorkflowHistory(db, run.id) : [],
    };
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof ManagementError ? e.message : 'No se pudo leer el proceso.',
    };
  }
}
export async function startWorkflow(input: unknown) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    const run = await startCollectionWorkflow(db, user.id, input);
    await advanceCollectionWorkflow(db, run.id);
    revalidatePath('/management');
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : 'No se pudo iniciar.' };
  }
}
export async function progressWorkflow(caseId: string, cancel = false) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    const run = await readCollectionWorkflow(db, z.string().uuid().parse(caseId));
    if (!run || run.user_id !== user.id)
      throw new ManagementError('Solo quien inició el proceso puede continuarlo o detenerlo.');
    z.boolean().parse(cancel);
    if (cancel) await cancelCollectionWorkflow(db, user.id, run.id);
    else await advanceCollectionWorkflow(db, run.id);
    revalidatePath('/management');
    return { ok: true as const };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : 'No se pudo actualizar.' };
  }
}

export async function workflowEvidence(caseId: string) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  try {
    const run = await readCollectionWorkflow(db, z.string().uuid().parse(caseId));
    if (!run || run.state === 'cancelled') throw new Error('El proceso no está activo.');
    const { proof } = await loadCollectionProof(db, run.invoice_id);
    if (proof.balance !== 0)
      throw new Error('El saldo cambió. Revisa el proceso antes de proponer su cierre.');
    return {
      ok: true as const,
      evidence: {
        reference: '/payments',
        observation: `Factura ${proof.invoiceNumber ?? run.invoice_id}: total ${proof.invoiceTotal} ${proof.currency}; pagos confirmados ${proof.confirmedPaid}; saldo ${proof.balance}. Movimientos: ${proof.paymentIds.slice(0, 10).join(', ')}${proof.paymentIds.length > 10 ? ` y ${proof.paymentIds.length - 10} adicionales en el registro del proceso` : ''}. ${proof.method}`,
        observedOn: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(
          new Date(proof.checkedAt),
        ),
      },
    };
  } catch (e) {
    return {
      ok: false as const,
      error: e instanceof Error ? e.message : 'No se pudo verificar la evidencia.',
    };
  }
}
