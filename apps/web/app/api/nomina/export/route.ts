import { companyModules } from '@/lib/modules/server';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  electronicPayrollRows,
  getPayrollPeriod,
  listPayrollPeriods,
  loadPeriodLiquidations,
  paymentRows,
  payrollAccess,
  payrollCsv,
  pilaRows,
  writeAuditEvent,
} from '@cortex/agent-tools';
import type { UUID } from '@cortex/core';
import type { NextRequest } from 'next/server';

/**
 * LAS DESCARGAS DE UNA NÓMINA (0194): PILA, nómina electrónica e
 * instrucciones de pago, en CSV. Llevan salarios: sólo quien administra la
 * empresa, con el módulo de nómina prendido, y queda en la auditoría (sin
 * cifras). La PILA y la nómina electrónica son del MES: juntan las quincenas
 * del mes del periodo elegido. Las instrucciones de pago son del periodo.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KINDS = ['pila', 'electronica', 'pagos'] as const;
type Kind = (typeof KINDS)[number];

export async function GET(req: NextRequest) {
  const started = performance.now();
  const user = await requireSession().catch(() => null);
  if (!user) return new Response('Unauthorized', { status: 401 });
  const kind = req.nextUrl.searchParams.get('tipo') as Kind | null;
  const periodId = req.nextUrl.searchParams.get('periodo') ?? '';
  if (!kind || !KINDS.includes(kind) || !/^[0-9a-f-]{36}$/i.test(periodId))
    return new Response('Bad request', { status: 400 });
  const modules = await companyModules(user.organization.id);
  if (!modules.has('payroll'))
    return new Response('El módulo de nómina está apagado.', { status: 403 });
  const db = getOrgScopedClient(user.organization.id);
  const access = await payrollAccess(db, user.id);
  if (!access.manager)
    return new Response('Sólo quien administra la empresa descarga la nómina.', { status: 403 });
  const period = await getPayrollPeriod(db, periodId);
  if (!period || period.status === 'borrador' || period.status === 'anulado')
    return new Response('Esa nómina no está liquidada.', { status: 404 });

  const month = period.start.slice(0, 7);
  const ids =
    kind === 'pagos'
      ? [period.id]
      : (await listPayrollPeriods(db, { limit: 48 }))
          .filter((p) => p.start.slice(0, 7) === month && p.status !== 'borrador')
          .map((p) => p.id);
  const { employees, liquidations } = await loadPeriodLiquidations(db, ids, { userId: user.id });
  const forExport = employees.map((e) => ({
    id: e.id,
    name: e.name,
    documentType: e.documentType,
    documentNumber: e.documentNumber,
    contractType: e.contractType,
    integral: e.integral,
    arlClass: e.arlClass,
    eps: e.eps,
    afp: e.afp,
    ccf: e.ccf,
    arl: e.arl,
    bankName: e.bankName,
    bankAccountType: e.bankAccountType,
    bankAccountLast4: e.bankAccountLast4,
    apprenticePhase: e.apprenticePhase,
    startDate: e.startDate,
    endDate: e.endDate,
    costCenter: e.costCenter,
  }));

  let csv: string;
  let name: string;
  if (kind === 'pila') {
    const r = pilaRows(month, forExport, liquidations);
    csv = payrollCsv(r.header, r.rows);
    name = `pila-${month}.csv`;
  } else if (kind === 'electronica') {
    const r = electronicPayrollRows(forExport, liquidations);
    csv = payrollCsv(r.header, r.rows);
    name = `nomina-electronica-${month}.csv`;
  } else {
    const r = paymentRows(forExport, liquidations);
    csv = payrollCsv(r.header, r.rows);
    name = `pagos-nomina-${period.start}-${period.end}.csv`;
  }
  await writeAuditEvent({
    db,
    userId: user.id as UUID,
    toolId: `payroll.export_${kind}`,
    input: { periodId, month },
    status: 'ok',
    latencyMs: Math.round(performance.now() - started),
    surface: 'web',
    decision: 'confirmed',
  }).catch(() => undefined);
  // BOM para que Excel abra las tildes bien.
  return new Response(`﻿${csv}\n`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control': 'no-store',
    },
  });
}
