import { ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { addDays, bogotaToday } from '../commitments/shape';
import {
  confirmExtracted,
  createCommitment,
  dropCommitment,
  getCommitment,
  markMet,
  rescheduleCommitment,
} from '../commitments/store';
import { listCompanyFacts } from '../company/store';
import { quoteStatesDate } from '../doc-expirations/dates';
import { subjectKey } from '../doc-expirations/kinds';
import { confirmExpiration, discardExpiration, trackExpiration } from '../doc-expirations/ops';
import { getExpiration, listExpirations } from '../doc-expirations/store';
import type { DocumentChunk } from '../documents/verify';
import { type ContractReading, readContract } from './extract';
import {
  type ContractRow,
  type ContractStatus,
  type ContractType,
  type CounterpartyKind,
  type ObligationCategory,
  type ObligationParty,
  type ObligationRecurrence,
  type ObligationRow,
  type Renewal,
  contractTerm,
  deriveContractStatus,
  monthsBetween,
} from './shape';
import {
  addContractEvent,
  deletePendingReadObligations,
  getCompanyTemplate,
  getObligation,
  insertContract,
  insertObligations,
  requireContract,
  updateContract,
  updateObligation,
} from './store';
import {
  type ContractTemplate,
  type FillContext,
  type FillResult,
  builtinTemplate,
  fillTemplate,
  missingRequired,
  remainingPlaceholders,
} from './templates';
import { foldText } from './text';

/**
 * LAS DECISIONES SOBRE UN CONTRATO, COMPLETAS (0195).
 *
 * Las llaman las herramientas del chat y las acciones de /contratos, así que
 * las dos superficies no pueden hacer cosas distintas con el mismo clic:
 * redactar desde una plantilla, editar el texto, mandarlo a revisión, marcarlo
 * firmado (con la copia firmada), terminarlo; leer sus obligaciones y
 * confirmarlas; y dejar vigilado lo que vence.
 *
 * QUÉ SE VIGILA Y CÓMO, SIN DUPLICAR:
 *   - El FIN del período en curso → un papel «contrato» en Documentos que
 *     vencen (0184). Si ya hay uno (leído del mismo documento, o del mismo
 *     cliente con la misma fecha) se ENLAZA; sólo si no hay ninguno se crea.
 *   - El AVISO PREVIO (hasta cuándo se puede avisar que no se renueva) → su
 *     propio vencimiento en `commitments`, con responsable.
 *   - Cada OBLIGACIÓN confirmada con fecha → su vencimiento en `commitments`.
 */

export interface OpsContext {
  userId: string;
  organizationId: string;
  today?: string;
}

const SIGNED: ContractStatus[] = ['firmado', 'vigente', 'vencido'];

// ---------------------------------------------------------------------------
// Lo que se sabe sin preguntar
// ---------------------------------------------------------------------------

/** La ficha de la empresa (0104), leída por etiqueta. */
export function companyFromFacts(
  facts: Array<{ label: string; value: string }>,
  fallbackName?: string | null,
): NonNullable<FillContext['company']> {
  const out: NonNullable<FillContext['company']> = {};
  for (const f of facts) {
    const l = foldText(f.label);
    const v = f.value.trim();
    if (!v) continue;
    if (l.includes('razon social') || l === 'nombre de la empresa') out.nombre ??= v;
    else if (l.includes('cedula') && l.includes('representante')) out.representante_id ??= v;
    else if (l.includes('representante legal') || l === 'representante') out.representante ??= v;
    else if (l === 'nit' || l.startsWith('nit ')) out.nit ??= v;
    else if (l.includes('direccion')) out.direccion ??= v;
    else if (l === 'ciudad' || l.includes('ciudad principal') || l.includes('domicilio'))
      out.ciudad ??= v;
    else if (l.includes('correo')) out.correo ??= v;
  }
  if (!out.nombre && fallbackName?.trim()) out.nombre = fallbackName.trim();
  return out;
}

export interface CounterpartyLink {
  kind: CounterpartyKind;
  clientId?: string | null;
  supplierId?: string | null;
  employeeUserId?: string | null;
  /** Para «otro», o para nombrar a alguien sin registro. */
  name?: string | null;
  idNumber?: string | null;
}

/** La contraparte enlazada, como la ven las plantillas. */
export async function counterpartyFromRecords(
  db: SupabaseClient,
  link: CounterpartyLink,
): Promise<NonNullable<FillContext['counterparty']>> {
  const out: NonNullable<FillContext['counterparty']> = {};
  if (link.clientId) {
    const { data, error } = await db
      .from('clients')
      .select('id, name, legal_name, tax_id, tax_id_dv, address, city')
      .eq('id', link.clientId)
      .maybeSingle();
    if (error) throw error;
    const c = data as {
      name: string;
      legal_name: string | null;
      tax_id: string | null;
      tax_id_dv: number | null;
      address: string | null;
      city: string | null;
    } | null;
    if (c) {
      out.nombre = c.legal_name?.trim() || c.name;
      if (c.tax_id) out.id = `NIT ${c.tax_id}${c.tax_id_dv !== null ? `-${c.tax_id_dv}` : ''}`;
      if (c.address) out.direccion = c.city ? `${c.address}, ${c.city}` : c.address;
      if (c.city) out.ciudad = c.city;
      const { data: contacts, error: cErr } = await db
        .from('client_contacts')
        .select('full_name, email, is_primary, status')
        .eq('client_id', link.clientId)
        .limit(20);
      if (cErr) throw cErr;
      const list = (contacts ?? []) as Array<{
        full_name: string;
        email: string | null;
        is_primary: boolean | null;
        status: string | null;
      }>;
      const primary =
        list.find((p) => p.is_primary && p.email && p.status !== 'left') ??
        list.find((p) => p.email && p.status !== 'left');
      if (primary?.email) out.correo = primary.email;
    }
  } else if (link.supplierId) {
    const { data, error } = await db
      .from('suppliers')
      .select('id, name, nit, email')
      .eq('id', link.supplierId)
      .maybeSingle();
    if (error) throw error;
    const s = data as { name: string; nit: string | null; email: string | null } | null;
    if (s) {
      out.nombre = s.name;
      if (s.nit) out.id = `NIT ${s.nit}`;
      if (s.email) out.correo = s.email;
    }
  } else if (link.employeeUserId) {
    const { data, error } = await db
      .from('users')
      .select('id, name, email')
      .eq('id', link.employeeUserId)
      .maybeSingle();
    if (error) throw error;
    const u = data as { name: string | null; email: string } | null;
    if (u) {
      if (u.name?.trim()) out.nombre = u.name.trim();
      out.correo = u.email;
    }
  }
  if (link.name?.trim()) out.nombre = link.name.trim();
  if (link.idNumber?.trim()) out.id = link.idNumber.trim();
  return out;
}

export async function buildFillContext(
  db: SupabaseClient,
  input: {
    link: CounterpartyLink;
    startOn?: string | null;
    endOn?: string | null;
    valueAmount?: number | null;
    currency?: string;
    noticeDays?: number | null;
    organizationName?: string | null;
    today?: string;
  },
): Promise<FillContext> {
  const [facts, counterparty] = await Promise.all([
    listCompanyFacts(db).catch(() => []),
    counterpartyFromRecords(db, input.link),
  ]);
  return {
    today: input.today ?? bogotaToday(),
    company: companyFromFacts(facts, input.organizationName),
    counterparty,
    contract: {
      start_on: input.startOn ?? null,
      end_on: input.endOn ?? null,
      value_amount: input.valueAmount ?? null,
      currency: input.currency ?? 'COP',
      notice_days: input.noticeDays ?? null,
      months:
        input.startOn && input.endOn ? monthsBetween(input.startOn, addDays(input.endOn, 1)) : null,
    },
  };
}

/** La plantilla de serie o una propia («propia:<uuid>»). */
export async function resolveTemplate(
  db: SupabaseClient,
  key: string,
): Promise<{ template: ContractTemplate; templateId: string | null } | null> {
  if (key.startsWith('propia:')) {
    const row = await getCompanyTemplate(db, key.slice('propia:'.length));
    if (!row || row.status !== 'activa') return null;
    const base = row.builtin_key ? builtinTemplate(row.builtin_key) : null;
    return {
      templateId: row.id,
      template: {
        key,
        type: row.contract_type,
        name: row.name,
        description: row.description ?? '',
        counterpartyKind: base?.counterpartyKind ?? 'otro',
        counterpartyRole: base?.counterpartyRole ?? 'LA CONTRAPARTE',
        defaults: base?.defaults ?? { renewal: 'ninguna', noticeDays: null },
        fields: row.fields,
        body: row.body,
        legalNotes: base?.legalNotes ?? [],
      },
    };
  }
  const builtin = builtinTemplate(key);
  return builtin ? { template: builtin, templateId: null } : null;
}

// ---------------------------------------------------------------------------
// Redactar
// ---------------------------------------------------------------------------

export interface DraftInput {
  templateKey: string;
  title?: string | null;
  link: CounterpartyLink;
  values?: Record<string, string | number | null | undefined>;
  startOn?: string | null;
  endOn?: string | null;
  valueAmount?: number | null;
  currency?: string;
  valueNote?: string | null;
  renewal?: Renewal | null;
  renewalMonths?: number | null;
  noticeDays?: number | null;
  ownerUserId?: string | null;
  parentContractId?: string | null;
  /** Cláusulas que Cortex redactó en el chat, marcadas para revisión. */
  extraClauses?: Array<{ title: string; text: string }>;
  draftedWith?: 'plantilla' | 'chat';
  organizationName?: string | null;
}

export interface DraftResult {
  row: ContractRow;
  fill: FillResult;
  missingRequired: string[];
  template: ContractTemplate;
}

function insertClauses(text: string, clauses: Array<{ title: string; text: string }>): string {
  if (clauses.length === 0) return text;
  const block = [
    'CLÁUSULAS ADICIONALES (redactadas con Cortex a partir de lo conversado — revisar con especial cuidado)',
    ...clauses.map(
      (c, i) =>
        `ADICIONAL ${i + 1}. ${c.title.trim().toUpperCase().slice(0, 120)}. ${c.text.trim().slice(0, 4000)}`,
    ),
  ].join('\n\n');
  const anchor = text.indexOf('Para constancia se firma');
  if (anchor === -1) return `${text.trimEnd()}\n\n${block}\n`;
  return `${text.slice(0, anchor)}${block}\n\n${text.slice(anchor)}`;
}

function ISO_OR_NULL(v: string | null | undefined): string | null {
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

export async function draftContract(
  db: SupabaseClient,
  input: DraftInput,
  ctx: OpsContext,
): Promise<DraftResult> {
  const resolved = await resolveTemplate(db, input.templateKey);
  if (!resolved) throw new ValidationError(`No conozco la plantilla «${input.templateKey}».`);
  const { template, templateId } = resolved;
  const startOn = ISO_OR_NULL(input.startOn);
  const endOn = ISO_OR_NULL(input.endOn);
  if (startOn && endOn && startOn > endOn) {
    throw new ValidationError('La fecha de terminación no puede ser anterior a la de inicio.');
  }
  const noticeDays = input.noticeDays ?? template.defaults.noticeDays;
  const fillCtx = await buildFillContext(db, {
    link: input.link,
    startOn,
    endOn,
    valueAmount: input.valueAmount ?? null,
    currency: input.currency,
    noticeDays,
    organizationName: input.organizationName,
    today: ctx.today,
  });
  const fill = fillTemplate(template, fillCtx, input.values ?? {});
  const text = insertClauses(fill.text, input.extraClauses ?? []);
  const counterpartyName = fillCtx.counterparty?.nombre ?? null;
  const title =
    input.title?.trim() ||
    `${template.name}${counterpartyName ? ` — ${counterpartyName}` : ''}`.slice(0, 200);
  const row = await insertContract(db, {
    contract_type: template.type,
    title,
    template_key: template.key,
    template_id: templateId,
    counterparty_kind: input.link.kind,
    counterparty_name: counterpartyName,
    counterparty_id_number: fillCtx.counterparty?.id ?? null,
    client_id: input.link.clientId ?? null,
    supplier_id: input.link.supplierId ?? null,
    employee_user_id: input.link.employeeUserId ?? null,
    parent_contract_id: input.parentContractId ?? null,
    value_amount: input.valueAmount ?? null,
    currency: input.currency ?? 'COP',
    value_note: input.valueNote?.trim() || null,
    start_on: startOn,
    end_on: endOn,
    renewal: input.renewal ?? template.defaults.renewal,
    renewal_months: input.renewalMonths ?? template.defaults.renewalMonths ?? null,
    notice_days: noticeDays,
    status: 'borrador',
    body_text: text,
    placeholders: remainingPlaceholders(text),
    drafted_with: input.draftedWith ?? 'plantilla',
    owner_user_id: input.ownerUserId ?? ctx.userId,
    created_by: ctx.userId,
  });
  await addContractEvent(db, {
    contractId: row.id,
    kind: 'creado',
    detail: `Borrador desde «${template.name}»${
      input.draftedWith === 'chat' ? ', redactado con Cortex en el chat' : ''
    }. ${fill.missing.length ? `Faltan ${fill.missing.length} datos.` : 'Sin datos pendientes.'}`,
    actorUserId: ctx.userId,
  });
  return { row, fill, missingRequired: missingRequired(template, fill), template };
}

export async function editContractText(
  db: SupabaseClient,
  input: { id: string; text: string },
  ctx: OpsContext,
): Promise<ContractRow> {
  const current = await requireContract(db, input.id);
  if (current.status !== 'borrador' && current.status !== 'en_revision') {
    throw new ValidationError(
      'Un contrato firmado no se edita aquí: para cambiarlo, redacta un otrosí.',
    );
  }
  const text = input.text.slice(0, 120_000);
  const row = await updateContract(db, input.id, {
    body_text: text,
    placeholders: remainingPlaceholders(text),
  });
  await addContractEvent(db, { contractId: row.id, kind: 'editado', actorUserId: ctx.userId });
  return row;
}

// ---------------------------------------------------------------------------
// Estados
// ---------------------------------------------------------------------------

export interface TermPatch {
  startOn?: string | null;
  endOn?: string | null;
  renewal?: Renewal;
  renewalMonths?: number | null;
  noticeDays?: number | null;
  valueAmount?: number | null;
  valueNote?: string | null;
  ownerUserId?: string | null;
  title?: string;
}

export async function updateContractTerm(
  db: SupabaseClient,
  id: string,
  patch: TermPatch,
  ctx: OpsContext,
): Promise<{ row: ContractRow; watch: WatchResult }> {
  const current = await requireContract(db, id);
  const next: Partial<ContractRow> = {};
  if (patch.startOn !== undefined) next.start_on = ISO_OR_NULL(patch.startOn);
  if (patch.endOn !== undefined) next.end_on = ISO_OR_NULL(patch.endOn);
  if (patch.renewal !== undefined) next.renewal = patch.renewal;
  if (patch.renewalMonths !== undefined) next.renewal_months = patch.renewalMonths;
  if (patch.noticeDays !== undefined) next.notice_days = patch.noticeDays;
  if (patch.valueAmount !== undefined) next.value_amount = patch.valueAmount;
  if (patch.valueNote !== undefined) next.value_note = patch.valueNote?.trim() || null;
  if (patch.ownerUserId !== undefined) next.owner_user_id = patch.ownerUserId;
  if (patch.title !== undefined && patch.title.trim().length >= 3) next.title = patch.title.trim();
  const start = next.start_on !== undefined ? next.start_on : current.start_on;
  const end = next.end_on !== undefined ? next.end_on : current.end_on;
  if (start && end && start > end) {
    throw new ValidationError('La fecha de terminación no puede ser anterior a la de inicio.');
  }
  let row = await updateContract(db, id, next);
  if (SIGNED.includes(row.status)) {
    const status = deriveContractStatus(row, ctx.today ?? bogotaToday());
    if (status !== row.status) row = await updateContract(db, id, { status });
  }
  const watch = await syncContractWatch(db, row, ctx);
  return { row: watch.row, watch };
}

export async function sendToReview(
  db: SupabaseClient,
  id: string,
  ctx: OpsContext,
): Promise<ContractRow> {
  const current = await requireContract(db, id);
  if (current.status !== 'borrador') return current;
  const row = await updateContract(db, id, { status: 'en_revision' });
  await addContractEvent(db, {
    contractId: id,
    kind: 'en_revision',
    detail: current.placeholders.length
      ? `Va a revisión con ${current.placeholders.length} datos sin completar.`
      : 'Va a revisión del abogado.',
    actorUserId: ctx.userId,
  });
  return row;
}

export async function markSigned(
  db: SupabaseClient,
  input: { id: string; signedAt?: string | null; documentId?: string | null },
  ctx: OpsContext,
): Promise<{ row: ContractRow; watch: WatchResult }> {
  const current = await requireContract(db, input.id);
  if (current.status === 'terminado') throw new ValidationError('Ese contrato ya está terminado.');
  const today = ctx.today ?? bogotaToday();
  const signedAt =
    ISO_OR_NULL(input.signedAt) ?? current.signed_at ?? (input.documentId ? null : today);
  const documentId = input.documentId ?? current.document_id;
  if (!signedAt && !documentId) {
    throw new ValidationError(
      'Para marcarlo firmado, sube la copia firmada o di la fecha de firma.',
    );
  }
  let row = await updateContract(db, input.id, {
    status: 'firmado',
    signed_at: signedAt,
    document_id: documentId,
  });
  const status = deriveContractStatus(row, today);
  if (status !== row.status) row = await updateContract(db, input.id, { status });
  await addContractEvent(db, {
    contractId: input.id,
    kind:
      input.documentId && input.documentId !== current.document_id ? 'copia_firmada' : 'firmado',
    detail: input.documentId
      ? `Se subió la copia firmada${signedAt ? ` (firma: ${signedAt})` : ''}.`
      : `Marcado firmado el ${signedAt}.`,
    actorUserId: ctx.userId,
  });
  const watch = await syncContractWatch(db, row, ctx);
  return { row: watch.row, watch };
}

export async function terminateContract(
  db: SupabaseClient,
  input: { id: string; terminatedOn: string; reason: string },
  ctx: OpsContext,
): Promise<ContractRow> {
  const current = await requireContract(db, input.id);
  const on = ISO_OR_NULL(input.terminatedOn);
  if (!on) throw new ValidationError('La fecha de terminación va como AAAA-MM-DD.');
  if (!input.reason.trim()) throw new ValidationError('Di por qué termina.');
  const row = await updateContract(db, input.id, {
    status: 'terminado',
    terminated_on: on,
    termination_reason: input.reason.trim().slice(0, 600),
  });
  await closeWatches(db, row, `Contrato terminado: ${input.reason.trim().slice(0, 200)}`, ctx);
  await addContractEvent(db, {
    contractId: input.id,
    kind: 'terminado',
    detail: `Terminado el ${on}: ${input.reason.trim().slice(0, 300)}`,
    actorUserId: ctx.userId,
  });
  return row;
}

// ---------------------------------------------------------------------------
// Lo que se vigila
// ---------------------------------------------------------------------------

export interface WatchResult {
  row: ContractRow;
  expiration: 'none' | 'linked' | 'created' | 'renewed' | 'kept';
  notice: 'none' | 'created' | 'updated' | 'kept' | 'passed';
}

function subjectKindFor(kind: CounterpartyKind): 'cliente' | 'empleado' | 'otro' {
  return kind === 'cliente' ? 'cliente' : kind === 'empleado' ? 'empleado' : 'otro';
}

/**
 * Deja vigilado lo que vence de un contrato firmado. Idempotente: llamarlo dos
 * veces no crea dos vencimientos.
 */
export async function syncContractWatch(
  db: SupabaseClient,
  row: ContractRow,
  ctx: OpsContext,
): Promise<WatchResult> {
  const today = ctx.today ?? bogotaToday();
  if (!SIGNED.includes(row.status)) return { row, expiration: 'none', notice: 'none' };
  const term = contractTerm(row, today);
  let current = row;
  let expiration: WatchResult['expiration'] = 'none';
  let notice: WatchResult['notice'] = 'none';
  const owner = row.owner_user_id ?? row.created_by ?? ctx.userId;
  const sync = { userId: ctx.userId, organizationId: ctx.organizationId, today };

  // 1. El fin del período en curso, en Documentos que vencen.
  if (term.currentEnd) {
    const linked = row.expiration_id ? await getExpiration(db, row.expiration_id) : null;
    const linkedOpen = linked && linked.status !== 'renovado' && linked.status !== 'descartado';
    if (linkedOpen && linked.expires_on === term.currentEnd) {
      expiration = 'kept';
    } else {
      const found = linkedOpen ? null : await findContractExpiration(db, row, term.currentEnd);
      if (found) {
        if (found.needs_review) {
          // La persona acaba de confirmar esta misma fecha en Contratos.
          await confirmExpiration(
            db,
            { id: found.id, userId: ctx.userId, ownerUserId: owner, today },
            sync,
          );
        }
        current = await updateContract(db, row.id, { expiration_id: found.id });
        expiration = 'linked';
      } else {
        if (linkedOpen && linked.expires_on && linked.expires_on > term.currentEnd) {
          // La fecha se corrigió hacia atrás: lo anterior no era cierto.
          await discardExpiration(
            db,
            { id: linked.id, reason: 'Fecha corregida en Contratos.' },
            sync,
          );
        }
        const tracked = await trackExpiration(
          db,
          {
            userId: ctx.userId,
            kind: 'contrato',
            expiresOn: term.currentEnd,
            subject: row.counterparty_name,
            subjectKind: subjectKindFor(row.counterparty_kind),
            label: row.title.slice(0, 120),
            issuer: row.counterparty_name,
            issuedOn: row.start_on && row.start_on <= term.currentEnd ? row.start_on : null,
            ownerUserId: owner,
            documentId: row.document_id,
            renewalLeadDays: Math.min(365, Math.max(15, (row.notice_days ?? 0) + 15)),
            today,
          },
          sync,
        );
        current = await updateContract(db, row.id, { expiration_id: tracked.row.id });
        expiration = linkedOpen ? 'renewed' : 'created';
      }
    }
  }

  // 2. El aviso previo, como vencimiento con responsable.
  if (term.noticeDeadline && row.renewal !== 'ninguna') {
    const existing = row.notice_commitment_id
      ? await getCommitment(db, row.notice_commitment_id)
      : null;
    const open = existing && existing.state !== 'met' && existing.state !== 'dropped';
    if (term.noticeDeadline < today) {
      notice = 'passed';
    } else if (open && existing.due_on === term.noticeDeadline) {
      notice = 'kept';
    } else if (open) {
      await rescheduleCommitment(db, { id: existing.id, dueOn: term.noticeDeadline, today });
      notice = 'updated';
    } else {
      const created = await createCommitment(db, {
        title: `Aviso previo: ${row.title}`.slice(0, 200),
        detail: `Último día para avisar por escrito que no se renueva (${row.notice_days} días antes del ${term.currentEnd}). ${
          row.renewal === 'automatica'
            ? 'Si nadie avisa, el contrato se renueva solo.'
            : 'Después de esta fecha ya no hay tiempo para negociar la prórroga con calma.'
        } Verifica el plazo y la forma de aviso en el contrato.`,
        kind: 'contract',
        dueOn: term.noticeDeadline,
        noticeDays: Math.min(15, Math.max(3, Math.round((row.notice_days ?? 30) / 2))),
        counterparty: row.counterparty_name,
        amountCop: row.currency === 'COP' ? row.value_amount : null,
        ownerUserId: owner,
        recurrence: 'none',
        source: { kind: 'manual', userId: ctx.userId },
        createdBy: ctx.userId,
      });
      if (row.client_id) {
        const { error } = await db
          .from('commitments')
          .update({ client_id: row.client_id })
          .eq('id', created.id);
        if (error) throw error;
      }
      current = await updateContract(db, row.id, { notice_commitment_id: created.id });
      notice = 'created';
      await addContractEvent(db, {
        contractId: row.id,
        kind: 'aviso',
        detail: `Aviso previo vigilado: hasta el ${term.noticeDeadline}.`,
        actorUserId: ctx.userId,
      });
    }
  }
  if (expiration === 'created' || expiration === 'linked' || expiration === 'renewed') {
    await addContractEvent(db, {
      contractId: row.id,
      kind: 'vencimiento',
      detail:
        expiration === 'linked'
          ? `Enlazado al vencimiento que ya vigilaba Documentos que vencen (${term.currentEnd}).`
          : `Vence el ${term.currentEnd}: queda en Documentos que vencen.`,
      actorUserId: ctx.userId,
    });
  }
  return { row: current, expiration, notice };
}

/** ¿Ya vigila alguien el fin de este contrato? Mismo documento, o mismo cliente y fecha. */
async function findContractExpiration(db: SupabaseClient, row: ContractRow, endOn: string) {
  const candidates = await listExpirations(db, { kind: 'contrato', limit: 500 });
  const key = subjectKey(row.counterparty_name);
  return (
    candidates.find((e) => row.document_id && e.document_id === row.document_id) ??
    candidates.find(
      (e) =>
        e.expires_on === endOn &&
        ((row.client_id && e.client_id === row.client_id) || (key && e.subject_key === key)),
    ) ??
    null
  );
}

async function closeWatches(db: SupabaseClient, row: ContractRow, reason: string, ctx: OpsContext) {
  const today = ctx.today ?? bogotaToday();
  if (row.notice_commitment_id) {
    const c = await getCommitment(db, row.notice_commitment_id);
    if (c && c.state !== 'met' && c.state !== 'dropped') {
      await dropCommitment(db, { id: c.id, reason, userId: ctx.userId });
    }
  }
  if (row.expiration_id) {
    const e = await getExpiration(db, row.expiration_id);
    if (e && e.status !== 'renovado' && e.status !== 'descartado') {
      await discardExpiration(
        db,
        { id: e.id, reason },
        { userId: ctx.userId, organizationId: ctx.organizationId, today },
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Obligaciones
// ---------------------------------------------------------------------------

/** Los fragmentos de texto de un documento del Cerebro, en orden. */
export async function loadDocumentChunks(
  db: SupabaseClient,
  documentId: string,
): Promise<DocumentChunk[]> {
  const { data, error } = await db
    .from('kb_chunks')
    .select('id, chunk_index, content')
    .eq('document_id', documentId)
    .order('chunk_index', { ascending: true })
    .limit(300);
  if (error) throw error;
  return (data ?? []) as DocumentChunk[];
}

export interface ExtractResult {
  reading: ContractReading;
  inserted: ObligationRow[];
  documentId: string;
}

/**
 * Lee el contrato (su copia firmada, o el documento que se indique) y deja sus
 * obligaciones como PROPUESTAS, cada una con su frase. Volver a leer
 * reemplaza las propuestas que nadie ha confirmado; lo confirmado no se toca.
 */
export async function extractContractObligations(
  db: SupabaseClient,
  input: { contractId: string; documentId?: string | null },
  ctx: OpsContext,
): Promise<ExtractResult> {
  const contract = await requireContract(db, input.contractId);
  const documentId = input.documentId ?? contract.document_id;
  if (!documentId) {
    throw new ValidationError(
      'Este contrato no tiene documento todavía: sube la copia firmada (o el contrato en PDF o Word) y vuelve a pedirlo.',
    );
  }
  const today = ctx.today ?? bogotaToday();
  const chunks = await loadDocumentChunks(db, documentId);
  const reading = await readContract(chunks, today);
  if (input.documentId && input.documentId !== contract.document_id && !contract.document_id) {
    await updateContract(db, contract.id, { document_id: input.documentId });
  }
  if (!reading.modelCalled) return { reading, inserted: [], documentId };

  await deletePendingReadObligations(db, contract.id);
  const inserted = await insertObligations(
    db,
    reading.obligations.map((o) => ({
      contract_id: contract.id,
      party: o.party,
      responsible_label: o.responsibleLabel,
      category: o.category,
      description: o.description,
      due_on: o.dueOn,
      recurrence: o.recurrence,
      due_note: o.dueNote,
      penalty: o.penalty,
      evidence_quote: o.quote,
      chunk_id: o.chunkId,
      source: 'documento' as const,
      status: 'propuesta' as const,
      confidence: o.confidence,
      review_note: o.reviewNote,
      owner_user_id: o.party === 'contraparte' ? null : (contract.owner_user_id ?? null),
      created_by: ctx.userId,
    })),
  );
  await addContractEvent(db, {
    contractId: contract.id,
    kind: 'obligaciones',
    detail: `Leí ${inserted.length} obligaciones con su frase${
      reading.rejected.length ? ` y descarté ${reading.rejected.length} sin evidencia` : ''
    }. Esperan que alguien las confirme.`,
    actorUserId: ctx.userId,
  });
  return { reading, inserted, documentId };
}

export interface ConfirmObligationInput {
  id: string;
  ownerUserId?: string | null;
  dueOn?: string | null;
  recurrence?: ObligationRecurrence;
  noticeDays?: number | null;
  description?: string | null;
}

function commitmentKindFor(o: Pick<ObligationRow, 'category' | 'party'>): 'payment' | 'contract' {
  return o.category === 'pago' && o.party !== 'contraparte' ? 'payment' : 'contract';
}

/**
 * Una persona confirma una obligación (y la corrige si hace falta). Con fecha,
 * nace su vencimiento con responsable; sin fecha, queda registrada y se dice
 * que no genera aviso.
 */
export async function confirmObligation(
  db: SupabaseClient,
  input: ConfirmObligationInput,
  ctx: OpsContext,
): Promise<{ row: ObligationRow; commitmentId: string | null }> {
  const current = await getObligation(db, input.id);
  if (!current) throw new ValidationError('Esa obligación ya no existe.');
  if (current.status === 'descartada') throw new ValidationError('Esa obligación se descartó.');
  const contract = await requireContract(db, current.contract_id);
  const dueOn = input.dueOn === undefined ? current.due_on : ISO_OR_NULL(input.dueOn);
  const recurrence = input.recurrence ?? current.recurrence;
  const owner =
    input.ownerUserId === undefined
      ? (current.owner_user_id ?? contract.owner_user_id ?? ctx.userId)
      : input.ownerUserId;
  const now = new Date().toISOString();
  let row = await updateObligation(db, current.id, {
    status: current.status === 'cumplida' ? 'cumplida' : 'confirmada',
    due_on: dueOn,
    recurrence,
    owner_user_id: owner,
    notice_days: input.noticeDays ?? current.notice_days,
    description: input.description?.trim() || current.description,
    confirmed_by: ctx.userId,
    confirmed_at: now,
  });

  let commitmentId = row.commitment_id;
  if (dueOn && !commitmentId) {
    const fromDocument =
      row.source === 'documento' &&
      !!contract.document_id &&
      !!row.evidence_quote &&
      dueOn === current.due_on &&
      quoteStatesDate(row.evidence_quote, dueOn);
    const created = await createCommitment(db, {
      title: `${row.description}`.slice(0, 200),
      detail: `Obligación del contrato «${contract.title}»${row.penalty ? `. Sanción: ${row.penalty.slice(0, 300)}` : ''}.`,
      kind: commitmentKindFor(row),
      dueOn,
      noticeDays: row.notice_days ?? undefined,
      counterparty: contract.counterparty_name,
      ownerUserId: owner,
      recurrence,
      source: fromDocument
        ? {
            kind: 'document',
            documentId: contract.document_id as string,
            chunkId: row.chunk_id,
            quote: row.evidence_quote as string,
          }
        : { kind: 'manual', userId: ctx.userId },
      createdBy: ctx.userId,
    });
    if (fromDocument) {
      await confirmExtracted(db, {
        id: created.id,
        userId: ctx.userId,
        organizationId: ctx.organizationId,
      });
    }
    if (contract.client_id) {
      const { error } = await db
        .from('commitments')
        .update({ client_id: contract.client_id })
        .eq('id', created.id);
      if (error) throw error;
    }
    commitmentId = created.id;
    row = await updateObligation(db, row.id, { commitment_id: created.id });
  } else if (dueOn && commitmentId) {
    const c = await getCommitment(db, commitmentId);
    if (c && c.state !== 'met' && c.state !== 'dropped' && c.due_on !== dueOn) {
      await rescheduleCommitment(db, { id: c.id, dueOn, today: ctx.today });
    }
  }
  return { row, commitmentId };
}

export async function discardObligation(
  db: SupabaseClient,
  input: { id: string; reason?: string | null },
  ctx: OpsContext,
): Promise<ObligationRow> {
  const current = await getObligation(db, input.id);
  if (!current) throw new ValidationError('Esa obligación ya no existe.');
  if (current.commitment_id) {
    const c = await getCommitment(db, current.commitment_id);
    if (c && c.state !== 'met' && c.state !== 'dropped') {
      await dropCommitment(db, {
        id: c.id,
        reason: `Obligación descartada${input.reason ? `: ${input.reason}` : ''}`,
        userId: ctx.userId,
      });
    }
  }
  return updateObligation(db, input.id, {
    status: 'descartada',
    review_note: input.reason?.trim().slice(0, 600) || current.review_note,
  });
}

export async function completeObligation(
  db: SupabaseClient,
  input: { id: string; note?: string | null },
  ctx: OpsContext,
): Promise<ObligationRow> {
  const current = await getObligation(db, input.id);
  if (!current) throw new ValidationError('Esa obligación ya no existe.');
  if (current.status === 'propuesta') {
    throw new ValidationError('Primero confírmala: todavía es una lectura sin revisar.');
  }
  if (current.commitment_id) {
    await markMet(db, {
      id: current.commitment_id,
      userId: ctx.userId,
      note: input.note ?? null,
      today: ctx.today,
    });
    // Si se repite, el vencimiento siguiente ya nació en `markMet`; la
    // obligación sigue confirmada.
    if (current.recurrence !== 'none') return current;
  }
  return updateObligation(db, input.id, { status: 'cumplida' });
}

export async function addManualObligation(
  db: SupabaseClient,
  input: {
    contractId: string;
    party: ObligationParty;
    category?: ObligationCategory;
    description: string;
    dueOn?: string | null;
    recurrence?: ObligationRecurrence;
    penalty?: string | null;
    ownerUserId?: string | null;
    noticeDays?: number | null;
  },
  ctx: OpsContext,
): Promise<{ row: ObligationRow; commitmentId: string | null }> {
  await requireContract(db, input.contractId);
  if (input.description.trim().length < 3) throw new ValidationError('Escribe qué hay que hacer.');
  const [row] = await insertObligations(db, [
    {
      contract_id: input.contractId,
      party: input.party,
      category: input.category ?? 'otra',
      description: input.description.trim().slice(0, 600),
      due_on: ISO_OR_NULL(input.dueOn),
      recurrence: input.recurrence ?? 'none',
      penalty: input.penalty?.trim() || null,
      source: 'manual',
      status: 'propuesta',
      owner_user_id: input.ownerUserId ?? null,
      notice_days: input.noticeDays ?? null,
      created_by: ctx.userId,
    },
  ]);
  if (!row) throw new ValidationError('No se pudo guardar la obligación.');
  return confirmObligation(db, { id: row.id }, ctx);
}

/** Lo que dice el contrato sobre su vigencia, aplicado por una persona. */
export async function applyReadTerm(
  db: SupabaseClient,
  input: {
    contractId: string;
    startOn?: string | null;
    endOn?: string | null;
    renewal?: Renewal | null;
    noticeDays?: number | null;
    valueAmount?: number | null;
  },
  ctx: OpsContext,
): Promise<{ row: ContractRow; watch: WatchResult }> {
  const patch: TermPatch = {};
  if (input.startOn) patch.startOn = input.startOn;
  if (input.endOn) patch.endOn = input.endOn;
  if (input.renewal) patch.renewal = input.renewal;
  if (input.noticeDays !== undefined && input.noticeDays !== null)
    patch.noticeDays = input.noticeDays;
  if (input.valueAmount !== undefined && input.valueAmount !== null)
    patch.valueAmount = input.valueAmount;
  return updateContractTerm(db, input.contractId, patch, ctx);
}

/** Un contrato que llega ya firmado (subido), sin pasar por una plantilla. */
export async function registerUploadedContract(
  db: SupabaseClient,
  input: {
    title: string;
    contractType: ContractType;
    documentId: string;
    link: CounterpartyLink;
    signedAt?: string | null;
    ownerUserId?: string | null;
  },
  ctx: OpsContext,
): Promise<ContractRow> {
  const counterparty = await counterpartyFromRecords(db, input.link);
  const row = await insertContract(db, {
    contract_type: input.contractType,
    title: input.title.trim().slice(0, 200),
    counterparty_kind: input.link.kind,
    counterparty_name: counterparty.nombre ?? null,
    counterparty_id_number: counterparty.id ?? null,
    client_id: input.link.clientId ?? null,
    supplier_id: input.link.supplierId ?? null,
    employee_user_id: input.link.employeeUserId ?? null,
    status: 'firmado',
    drafted_with: 'subido',
    document_id: input.documentId,
    signed_at: ISO_OR_NULL(input.signedAt),
    owner_user_id: input.ownerUserId ?? ctx.userId,
    created_by: ctx.userId,
  });
  await addContractEvent(db, {
    contractId: row.id,
    kind: 'copia_firmada',
    detail: 'Contrato subido ya firmado. Lee sus obligaciones y fechas para vigilarlas.',
    actorUserId: ctx.userId,
  });
  return row;
}
