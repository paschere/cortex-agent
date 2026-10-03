'use server';

import type { ActionResult } from '@/components/contracts/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  CONTRACT_COUNTERPARTY_KINDS,
  CONTRACT_OBLIGATION_PARTIES,
  CONTRACT_OBLIGATION_RECURRENCES,
  CONTRACT_RENEWALS,
  type ContractCounterpartyKind,
  type ContractObligationParty,
  type ContractObligationRecurrence,
  type ContractRenewal,
  addManualContractObligation,
  canSeeContract,
  completeContractObligation,
  confirmContractObligation,
  discardContractObligation,
  draftContract,
  editContractText,
  extractContractObligations,
  getContract,
  isCompanyManager,
  markContractSigned,
  registerUploadedContract,
  sendContractToReview,
  terminateContract,
  updateContractTerm,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /contratos (0195). Cada export es un endpoint que
 * cualquiera con sesión puede llamar: cada uno vuelve a mirar que el contrato
 * exista en la empresa de la sesión y que quien llama lo pueda ver (los
 * laborales, sólo quien administra, quien lo creó o su responsable).
 */

const UUID = /^[0-9a-f-]{36}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function describe(err: unknown, fallback: string): string {
  if (err instanceof NotFoundError) return 'Ese contrato ya no existe.';
  if (err instanceof ValidationError) return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 300 ? message : fallback;
}

async function session() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  return { user, db, ctx: { userId: user.id, organizationId: user.organization.id } };
}

async function guard(id: string) {
  const s = await session();
  if (!UUID.test(id)) throw new ValidationError('Ese contrato no existe.');
  const row = await getContract(s.db, id);
  if (!row) throw new ValidationError('Ese contrato no existe.');
  const manager = await isCompanyManager(s.db, s.user.id);
  if (!canSeeContract(row, { userId: s.user.id, manager }))
    throw new ValidationError('Ese contrato no existe.');
  return { ...s, row };
}

async function audit(
  db: Parameters<typeof writeAuditEvent>[0]['db'],
  userId: string,
  toolId: string,
  input: Record<string, unknown>,
) {
  await writeAuditEvent({
    db,
    userId,
    toolId,
    input,
    status: 'ok',
    latencyMs: 0,
    metadata: { via: 'contratos' },
  }).catch(() => undefined);
}

function done(id: string, note?: string): ActionResult {
  revalidatePath('/contratos');
  revalidatePath(`/contratos/${id}`);
  return { ok: true, note, id };
}

export async function createDraftAction(input: {
  templateKey: string;
  title?: string;
  counterpartyKind: string;
  clientId?: string | null;
  supplierId?: string | null;
  employeeUserId?: string | null;
  counterpartyName?: string | null;
  counterpartyId?: string | null;
  values: Record<string, string>;
  startOn?: string | null;
  endOn?: string | null;
  valueAmount?: number | null;
  noticeDays?: number | null;
  renewal?: string | null;
}): Promise<ActionResult> {
  try {
    const { db, ctx, user } = await session();
    const kind = (CONTRACT_COUNTERPARTY_KINDS as readonly string[]).includes(input.counterpartyKind)
      ? (input.counterpartyKind as ContractCounterpartyKind)
      : 'otro';
    const result = await draftContract(
      db,
      {
        templateKey: input.templateKey,
        title: input.title ?? null,
        link: {
          kind,
          clientId:
            kind === 'cliente' && input.clientId && UUID.test(input.clientId)
              ? input.clientId
              : null,
          supplierId:
            kind === 'proveedor' && input.supplierId && UUID.test(input.supplierId)
              ? input.supplierId
              : null,
          employeeUserId:
            kind === 'empleado' && input.employeeUserId && UUID.test(input.employeeUserId)
              ? input.employeeUserId
              : null,
          name: input.counterpartyName ?? null,
          idNumber: input.counterpartyId ?? null,
        },
        values: input.values,
        startOn: input.startOn && ISO.test(input.startOn) ? input.startOn : null,
        endOn: input.endOn && ISO.test(input.endOn) ? input.endOn : null,
        valueAmount: input.valueAmount ?? null,
        noticeDays: input.noticeDays ?? null,
        renewal: (CONTRACT_RENEWALS as readonly string[]).includes(input.renewal ?? '')
          ? (input.renewal as ContractRenewal)
          : null,
        organizationName: user.organization.name,
      },
      ctx,
    );
    await audit(db, user.id, 'contracts.draft', { template: input.templateKey, via: 'asistente' });
    revalidatePath('/contratos');
    return {
      ok: true,
      id: result.row.id,
      note: result.fill.missing.length
        ? `Borrador creado con ${result.fill.missing.length} datos por completar.`
        : 'Borrador creado.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude crear el borrador.') };
  }
}

