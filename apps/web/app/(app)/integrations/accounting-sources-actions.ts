'use server';

import { canManageAccounting } from '@/lib/accounting/card';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  ACCOUNTING_SOURCE_KINDS,
  type AccountingSourceKind,
  type AccountingSourceMapping,
  buildSourcePreview,
  previewGrid,
  removeAccountingSource,
  saveAccountingSource,
  writeAuditEvent,
} from '@cortex/agent-tools';
import { NotFoundError, type UUID, ValidationError } from '@cortex/core';
import { revalidatePath } from 'next/cache';

/**
 * Lo que la pantalla de «Fuentes contables» puede hacer: mirar una tabla con
 * su mapeo propuesto, guardarla como fuente y quitarla. Las mismas funciones
 * que las herramientas del chat (accounting.sources_*): aquí sólo se decide
 * QUIÉN (dueños y administradores) y se devuelven datos simples (nada de
 * funciones ni fechas: esto cruza de servidor a cliente).
 */

const PATH = '/integrations';

export interface SourcePreviewData {
  ok: true;
  table: { slug: string; name: string };
  columns: Array<{ key: string; label: string }>;
  fields: Array<{ field: string; label: string; required: boolean }>;
  mapping: Record<string, string>;
  ready: boolean;
  problems: string[];
  warnings: string[];
  rows: number;
  sampled: boolean;
  stats: { rows: number; used: number; rejected: number; warnings: number; blank: number };
  issues: Array<{ severity: 'rechazada' | 'aviso'; message: string; number: string | null }>;
  grid: { head: string[]; rows: string[][] };
}

export type SourcePreviewResult = SourcePreviewData | { ok: false; error: string };
export type SourceSaveResult = { ok: true; note: string } | { ok: false; error: string };

function describe(err: unknown, fallback: string): string {
  return err instanceof ValidationError || err instanceof NotFoundError ? err.message : fallback;
}

function kindOf(raw: string): AccountingSourceKind {
  const k = (ACCOUNTING_SOURCE_KINDS as readonly string[]).includes(raw);
  if (!k) throw new ValidationError('Ese tipo de fuente no existe.');
  return raw as AccountingSourceKind;
}

async function adminDb() {
  const user = await requireSession();
  if (!canManageAccounting(user.organization.role))
    throw new ValidationError(
      'Sólo quien administra el espacio puede declarar tablas como fuente contable.',
    );
  return { user, db: getOrgScopedClient(user.organization.id) };
}

export async function previewAccountingSource(input: {
  table: string;
  kind: string;
  mapping?: Record<string, string>;
  currency?: string;
}): Promise<SourcePreviewResult> {
  try {
    const { db } = await adminDb();
    const p = await buildSourcePreview(db, {
      table: input.table,
      kind: kindOf(input.kind),
      mapping: input.mapping as AccountingSourceMapping | undefined,
      currency: input.currency,
    });
    return {
      ok: true,
      table: { slug: p.table.slug, name: p.table.name },
      columns: p.columns,
      fields: p.fields,
      mapping: p.mapping as Record<string, string>,
      ready: p.ready,
      problems: p.problems,
      warnings: input.mapping ? [] : p.proposal.warnings,
      rows: p.rows,
      sampled: p.sampled,
      stats: p.normalized.stats,
      issues: p.normalized.issues.slice(0, 8).map((i) => ({
        severity: i.severity,
        message: i.message,
        number: i.number ?? null,
      })),
      grid: previewGrid(kindOf(input.kind), p.normalized.records, 5),
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No pude leer esa tabla. Inténtalo otra vez.') };
  }
}

export async function saveAccountingSourceAction(input: {
  table: string;
  kind: string;
  mapping: Record<string, string>;
  label?: string;
  precedence: 'program' | 'sheet';
  currency: string;
  sumRepeated: boolean;
}): Promise<SourceSaveResult> {
  const started = performance.now();
  try {
    const { user, db } = await adminDb();
    const saved = await saveAccountingSource(db, {
      tracker: input.table,
      kind: kindOf(input.kind),
      label: input.label,
      mapping: input.mapping as AccountingSourceMapping,
      precedence: input.precedence,
      currency: input.currency,
      sumRepeated: input.sumRepeated,
      userId: user.id,
    });
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'accounting.sources_define',
      input: { table: input.table, kind: input.kind, precedence: input.precedence },
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
    });
    revalidatePath(PATH);
    revalidatePath('/payments');
    revalidatePath('/pagar');
    return {
      ok: true,
      note: `Listo: «${saved.trackerName}» ya alimenta las cifras con el origen «${saved.origin}».`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo guardar la fuente.') };
  }
}

export async function removeAccountingSourceAction(input: {
  id: string;
}): Promise<SourceSaveResult> {
  const started = performance.now();
  try {
    const { user, db } = await adminDb();
    const gone = await removeAccountingSource(db, { id: input.id });
    await writeAuditEvent({
      db,
      userId: user.id as UUID,
      toolId: 'accounting.sources_remove',
      input: { id: input.id },
      status: 'ok',
      latencyMs: Math.round(performance.now() - started),
      surface: 'web',
      decision: 'confirmed',
    });
    revalidatePath(PATH);
    revalidatePath('/payments');
    revalidatePath('/pagar');
    return {
      ok: true,
      note: `Quité «${gone[0]?.origin ?? 'la fuente'}». La tabla sigue como estaba.`,
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'No se pudo quitar la fuente.') };
  }
}
