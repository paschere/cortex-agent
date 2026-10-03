'use server';

import type { ActionResult, ConfirmInput, TrackInput } from '@/components/doc-expirations/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  EXPIRATION_KINDS,
  EXPIRATION_SUBJECT_KINDS,
  type ExpirationKind,
  type ExpirationSubjectKind,
  backfillDocumentExpirations,
  changeExpiration,
  confirmExpiration,
  detectDocumentExpiration,
  discardExpiration,
  isCompanyManager,
  queueRenewalUpload,
  trackExpiration,
} from '@cortex/agent-tools';
import { NotFoundError, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';

const PATH = '/documentos-vencen';
const UUID = /^[0-9a-f-]{36}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function describe(err: unknown, fallback: string): string {
  if (err instanceof NotFoundError) return 'Ese documento ya no existe.';
  if (err instanceof ValidationError) return err.message;
  const message = err instanceof Error ? err.message : '';
  return message && message.length < 300 ? message : fallback;
}

function asKind(value: string | undefined): ExpirationKind | undefined {
  return value && (EXPIRATION_KINDS as readonly string[]).includes(value)
    ? (value as ExpirationKind)
    : undefined;
}

function asSubjectKind(value: string | undefined): ExpirationSubjectKind | undefined {
  return value && (EXPIRATION_SUBJECT_KINDS as readonly string[]).includes(value)
    ? (value as ExpirationSubjectKind)
    : undefined;
}

export async function confirmExpirationAction(input: ConfirmInput): Promise<ActionResult> {
  const user = await requireSession();
  if (!UUID.test(input.id)) return { ok: false, error: 'Ese documento no existe.' };
  if (input.expiresOn && !ISO.test(input.expiresOn)) {
    return { ok: false, error: 'La fecha va como AAAA-MM-DD.' };
  }
  try {
    const db = getOrgScopedClient(user.organization.id);
    const result = await confirmExpiration(
      db,
      {
        id: input.id,
        userId: user.id,
        expiresOn: input.expiresOn ?? null,
        kind: asKind(input.kind),
        subject: input.subject,
        ownerUserId:
          input.ownerUserId && UUID.test(input.ownerUserId) ? input.ownerUserId : undefined,
        renewalLeadDays: input.renewalLeadDays ?? null,
      },
      { userId: user.id, organizationId: user.organization.id },
    );
    revalidatePath(PATH);
    const renewed = result.renewed.length
      ? ` ${result.renewed.length === 1 ? 'El anterior quedó' : `${result.renewed.length} anteriores quedaron`} como renovado${result.renewed.length === 1 ? '' : 's'}.`
      : '';
    return {
      ok: true,
      note: `Confirmado: vence ${result.row.expires_on}. El aviso sale ${result.row.renewal_lead_days} días antes.${renewed}`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo confirmar.') };
  }
}

export async function discardExpirationAction(input: {
  id: string;
  reason: string;
}): Promise<ActionResult> {
  const user = await requireSession();
  if (!UUID.test(input.id)) return { ok: false, error: 'Ese documento no existe.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    await discardExpiration(
      db,
      { id: input.id, reason: input.reason },
      { userId: user.id, organizationId: user.organization.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: 'Descartado. No se vigila.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo descartar.') };
  }
}

export async function trackExpirationAction(input: TrackInput): Promise<ActionResult> {
  const user = await requireSession();
  const kind = asKind(input.kind);
  if (!kind) return { ok: false, error: 'Elige el tipo de documento.' };
  if (!ISO.test(input.expiresOn ?? ''))
    return { ok: false, error: 'Falta la fecha de vencimiento.' };
  try {
    const db = getOrgScopedClient(user.organization.id);
    const result = await trackExpiration(
      db,
      {
        userId: user.id,
        kind,
        expiresOn: input.expiresOn,
        subject: input.subject ?? null,
        subjectKind: asSubjectKind(input.subjectKind),
        label: input.label ?? null,
        issuer: input.issuer ?? null,
        number: input.number ?? null,
        issuedOn: input.issuedOn && ISO.test(input.issuedOn) ? input.issuedOn : null,
        ownerUserId: input.ownerUserId && UUID.test(input.ownerUserId) ? input.ownerUserId : null,
        renewalLeadDays:
          input.renewalLeadDays != null && Number.isFinite(input.renewalLeadDays)
            ? Math.max(0, Math.min(365, Math.round(input.renewalLeadDays)))
            : null,
      },
      { userId: user.id, organizationId: user.organization.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: `Registrado: ${result.row.title}.` };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo registrar.') };
  }
}

/** Editar en la grilla: responsable y días de anticipación. */
export async function editExpirationCell(
  rowId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const user = await requireSession();
  if (!UUID.test(rowId)) throw new Error('Ese documento no existe.');
  const db = getOrgScopedClient(user.organization.id);
  const ctx = { userId: user.id, organizationId: user.organization.id };
  if (key === 'responsable') {
    const owner = typeof value === 'string' && UUID.test(value) ? value : null;
    await changeExpiration(db, rowId, { ownerUserId: owner }, ctx);
  } else if (key === 'anticipacion') {
    const days = Number(value);
    if (!Number.isFinite(days)) throw new Error('Escribe un número de días.');
    await changeExpiration(db, rowId, { renewalLeadDays: Math.round(days) }, ctx);
  } else {
    throw new Error('Esa columna no se edita aquí.');
  }
  revalidatePath(PATH);
}

export async function linkRenewalAction(input: {
  expirationId: string;
  documentId: string;
}): Promise<ActionResult> {
  const user = await requireSession();
  if (!UUID.test(input.expirationId) || !UUID.test(input.documentId)) {
    return { ok: false, error: 'No reconozco ese documento.' };
  }
  try {
    const db = getOrgScopedClient(user.organization.id);
    const { alreadyScanned } = await queueRenewalUpload(db, input);
    // La ingesta llegó primero: se lee ya, con la pista puesta.
    if (alreadyScanned) await detectDocumentExpiration(db, input.documentId, { force: true });
    revalidatePath(PATH);
    return {
      ok: true,
      note: 'Subido. Cuando termine de leerlo te pido confirmar la fecha nueva en «Por revisar»; al confirmarla, este queda como renovado.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo enlazar la renovación.') };
  }
}

/**
 * Una tanda del barrido de lo que ya estaba en el Cerebro. Sólo quien
 * administra la empresa: cada tanda puede costar llamadas al modelo.
 */
export async function backfillExpirationsAction(): Promise<ActionResult> {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  if (!(await isCompanyManager(db, user.id))) {
    return { ok: false, error: 'Revisar todo el Cerebro lo hace quien administra la empresa.' };
  }
  try {
    const r = await backfillDocumentExpirations(db, { maxDocuments: 40, maxModelCalls: 8 });
    revalidatePath(PATH);
    if (r.scanned === 0 && !r.more) {
      return { ok: true, note: 'Ya revisé todos los documentos del Cerebro.' };
    }
    return {
      ok: true,
      note: `Revisé ${r.scanned} documento${r.scanned === 1 ? '' : 's'} y encontré ${r.found} fecha${r.found === 1 ? '' : 's'} por confirmar.${r.failed ? ` ${r.failed} no se pudieron leer.` : ''}${r.more ? ' Quedan más: vuelve a pulsar para la siguiente tanda.' : ''}`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo revisar el Cerebro.') };
  }
}
