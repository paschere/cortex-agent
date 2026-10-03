'use server';

import type { ActionResult } from '@/components/sst/types';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  type ActivityKind,
  type IncidentKind,
  type IncidentSeverity,
  type SstStatus,
  ensureSstPlan,
  logSstActivity,
  reportSstIncident,
  saveSstSettings,
  updateSstIncident,
  updateSstStandard,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * LO QUE SE HACE DESDE /sst (0194). La regla vive en sst/store.ts: reportar
 * un accidente, cualquiera; lo demás, el responsable del SG-SST o quien
 * administra; configurar, sólo quien administra.
 */

const PATH = '/sst';
const UUID_RE = /^[0-9a-f-]{36}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function fail(err: unknown, fallback: string): ActionResult {
  return { ok: false, error: err instanceof Error && err.message ? err.message : fallback };
}

async function ctx() {
  const user = await requireSession();
  return { user, db: getOrgScopedClient(user.organization.id) };
}

export async function saveSstSettingsAction(input: {
  workers: number;
  maxRiskClass: number;
  committee: 'copasst' | 'vigia';
  responsibleUserId: string | null;
  responsibleName: string | null;
  responsibleLicense: string | null;
  arl: string | null;
}): Promise<ActionResult> {
  try {
    const { user, db } = await ctx();
    await saveSstSettings(
      db,
      {
        ...input,
        responsibleUserId:
          input.responsibleUserId && UUID_RE.test(input.responsibleUserId)
            ? input.responsibleUserId
            : null,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: 'Guardé la configuración del SG-SST.' };
  } catch (err) {
    return fail(err, 'No se pudo guardar.');
  }
}

export async function ensurePlanAction(year: number): Promise<ActionResult> {
  try {
    const { user, db } = await ctx();
    const r = await ensureSstPlan(db, Math.round(year), { userId: user.id });
    revalidatePath(PATH);
    return {
      ok: true,
      note: `La autoevaluación ${year} tiene los ${r.group} estándares que le aplican a la empresa.`,
    };
  } catch (err) {
    return fail(err, 'No se pudo armar la autoevaluación.');
  }
}

export async function updateStandardAction(input: {
  id: string;
  status?: string;
  justification?: string | null;
  evidenceDocumentId?: string | null;
  evidenceUrl?: string | null;
  dueDate?: string | null;
  ownerUserId?: string | null;
}): Promise<ActionResult> {
  try {
    if (!UUID_RE.test(input.id)) return { ok: false, error: 'Estándar inválido.' };
    const { user, db } = await ctx();
    await updateSstStandard(
      db,
      {
        id: input.id,
        status: input.status as SstStatus | undefined,
        justification: input.justification,
        evidenceDocumentId:
          input.evidenceDocumentId && UUID_RE.test(input.evidenceDocumentId)
            ? input.evidenceDocumentId
            : input.evidenceDocumentId === null
              ? null
              : undefined,
        evidenceUrl: input.evidenceUrl,
        dueDate:
          input.dueDate && DAY.test(input.dueDate)
            ? input.dueDate
            : input.dueDate === null
              ? null
              : undefined,
        ownerUserId:
          input.ownerUserId && UUID_RE.test(input.ownerUserId) ? input.ownerUserId : undefined,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: 'Guardado.' };
  } catch (err) {
    return fail(err, 'No se pudo guardar.');
  }
}

export async function logActivityAction(input: {
  id?: string | null;
  kind: string;
  title?: string | null;
  plannedDate?: string | null;
  doneDate?: string | null;
  participants?: number | null;
  employeeId?: string | null;
  examType?: string | null;
  evidenceDocumentId?: string | null;
  evidenceUrl?: string | null;
  notes?: string | null;
}): Promise<ActionResult> {
  try {
    const { user, db } = await ctx();
    const a = await logSstActivity(
      db,
      {
        id: input.id && UUID_RE.test(input.id) ? input.id : null,
        kind: input.kind as ActivityKind,
        title: input.title,
        plannedDate: input.plannedDate && DAY.test(input.plannedDate) ? input.plannedDate : null,
        doneDate: input.doneDate && DAY.test(input.doneDate) ? input.doneDate : null,
        participants: input.participants ?? null,
        employeeId: input.employeeId && UUID_RE.test(input.employeeId) ? input.employeeId : null,
        examType:
          (input.examType as 'ingreso' | 'periodico' | 'retiro' | 'post_incapacidad' | null) ??
          null,
        evidenceDocumentId:
          input.evidenceDocumentId && UUID_RE.test(input.evidenceDocumentId)
            ? input.evidenceDocumentId
            : null,
        evidenceUrl: input.evidenceUrl || null,
        notes: input.notes,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return {
      ok: true,
      note:
        a.status === 'realizada' ? 'Actividad registrada.' : 'Actividad programada, con su aviso.',
    };
  } catch (err) {
    return fail(err, 'No se pudo guardar la actividad.');
  }
}

export async function reportIncidentAction(input: {
  kind: string;
  severity: string;
  occurredOn: string;
  employeeId?: string | null;
  place?: string | null;
  description: string;
  daysLost?: number | null;
}): Promise<ActionResult> {
  try {
    const { user, db } = await ctx();
    const r = await reportSstIncident(
      db,
      {
        kind: input.kind as IncidentKind,
        severity: input.severity as IncidentSeverity,
        occurredOn: input.occurredOn,
        employeeId: input.employeeId && UUID_RE.test(input.employeeId) ? input.employeeId : null,
        place: input.place,
        description: input.description,
        daysLost: input.daysLost ?? null,
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: `Reportado. ${r.notes.join(' ')}` };
  } catch (err) {
    return fail(err, 'No se pudo reportar.');
  }
}

export async function updateIncidentAction(input: {
  id: string;
  furatReportedOn?: string | null;
  investigationDoneOn?: string | null;
  investigationDocumentId?: string | null;
  correctiveActions?: string | null;
  close?: boolean;
}): Promise<ActionResult> {
  try {
    if (!UUID_RE.test(input.id)) return { ok: false, error: 'Evento inválido.' };
    const { user, db } = await ctx();
    await updateSstIncident(
      db,
      {
        id: input.id,
        furatReportedOn:
          input.furatReportedOn && DAY.test(input.furatReportedOn)
            ? input.furatReportedOn
            : undefined,
        investigationDoneOn:
          input.investigationDoneOn && DAY.test(input.investigationDoneOn)
            ? input.investigationDoneOn
            : undefined,
        investigationDocumentId:
          input.investigationDocumentId && UUID_RE.test(input.investigationDocumentId)
            ? input.investigationDocumentId
            : undefined,
        correctiveActions: input.correctiveActions ?? undefined,
        close: Boolean(input.close),
      },
      { userId: user.id },
    );
    revalidatePath(PATH);
    return { ok: true, note: 'Seguimiento actualizado.' };
  } catch (err) {
    return fail(err, 'No se pudo actualizar.');
  }
}