export async function uploadSignedContractAction(input: {
  title: string;
  contractType: string;
  documentId: string;
  counterpartyKind: string;
  clientId?: string | null;
  supplierId?: string | null;
  counterpartyName?: string | null;
  signedAt?: string | null;
}): Promise<ActionResult> {
  try {
    const { db, ctx } = await session();
    if (!UUID.test(input.documentId)) return { ok: false, error: 'No reconozco ese documento.' };
    if (input.title.trim().length < 3) return { ok: false, error: 'Ponle un nombre al contrato.' };
    const kind = (CONTRACT_COUNTERPARTY_KINDS as readonly string[]).includes(input.counterpartyKind)
      ? (input.counterpartyKind as ContractCounterpartyKind)
      : 'otro';
    const row = await registerUploadedContract(
      db,
      {
        title: input.title,
        contractType: (input.contractType || 'otro') as Parameters<
          typeof registerUploadedContract
        >[1]['contractType'],
        documentId: input.documentId,
        signedAt: input.signedAt && ISO.test(input.signedAt) ? input.signedAt : null,
        link: {
          kind,
          clientId:
            kind === 'cliente' && input.clientId && UUID.test(input.clientId)
              ? input.clientId
              : null,
          supplierId:
            kind === 'proveedor' && input.supplierId && UUID.test(input.supplierId)
              ? input.supplierId
              : null,
          name: input.counterpartyName ?? null,
        },
      },
      ctx,
    );
    return done(
      row.id,
      'Contrato guardado. Lee sus obligaciones cuando el documento termine de indexarse.',
    );
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude guardar el contrato.') };
  }
}

export async function saveTextAction(input: { id: string; text: string }): Promise<ActionResult> {
  try {
    const { db, ctx } = await guard(input.id);
    await editContractText(db, input, ctx);
    return done(input.id, 'Texto guardado.');
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude guardar el texto.') };
  }
}

export async function sendToReviewAction(input: { id: string }): Promise<ActionResult> {
  try {
    const { db, ctx } = await guard(input.id);
    await sendContractToReview(db, input.id, ctx);
    return done(input.id, 'Quedó en revisión.');
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude cambiar el estado.') };
  }
}

export async function markSignedAction(input: {
  id: string;
  signedAt?: string | null;
  documentId?: string | null;
}): Promise<ActionResult> {
  try {
    const { db, ctx, user } = await guard(input.id);
    const documentId = input.documentId && UUID.test(input.documentId) ? input.documentId : null;
    const { watch } = await markContractSigned(
      db,
      {
        id: input.id,
        signedAt: input.signedAt && ISO.test(input.signedAt) ? input.signedAt : null,
        documentId,
      },
      ctx,
    );
    await audit(db, user.id, 'contracts.mark_signed', { id: input.id });
    const bits = [
      watch.expiration === 'linked'
        ? 'su vencimiento ya lo vigilaba Documentos que vencen: quedó enlazado'
        : watch.expiration === 'created'
          ? 'su vencimiento quedó en Documentos que vencen'
          : '',
      watch.notice === 'created'
        ? 'el aviso previo quedó vigilado'
        : watch.notice === 'passed'
          ? 'el plazo del aviso previo ya pasó'
          : '',
    ].filter(Boolean);
    return done(input.id, `Marcado firmado${bits.length ? `; ${bits.join('; ')}` : ''}.`);
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude marcarlo firmado.') };
  }
}

export async function terminateAction(input: {
  id: string;
  terminatedOn: string;
  reason: string;
}): Promise<ActionResult> {
  try {
    const { db, ctx } = await guard(input.id);
    await terminateContract(db, input, ctx);
    return done(input.id, 'Terminado. Cerré sus avisos.');
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude terminarlo.') };
  }
}

