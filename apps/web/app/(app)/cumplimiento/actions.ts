'use server';

import type { ActionResult } from '@/components/compliance/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  COMPLIANCE_ITEM_STATUSES,
  type ComplianceItemStatus,
  LEGAL_CASE_ROLES,
  LEGAL_CASE_STATUSES,
  PQRS_CHANNELS,
  PQRS_KINDS,
  PQRS_MATTERS,
  PQRS_STATUSES,
  type PqrsChannel,
  type PqrsKind,
  type PqrsMatter,
  type PqrsStatus,
  bogotaToday,
  createPqrs,
  isCompanyManager,
  markComplianceItem,
  respondPqrs,
  saveComplianceProfile,
  setPublicPqrsForm,
  updatePqrsState,
  upsertLegalCase,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /cumplimiento (0195). El perfil y el formulario
 * público, sólo quien administra la empresa; lo demás, cualquiera del equipo
 * con el módulo prendido (cada escritura queda en la auditoría).
 */

const UUID = /^[0-9a-f-]{36}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const PATH = '/cumplimiento';

function describe(err: unknown, fallback: string): string {
  if (err instanceof ValidationError) return err.message;
  const m = err instanceof Error ? err.message : '';
  return m && m.length < 300 ? m : fallback;
}
const s = (v: unknown, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = (v: unknown) => {
  const t = s(v, 40).replace(/[^\d.]/g, '');
  return t ? Number(t) : null;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : undefined;

async function session() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  return { user, db, ctx: { userId: user.id, today: bogotaToday() } };
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
    metadata: { via: 'cumplimiento' },
  }).catch(() => undefined);
}

export async function saveProfileAction(input: Record<string, unknown>): Promise<ActionResult> {
  try {
    const { db, ctx, user } = await session();
    if (!(await isCompanyManager(db, user.id)))
      return { ok: false, error: 'El perfil lo edita quien administra la empresa.' };
    const { sync } = await saveComplianceProfile(
      db,
      {
        entityType: s(input.entityType, 40),
        size: s(input.size, 20) || null,
        revenueCop: num(input.revenueCop),
        assetsCop: num(input.assetsCop),
        figuresYear: num(input.figuresYear),
        internationalCop: num(input.internationalCop),
        stateContractsCop: num(input.stateContractsCop),
        supervisor: s(input.supervisor, 40) || 'ninguna',
        sectors: Array.isArray(input.sectors)
          ? input.sectors.filter((x): x is string => typeof x === 'string')
          : [],
        handlesPersonalData: input.handlesPersonalData === true,
        consumerFacing: input.consumerFacing === true,
        employees: num(input.employees),
        complianceOfficer: s(input.complianceOfficer, 160) || null,
        ownerUserId: UUID.test(s(input.ownerUserId, 40)) ? s(input.ownerUserId, 40) : null,
        privacyPolicyUrl: s(input.privacyPolicyUrl, 500) || null,
        pqrsOwnerUserId: UUID.test(s(input.pqrsOwnerUserId, 40))
          ? s(input.pqrsOwnerUserId, 40)
          : null,
      },
      ctx,
    );
    await audit(db, user.id, 'compliance.profile', { via: 'perfil' });
    revalidatePath(PATH);
    return {
      ok: true,
      note: `Guardado. La lista quedó al día (${sync.inserted} nuevas, ${sync.updated} actualizadas).`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude guardar el perfil.') };
  }
}

export async function markItemAction(input: {
  id: string;
  status: string;
  evidenceUrl?: string | null;
  evidenceNote?: string | null;
}): Promise<ActionResult> {
  try {
    const { db, ctx, user } = await session();
    const status = oneOf<ComplianceItemStatus>(input.status, COMPLIANCE_ITEM_STATUSES);
    if (!UUID.test(input.id) || !status)
      return { ok: false, error: 'No reconozco esa obligación.' };
    const row = await markComplianceItem(
      db,
      {
        id: input.id,
        status,
        evidenceUrl: input.evidenceUrl ?? null,
        evidenceNote: input.evidenceNote ?? null,
      },
      ctx,
    );
    await audit(db, user.id, 'compliance.mark', { item: row.item_key, status });
    revalidatePath(PATH);
    return { ok: true, note: 'Guardado.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude guardarlo.') };
  }
}

