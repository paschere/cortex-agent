'use client';

import DataGrid from '@/components/datagrid/DataGrid';
import type { GridColumn, GridRow } from '@/components/datagrid/types';
import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { Panel } from '@/components/ui/panel';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { CheckCircle2, Download, FileSpreadsheet, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { EmployeeForm, type SaveEmployee } from './EmployeeForm';
import { type LeaveActions, LeavePanel } from './LeavePanel';
import { PayslipCard, money } from './PayslipCard';
import type {
  ActionResult,
  EmployeeView,
  LeaveView,
  NoveltyView,
  PayrollGuides,
  PayrollOptions,
  PayrollSettingsView,
  PayslipView,
  PeriodView,
} from './types';

/**
 * LA CONSOLA DE NÓMINA (0194), para quien administra. Cinco pestañas:
 *
 *   Periodos      cada mes o quincena con su estado; el elegido, con la
 *                 liquidación en la grilla (una fila por persona, el detalle
 *                 al abrirla), los botones del flujo y las descargas.
 *   Personas      quién está en la nómina; la ficha abre /nomina/personas/[id].
 *   Novedades     horas extra, incapacidades, licencias, bonos…
 *   Ausencias     vacaciones y permisos: pedir, aprobar, saldo, calendario.
 *   Configuración frecuencia, exoneración, sábado hábil, responsable.
 *
 * Nada aquí calcula: todo llega del servidor. Ningún botón paga.
 */

export interface PayrollActions {
  saveSettings: (input: {
    frequency: 'mensual' | 'quincenal';
    exonerated1141: boolean;
    saturdayIsWorkday: boolean;
    responsibleUserId: string | null;
  }) => Promise<ActionResult>;
  saveEmployee: SaveEmployee;
  openPeriod: (input: { start: string; end: string; payDate?: string | null }) => Promise<
    ActionResult & { id?: string }
  >;
  liquidate: (id: string) => Promise<ActionResult>;
  approve: (id: string) => Promise<ActionResult>;
  markPaid: (id: string, paidOn: string) => Promise<ActionResult>;
  voidPeriod: (id: string) => Promise<ActionResult>;
  addNovelty: (input: {
    employeeId: string;
    kind: string;
    date: string;
    dateTo?: string | null;
    hours?: number | null;
    amount?: number | null;
    note?: string | null;
  }) => Promise<ActionResult>;
  voidNovelty: (id: string) => Promise<ActionResult>;
  requestLeave: LeaveActions['request'];
  decideLeave: LeaveActions['decide'];
  cancelLeave: LeaveActions['cancel'];
}

const TABS = [
  { id: 'periodos', label: 'Periodos' },
  { id: 'personas', label: 'Personas' },
  { id: 'novedades', label: 'Novedades' },
  { id: 'ausencias', label: 'Vacaciones y permisos' },
  { id: 'configuracion', label: 'Configuración' },
] as const;

const STATUS_TONE: Record<
  PeriodView['status'],
  'neutral' | 'amber' | 'primary' | 'emerald' | 'rose'
> = {
  borrador: 'neutral',
  liquidado: 'amber',
  aprobado: 'primary',
  pagado: 'emerald',
  anulado: 'rose',
};

function useRunner() {
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>) =>
    start(async () => {
      const r = await fn();
      setNote(r.ok ? { ok: true, text: r.note } : { ok: false, text: r.error });
    });
  return { note, pending, run };
}

// ---------------------------------------------------------------------------
// Periodos
// ---------------------------------------------------------------------------

const PERIOD_COLUMNS: GridColumn[] = [
  { key: 'persona', label: 'Persona', type: 'text', pinned: true, primary: true, width: 220 },
  { key: 'dias', label: 'Días', type: 'number', width: 70 },
  { key: 'devengado', label: 'Devengado', type: 'money' },
  { key: 'deducciones', label: 'Deducciones', type: 'money' },
  { key: 'neto', label: 'Neto a pagar', type: 'money', primary: true },
  { key: 'aportes', label: 'Aportes empresa', type: 'money' },
  { key: 'provisiones', label: 'Provisiones', type: 'money' },
  { key: 'costo', label: 'Costo total', type: 'money' },
  { key: 'ibc', label: 'IBC', type: 'money' },
  {
    key: 'avisos',
    label: 'Avisos',
    type: 'number',
    width: 80,
    description: 'Cosas por revisar en la liquidación',
  },
];