export async function saveTermAction(input: {
  id: string;
  startOn: string | null;
  endOn: string | null;
  renewal: string;
  renewalMonths: number | null;
  noticeDays: number | null;
  valueAmount: number | null;
  ownerUserId: string | null;
}): Promise<ActionResult> {
  try {
    const { db, ctx } = await guard(input.id);
    const { watch } = await updateContractTerm(
      db,
      input.id,
      {
        startOn: input.startOn,
        endOn: input.endOn,
        renewal: (CONTRACT_RENEWALS as readonly string[]).includes(input.renewal)
          ? (input.renewal as ContractRenewal)
          : undefined,
        renewalMonths: input.renewalMonths,
        noticeDays: input.noticeDays,
        valueAmount: input.valueAmount,
        ownerUserId: input.ownerUserId && UUID.test(input.ownerUserId) ? input.ownerUserId : null,
      },
      ctx,
    );
    return done(
      input.id,
      watch.notice === 'created' || watch.notice === 'updated'
        ? 'Guardado; el aviso previo quedó vigilado.'
        : 'Guardado.',
    );
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude guardar las fechas.') };
  }
}

export async function extractAction(input: { id: string }): Promise<ActionResult> {
  try {
    const { db, ctx, user } = await guard(input.id);
    const r = await extractContractObligations(db, { contractId: input.id }, ctx);
    await audit(db, user.id, 'contracts.extract_obligations', { contractId: input.id });
    if (!r.reading.modelCalled)
      return {
        ok: false,
        error: `No leí nada: ${r.reading.reason ?? 'el documento no tiene texto'}.`,
      };
    const t = r.reading.term;
    return done(
      input.id,
      `Propuse ${r.inserted.length} obligaciones con su frase${
        r.reading.rejected.length ? ` (descarté ${r.reading.rejected.length} sin evidencia)` : ''
      }.${t.endOn.value ? ` El contrato dice que termina el ${t.endOn.value}${t.noticeDays.value !== null ? ` con ${t.noticeDays.value} días de aviso` : ''}: revisa las fechas arriba.` : ''} Confírmalas una por una.`,
    );
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude leer el contrato.') };
  }
}

async function obligationContract(obligationId: string) {
  const s = await session();
  if (!UUID.test(obligationId)) throw new ValidationError('Esa obligación no existe.');
  const { data, error } = await s.db
    .from('contract_obligations')
    .select('contract_id')
    .eq('id', obligationId)
    .maybeSingle();
  if (error) throw error;
  const contractId = (data as { contract_id: string } | null)?.contract_id;
  if (!contractId) throw new ValidationError('Esa obligación no existe.');
  return guard(contractId);
}

export async function confirmObligationAction(input: {
  id: string;
  dueOn?: string | null;
  ownerUserId?: string | null;
}): Promise<ActionResult> {
  try {
    const { db, ctx, row } = await obligationContract(input.id);
    const r = await confirmContractObligation(
      db,
      {
        id: input.id,
        dueOn:
          input.dueOn === undefined
            ? undefined
            : input.dueOn && ISO.test(input.dueOn)
              ? input.dueOn
              : null,
        ownerUserId:
          input.ownerUserId && UUID.test(input.ownerUserId) ? input.ownerUserId : undefined,
      },
      ctx,
    );
    return done(
      row.id,
      r.commitmentId ? 'Confirmada y vigilada.' : 'Confirmada (sin fecha: no genera aviso).',
    );
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude confirmarla.') };
  }
}

export async function discardObligationAction(input: {
  id: string;
  reason?: string;
}): Promise<ActionResult> {
  try {
    const { db, ctx, row } = await obligationContract(input.id);
    await discardContractObligation(db, { id: input.id, reason: input.reason ?? null }, ctx);
    return done(row.id, 'Descartada.');
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude descartarla.') };
  }
}

export async function completeObligationAction(input: { id: string }): Promise<ActionResult> {
  try {
    const { db, ctx, row } = await obligationContract(input.id);
    await completeContractObligation(db, { id: input.id }, ctx);
    return done(row.id, 'Marcada cumplida.');
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude marcarla.') };
  }
}

export async function addObligationAction(input: {
  contractId: string;
  party: string;
  description: string;
  dueOn: string | null;
  recurrence: string;
}): Promise<ActionResult> {
  try {
    const { db, ctx } = await guard(input.contractId);
    await addManualContractObligation(
      db,
      {
        contractId: input.contractId,
        party: (CONTRACT_OBLIGATION_PARTIES as readonly string[]).includes(input.party)
          ? (input.party as ContractObligationParty)
          : 'nosotros',
        description: input.description,
        dueOn: input.dueOn && ISO.test(input.dueOn) ? input.dueOn : null,
        recurrence: (CONTRACT_OBLIGATION_RECURRENCES as readonly string[]).includes(
          input.recurrence,
        )
          ? (input.recurrence as ContractObligationRecurrence)
          : 'none',
      },
      ctx,
    );
    return done(input.contractId, 'Obligación agregada.');
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude agregarla.') };
  }
}