export async function createPqrsAction(input: Record<string, unknown>): Promise<ActionResult> {
  try {
    const { db, user } = await session();
    const kind = oneOf<PqrsKind>(input.kind, PQRS_KINDS);
    const channel = oneOf<PqrsChannel>(input.channel, PQRS_CHANNELS);
    if (!kind || !channel || channel === 'formulario')
      return { ok: false, error: 'Elige la clase y el canal.' };
    const receivedOn = s(input.receivedOn, 10);
    const row = await createPqrs(
      db,
      {
        kind,
        channel,
        matter: oneOf<PqrsMatter>(input.matter, PQRS_MATTERS) ?? 'general',
        subject: s(input.subject, 200),
        body: s(input.body, 8000),
        requesterName: s(input.requesterName, 160),
        requesterEmail: s(input.requesterEmail, 200) || null,
        requesterPhone: s(input.requesterPhone, 40) || null,
        receivedAt: ISO.test(receivedOn) ? `${receivedOn}T12:00:00-05:00` : null,
        assignedUserId: UUID.test(s(input.assignedUserId, 40)) ? s(input.assignedUserId, 40) : null,
      },
      { userId: user.id },
    );
    await audit(db, user.id, 'compliance.pqrs_create', { radicado: row.radicado });
    revalidatePath(PATH);
    return { ok: true, id: row.id, note: `Radicada ${row.radicado}. Plazo: ${row.due_on}.` };
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude radicarla.') };
  }
}

export async function respondPqrsAction(input: {
  id: string;
  text: string;
  close: boolean;
}): Promise<ActionResult> {
  try {
    const { db, ctx, user } = await session();
    if (!UUID.test(input.id)) return { ok: false, error: 'Esa PQRS no existe.' };
    const row = await respondPqrs(db, { id: input.id, text: input.text, close: input.close }, ctx);
    await audit(db, user.id, 'compliance.pqrs_respond', { radicado: row.radicado });
    revalidatePath(PATH);
    return {
      ok: true,
      note: row.requester_email
        ? `Respuesta guardada. Falta enviarla a ${row.requester_email} (cópiala en un correo o pídeselo a Cortex en el chat).`
        : 'Respuesta guardada.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude guardar la respuesta.') };
  }
}

export async function updatePqrsAction(input: {
  id: string;
  status?: string;
  assignedUserId?: string | null;
  extendTo?: string | null;
  extensionReason?: string | null;
}): Promise<ActionResult> {
  try {
    const { db, ctx } = await session();
    if (!UUID.test(input.id)) return { ok: false, error: 'Esa PQRS no existe.' };
    await updatePqrsState(
      db,
      {
        id: input.id,
        status: oneOf<PqrsStatus>(input.status, PQRS_STATUSES),
        assignedUserId:
          input.assignedUserId === undefined
            ? undefined
            : input.assignedUserId && UUID.test(input.assignedUserId)
              ? input.assignedUserId
              : null,
        extendTo: input.extendTo && ISO.test(input.extendTo) ? input.extendTo : null,
        extensionReason: input.extensionReason ?? null,
      },
      ctx,
    );
    revalidatePath(PATH);
    return {
      ok: true,
      note: input.extendTo
        ? 'Plazo ampliado. Avísale el nuevo plazo y la razón a quien la presentó.'
        : 'Guardado.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude guardarlo.') };
  }
}

export async function saveCaseAction(input: Record<string, unknown>): Promise<ActionResult> {
  try {
    const { db, ctx, user } = await session();
    const date = (v: unknown) => (ISO.test(s(v, 10)) ? s(v, 10) : null);
    const id = s(input.id, 40);
    const { row, created } = await upsertLegalCase(
      db,
      {
        id: UUID.test(id) ? id : undefined,
        radicado: s(input.radicado, 40) || null,
        title: s(input.title, 200) || undefined,
        court: s(input.court, 300) || null,
        city: s(input.city, 120) || null,
        processType: s(input.processType, 160) || null,
        role: oneOf(input.role, LEGAL_CASE_ROLES),
        counterparty: s(input.counterparty, 300) || null,
        status: oneOf(input.status, LEGAL_CASE_STATUSES),
        lastActionOn: date(input.lastActionOn),
        lastAction: s(input.lastAction, 1000) || null,
        nextHearingOn: date(input.nextHearingOn),
        nextHearing: s(input.nextHearing, 600) || null,
        lawyer: s(input.lawyer, 200) || null,
        checkedVia: 'manual',
      },
      ctx,
    );
    await audit(db, user.id, 'compliance.case_update', { id: row.id, created });
    revalidatePath(PATH);
    return { ok: true, id: row.id, note: created ? 'Proceso registrado.' : 'Proceso actualizado.' };
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude guardar el proceso.') };
  }
}

export async function setPublicFormAction(input: {
  enabled: boolean;
  rotate?: boolean;
}): Promise<ActionResult> {
  try {
    const { db, ctx, user } = await session();
    if (!(await isCompanyManager(db, user.id)))
      return { ok: false, error: 'El formulario lo prende quien administra la empresa.' };
    await setPublicPqrsForm(db, { enabled: input.enabled, rotate: input.rotate }, ctx);
    revalidatePath(PATH);
    return {
      ok: true,
      note: input.enabled
        ? input.rotate
          ? 'Enlace nuevo: el anterior ya no abre.'
          : 'Formulario prendido.'
        : 'Formulario apagado.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude cambiarlo.') };
  }
}