function PeriodsTab({
  periods,
  selected,
  payslips,
  suggestion,
  guides,
  exportBase,
  actions,
  today,
}: {
  periods: PeriodView[];
  selected: PeriodView | null;
  payslips: PayslipView[];
  suggestion: { start: string; end: string } | null;
  guides: PayrollGuides;
  exportBase: string;
  actions: PayrollActions;
  today: string;
}) {
  const { note, pending, run } = useRunner();
  const [custom, setCustom] = useState({ start: '', end: '', payDate: '' });
  const rows: GridRow[] = useMemo(
    () =>
      payslips.map((s) => ({
        id: `${s.periodId}:${s.employeeName}`,
        values: {
          persona: s.employeeName,
          dias: s.days.contract,
          devengado: s.devengado,
          deducciones: s.deducciones,
          neto: s.neto,
          aportes: s.aportes,
          provisiones: s.provisiones,
          costo: s.costoTotal,
          ibc: s.ibc,
          avisos: s.warnings.length,
        },
        locked: true,
      })),
    [payslips],
  );
  const bySlip = useMemo(
    () => new Map(payslips.map((s) => [`${s.periodId}:${s.employeeName}`, s])),
    [payslips],
  );
  const href = (kind: string) =>
    selected ? `${exportBase}?tipo=${kind}&periodo=${selected.id}` : '#';

  return (
    <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
      <aside className="space-y-3">
        {suggestion && (
          <button
            type="button"
            className={clsx(pillPrimary, 'w-full')}
            disabled={pending}
            onClick={() =>
              run(() => actions.openPeriod({ start: suggestion.start, end: suggestion.end }))
            }
          >
            <Plus className="h-4 w-4" aria-hidden />
            Abrir {suggestion.start} a {suggestion.end}
          </button>
        )}
        <details className="rounded-card border border-border bg-surface p-3 text-xs">
          <summary className="cursor-pointer font-semibold text-ink-muted">
            Abrir otro periodo
          </summary>
          <div className="mt-2 space-y-2">
            <input
              type="date"
              aria-label="Inicio"
              className={fieldClass}
              value={custom.start}
              onChange={(e) => setCustom({ ...custom, start: e.target.value })}
            />
            <input
              type="date"
              aria-label="Fin"
              className={fieldClass}
              value={custom.end}
              onChange={(e) => setCustom({ ...custom, end: e.target.value })}
            />
            <input
              type="date"
              aria-label="Día de pago"
              className={fieldClass}
              value={custom.payDate}
              onChange={(e) => setCustom({ ...custom, payDate: e.target.value })}
            />
            <button
              type="button"
              className={pillLink}
              disabled={pending || !custom.start || !custom.end}
              onClick={() =>
                run(() =>
                  actions.openPeriod({
                    start: custom.start,
                    end: custom.end,
                    payDate: custom.payDate || null,
                  }),
                )
              }
            >
              Abrir
            </button>
          </div>
        </details>
        <ActionNote note={note} />
        <ul className="space-y-2">
          {periods.map((p) => (
            <li key={p.id}>
              <Link
                href={`/nomina?tab=periodos&periodo=${p.id}`}
                className={clsx(
                  'block rounded-card border bg-surface px-3 py-2 shadow-card transition-colors hover:bg-surface-2',
                  selected?.id === p.id ? 'border-primary' : 'border-border',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold capitalize text-ink">{p.label}</span>
                  <span className={statusPill(STATUS_TONE[p.status])}>{p.statusLabel}</span>
                </div>
                <div className="text-xs text-ink-muted">
                  {p.status === 'borrador'
                    ? 'Sin liquidar'
                    : `Neto ${money(p.totals.neto)} · ${p.totals.employees} personas`}
                </div>
              </Link>
            </li>
          ))}
          {periods.length === 0 && (
            <li className="text-sm text-ink-muted">Todavía no hay periodos.</li>
          )}
        </ul>
      </aside>

      <section className="min-w-0 space-y-4">
        {!selected ? (
          <Panel className="p-6 text-sm text-ink-muted">
            Abre el periodo para empezar: registra a las personas en «Personas», las novedades del
            mes, y liquida.
          </Panel>
        ) : (
          <>
            <Panel className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold capitalize text-ink">
                    Nómina de {selected.label}
                  </h2>
                  <p className="text-xs text-ink-muted">
                    {selected.start} a {selected.end} · pago el {selected.payDate}
                    {selected.paramsVersion ? ` · parámetros ${selected.paramsVersion}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(selected.status === 'borrador' || selected.status === 'liquidado') && (
                    <button
                      type="button"
                      className={selected.status === 'borrador' ? pillPrimary : pillLink}
                      disabled={pending}
                      onClick={() => run(() => actions.liquidate(selected.id))}
                    >
                      {selected.status === 'borrador' ? 'Liquidar' : 'Volver a liquidar'}
                    </button>
                  )}
                  {selected.status === 'liquidado' && (
                    <button
                      type="button"
                      className={pillPrimary}
                      disabled={pending}
                      onClick={() => {
                        if (
                          window.confirm(
                            '¿Aprobar esta nómina? Después ya no se vuelve a liquidar. No paga nada.',
                          )
                        )
                          run(() => actions.approve(selected.id));
                      }}
                    >
                      <CheckCircle2 className="h-4 w-4" aria-hidden />
                      Aprobar
                    </button>
                  )}
                  {selected.status === 'aprobado' && (
                    <button
                      type="button"
                      className={pillPrimary}
                      disabled={pending}
                      onClick={() => run(() => actions.markPaid(selected.id, today))}
                    >
                      Ya la pagamos
                    </button>
                  )}
                  {(selected.status === 'borrador' || selected.status === 'liquidado') && (
                    <button
                      type="button"
                      className={pillLink}
                      disabled={pending}
                      onClick={() => {
                        if (window.confirm('¿Anular este periodo?'))
                          run(() => actions.voidPeriod(selected.id));
                      }}
                    >
                      Anular
                    </button>
                  )}
                </div>
              </div>
              {selected.status !== 'borrador' && (
                <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    ['Devengado', selected.totals.devengado],
                    ['Neto a pagar', selected.totals.neto],
                    ['A la PILA', selected.totals.seguridadSocial ?? 0],
                    ['Costo total', selected.totals.costoTotal],
                  ].map(([label, value]) => (
                    <div key={label as string} className="rounded-sm bg-surface-2 px-3 py-2">
                      <dt className="text-xs text-ink-muted">{label}</dt>
                      <dd className="tabular-nums text-base font-extrabold text-ink">
                        {money(value as number)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <ActionNote note={note} />
            </Panel>

            {selected.status !== 'borrador' && (
              <DataGrid
                columns={PERIOD_COLUMNS}
                rows={rows}
                noun={{ one: 'persona', many: 'personas', gender: 'f' }}
                exportName={`nomina-${selected.start}`}
                initialView={{ sort: [{ key: 'persona', dir: 'asc' }] }}
                urlParam={false}
                height="calc(100vh - 420px)"
                renderRowDetail={(row) => {
                  const s = bySlip.get(row.id);
                  return s ? <PayslipCard slip={s} open full /> : null;
                }}
                emptyState={{
                  title: 'Nadie liquidado',
                  body: 'Agrega personas en «Personas» y vuelve a liquidar.',
                }}
              />
            )}

            {(selected.status === 'aprobado' ||
              selected.status === 'pagado' ||
              selected.status === 'liquidado') && (
              <Panel className="space-y-3 p-5">
                <h3 className="flex items-center gap-2 text-base font-bold text-ink">
                  <FileSpreadsheet className="h-4 w-4 text-ink-faint" aria-hidden />
                  Lo que sale de esta nómina
                </h3>
                {selected.status === 'liquidado' && (
                  <p className="text-xs text-amber">
                    Todavía no está aprobada: descarga para revisar, pero carga a los operadores
                    sólo lo aprobado.
                  </p>
                )}
                <div className="grid gap-3 md:grid-cols-3">
                  {(
                    [
                      ['pila', 'PILA (datos de la planilla)', guides.pila],
                      ['electronica', 'Nómina electrónica', guides.electronica],
                      ['pagos', 'Instrucciones de pago', guides.pagos],
                    ] as const
                  ).map(([kind, label, guide]) => (
                    <div key={kind} className="rounded-sm border border-border p-3">
                      <a href={href(kind)} className={pillLink} download>
                        <Download className="h-3.5 w-3.5" aria-hidden />
                        {label}
                      </a>
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-ink-muted">
                        {guide.map((g) => (
                          <li key={g}>{g}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </Panel>
            )}
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

const EMPLOYEE_COLUMNS: GridColumn[] = [
  { key: 'nombre', label: 'Nombre', type: 'text', pinned: true, primary: true, width: 220 },
  { key: 'documento', label: 'Documento', type: 'text' },
  { key: 'cargo', label: 'Cargo', type: 'text' },
  { key: 'contrato', label: 'Contrato', type: 'text' },
  { key: 'salario', label: 'Salario', type: 'money', primary: true },
  { key: 'integral', label: 'Integral', type: 'boolean', width: 80 },
  { key: 'arl', label: 'Riesgo ARL', type: 'number', width: 90 },
  { key: 'ingreso', label: 'Ingreso', type: 'date' },
  { key: 'vacaciones', label: 'Vacaciones (días)', type: 'number' },
  {
    key: 'estado',
    label: 'Estado',
    type: 'status',
    options: [
      { value: 'activo', label: 'Activo', tone: 'emerald' },
      { value: 'retirado', label: 'Retirado', tone: 'neutral' },
    ],
  },
  { key: 'centro', label: 'Centro de costo', type: 'text' },
];

function PeopleTab({
  employees,
  options,
  actions,
}: { employees: EmployeeView[]; options: PayrollOptions; actions: PayrollActions }) {
  const [adding, setAdding] = useState(false);
  const rows: GridRow[] = employees.map((e) => ({
    id: e.id,
    href: `/nomina/personas/${e.id}`,
    locked: true,
    values: {
      nombre: e.name,
      documento: `${e.documentType} ${e.documentNumber}`,
      cargo: e.jobTitle,
      contrato: e.contractLabel,
      salario: e.salary,
      integral: e.integral,
      arl: e.arlClass,
      ingreso: e.startDate,
      vacaciones: e.vacationBalance,
      estado: e.status,
      centro: e.costCenter,
    },
  }));
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <button type="button" className={pillPrimary} onClick={() => setAdding((v) => !v)}>
          <Plus className="h-4 w-4" aria-hidden />
          {adding ? 'Cerrar' : 'Nueva persona'}
        </button>
      </div>
      {adding && (
        <Panel className="p-5">
          <EmployeeForm
            contractTypes={options.contractTypes}
            team={options.team}
            save={actions.saveEmployee}
            onSaved={() => setAdding(false)}
          />
        </Panel>
      )}
      <DataGrid
        columns={EMPLOYEE_COLUMNS}
        rows={rows}
        noun={{ one: 'persona', many: 'personas', gender: 'f' }}
        exportName="nomina-personas"
        initialView={{
          sort: [{ key: 'nombre', dir: 'asc' }],
          filters: [{ key: 'estado', op: 'eq', value: 'activo' }],
        }}
        urlParam={false}
        height="calc(100vh - 340px)"
        emptyState={{
          title: 'Todavía no hay nadie en la nómina',
          body: 'Agrega a la primera persona con «Nueva persona».',
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Novedades
// ---------------------------------------------------------------------------

function NoveltiesTab({
  novelties,
  employees,
  options,
  actions,
}: {
  novelties: NoveltyView[];
  employees: EmployeeView[];
  options: PayrollOptions;
  actions: PayrollActions;
}) {
  const { note, pending, run } = useRunner();
  const active = employees.filter(
    (e) => e.status === 'activo' && e.contractType !== 'prestacion_servicios',
  );
  const [f, setF] = useState({
    employeeId: '',
    kind: 'hora_extra_diurna',
    date: '',
    dateTo: '',
    hours: '',
    amount: '',
    note: '',
  });
  const isHours = options.hourKinds.includes(f.kind);
  const isDays = options.dayKinds.includes(f.kind);
  const isAmount = options.amountKinds.includes(f.kind);
  return (
    <div className="grid gap-6 lg:grid-cols-[360px_minmax(0,1fr)]">
      <Panel className="space-y-3 p-5">
        <h3 className="text-base font-bold text-ink">Registrar una novedad</h3>
        <label className="block text-xs font-semibold text-ink-muted">
          Persona
          <select
            className={fieldClass}
            value={f.employeeId}
            onChange={(e) => setF({ ...f, employeeId: e.target.value })}
          >
            <option value="">Elige…</option>
            {active.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Novedad
          <select
            className={fieldClass}
            value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.target.value })}
          >
            {options.noveltyKinds.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold text-ink-muted">
            {isDays ? 'Desde' : 'Día'}
            <input
              type="date"
              className={fieldClass}
              value={f.date}
              onChange={(e) => setF({ ...f, date: e.target.value })}
            />
          </label>
          {isDays && (
            <label className="block text-xs font-semibold text-ink-muted">
              Hasta
              <input
                type="date"
                className={fieldClass}
                value={f.dateTo}
                min={f.date || undefined}
                onChange={(e) => setF({ ...f, dateTo: e.target.value })}
              />
            </label>
          )}
          {isHours && (
            <label className="block text-xs font-semibold text-ink-muted">
              Horas
              <input
                inputMode="decimal"
                className={fieldClass}
                value={f.hours}
                onChange={(e) => setF({ ...f, hours: e.target.value })}
              />
            </label>
          )}
          {isAmount && (
            <label className="block text-xs font-semibold text-ink-muted">
              Valor
              <input
                inputMode="numeric"
                className={fieldClass}
                value={f.amount}
                onChange={(e) => setF({ ...f, amount: e.target.value })}
              />
            </label>
          )}
        </div>
        <label className="block text-xs font-semibold text-ink-muted">
          Nota
          <input
            className={fieldClass}
            value={f.note}
            maxLength={500}
            onChange={(e) => setF({ ...f, note: e.target.value })}
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={pillPrimary}
            disabled={pending || !f.employeeId || !f.date}
            onClick={() =>
              run(async () => {
                const r = await actions.addNovelty({
                  employeeId: f.employeeId,
                  kind: f.kind,
                  date: f.date,
                  dateTo: isDays ? f.dateTo || f.date : null,
                  hours: isHours ? Number(f.hours.replace(',', '.')) || null : null,
                  amount: isAmount ? Number(f.amount.replace(/[^\d]/g, '')) || null : null,
                  note: f.note || null,
                });
                if (r.ok) setF({ ...f, date: '', dateTo: '', hours: '', amount: '', note: '' });
                return r;
              })
            }
          >
            Registrar
          </button>
          <ActionNote note={note} />
        </div>
        <p className="text-xs text-ink-muted">
          Las horas extra y recargos se liquidan con la tarifa del día (desde el 1 de julio de 2026
          el dominical es 90 %; desde el 15 de julio la hora se divide entre 210). Una novedad en un
          periodo ya aprobado va en el siguiente.
        </p>
      </Panel>
      <Panel className="p-5">
        <h3 className="mb-3 text-base font-bold text-ink">Últimas novedades</h3>
        {novelties.length === 0 ? (
          <p className="text-sm text-ink-muted">Todavía no hay novedades.</p>
        ) : (
          <ul className="divide-y divide-border">
            {novelties.slice(0, 200).map((n) => (
              <li
                key={n.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <div>
                  <span className="font-semibold text-ink">{n.employeeName}</span> · {n.kindLabel}
                  <div className="text-xs text-ink-muted">
                    {n.from}
                    {n.to && n.to !== n.from ? ` a ${n.to}` : ''}
                    {n.hours ? ` · ${n.hours} h` : ''}
                    {n.amount ? ` · ${money(n.amount)}` : ''}
                    {n.note ? ` · ${n.note}` : ''}
                    {n.source === 'licencia' ? ' · de una solicitud aprobada' : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className={pillLink}
                  disabled={pending}
                  onClick={() => run(() => actions.voidNovelty(n.id))}
                  aria-label={`Anular novedad de ${n.employeeName}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden />
                  Anular
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

function SettingsTab({
  settings,
  options,
  guides,
  actions,
}: {
  settings: PayrollSettingsView;
  options: PayrollOptions;
  guides: PayrollGuides;
  actions: PayrollActions;
}) {
  const { note, pending, run } = useRunner();
  const [f, setF] = useState({ ...settings });
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Panel className="space-y-4 p-5">
        <h3 className="text-base font-bold text-ink">Cómo liquida esta empresa</h3>
        <label className="block text-xs font-semibold text-ink-muted">
          Frecuencia de pago
          <select
            className={fieldClass}
            value={f.frequency}
            onChange={(e) => setF({ ...f, frequency: e.target.value as 'mensual' | 'quincenal' })}
          >
            <option value="mensual">Mensual</option>
            <option value="quincenal">Quincenal</option>
          </select>
        </label>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-1"
            checked={f.exonerated1141}
            onChange={(e) => setF({ ...f, exonerated1141: e.target.checked })}
          />
          <span>
            Exonerada de salud empleador, SENA e ICBF (art. 114-1 ET)
            <span className="block text-xs text-ink-muted">
              Persona jurídica declarante de renta, o persona natural con dos o más trabajadores,
              por quienes ganan menos de 10 mínimos. Confírmalo con tu contador.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="mt-1"
            checked={f.saturdayIsWorkday}
            onChange={(e) => setF({ ...f, saturdayIsWorkday: e.target.checked })}
          />
          <span>
            El sábado es día hábil (para contar vacaciones)
            <span className="block text-xs text-ink-muted">
              Desmárcalo si la empresa no trabaja los sábados.
            </span>
          </span>
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Responsable de la nómina (recibe los avisos)
          <select
            className={fieldClass}
            value={f.responsibleUserId ?? ''}
            onChange={(e) => setF({ ...f, responsibleUserId: e.target.value || null })}
          >
            <option value="">Quien administra</option>
            {options.team.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={pillPrimary}
            disabled={pending}
            onClick={() => run(() => actions.saveSettings(f))}
          >
            Guardar
          </button>
          <ActionNote note={note} />
        </div>
      </Panel>
      <Panel className="space-y-3 p-5">
        <h3 className="flex items-center gap-2 text-base font-bold text-ink">
          <ShieldAlert className="h-4 w-4 text-ink-faint" aria-hidden />
          Parámetros legales vigentes ({guides.params.version})
        </h3>
        <p className="text-xs text-ink-muted">{guides.params.sources}</p>
        {guides.params.needsConfirmation.map((n) => (
          <p key={n} className={clsx(chipClass('amber'), 'whitespace-normal')}>
            {n}
          </p>
        ))}
        <p className="text-xs text-ink-muted">
          La retención en la fuente, la liquidación de contratos y el aprendizaje (Ley 2466 de 2025)
          son estimaciones: tu contador o abogado laboral las valida antes de pagar.
        </p>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// La consola
// ---------------------------------------------------------------------------

export function PayrollConsole(props: {
  tab: string;
  today: string;
  settings: PayrollSettingsView;
  employees: EmployeeView[];
  periods: PeriodView[];
  selected: PeriodView | null;
  payslips: PayslipView[];
  novelties: NoveltyView[];
  leave: LeaveView[];
  suggestion: { start: string; end: string } | null;
  options: PayrollOptions;
  guides: PayrollGuides;
  exportBase: string;
  actions: PayrollActions;
}) {
  const people = props.employees
    .filter((e) => e.status === 'activo' && e.contractType !== 'prestacion_servicios')
    .map((e) => ({ value: e.id, label: e.name }));
  return (
    <div className="space-y-6">
      {!props.settings.configured && (
        <Panel className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
          <span>
            Antes de liquidar, revisa la configuración: frecuencia de pago y la exoneración del art.
            114-1.
          </span>
          <Link href="/nomina?tab=configuracion" className={pillLink}>
            Configurar
          </Link>
        </Panel>
      )}
      <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Secciones de nómina">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/nomina?tab=${t.id}`}
            aria-current={props.tab === t.id ? 'page' : undefined}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-semibold transition-colors',
              props.tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
            {t.id === 'ausencias' && props.leave.some((l) => l.status === 'pendiente') && (
              <span className={clsx(chipClass('amber'), 'ml-1.5')}>
                {props.leave.filter((l) => l.status === 'pendiente').length}
              </span>
            )}
          </Link>
        ))}
      </nav>
      {props.tab === 'periodos' && (
        <PeriodsTab
          periods={props.periods}
          selected={props.selected}
          payslips={props.payslips}
          suggestion={props.suggestion}
          guides={props.guides}
          exportBase={props.exportBase}
          actions={props.actions}
          today={props.today}
        />
      )}
      {props.tab === 'personas' && (
        <PeopleTab employees={props.employees} options={props.options} actions={props.actions} />
      )}
      {props.tab === 'novedades' && (
        <NoveltiesTab
          novelties={props.novelties}
          employees={props.employees}
          options={props.options}
          actions={props.actions}
        />
      )}
      {props.tab === 'ausencias' && (
        <LeavePanel
          leave={props.leave}
          kinds={props.options.leaveKinds}
          people={people}
          today={props.today}
          actions={{
            request: props.actions.requestLeave,
            decide: props.actions.decideLeave,
            cancel: props.actions.cancelLeave,
          }}
        />
      )}
      {props.tab === 'configuracion' && (
        <SettingsTab
          settings={props.settings}
          options={props.options}
          guides={props.guides}
          actions={props.actions}
        />
      )}
    </div>
  );
}
