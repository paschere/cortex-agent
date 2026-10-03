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
import { clsx } from 'clsx';
import { AlertTriangle, CheckCircle2, Link2, Paperclip, Plus } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import type {
  ActionResult,
  ActivityView,
  ComplianceView,
  IncidentView,
  SstOption,
  SstSettingsView,
  StandardView,
} from './types';

/**
 * /sst (0194): el SG-SST de la empresa. Estándares mínimos con el % de
 * cumplimiento (Resolución 0312 de 2019), actividades del plan anual con su
 * evidencia, accidentes e incidentes con sus plazos, y la configuración.
 * Quien no gestiona el SG-SST ve el porcentaje, lo programado y el formulario
 * para reportar un accidente (eso lo puede cualquiera).
 */

export interface SstActions {
  saveSettings: (input: Omit<SstSettingsView, 'configured'>) => Promise<ActionResult>;
  ensurePlan: (year: number) => Promise<ActionResult>;
  updateStandard: (input: {
    id: string;
    status?: string;
    justification?: string | null;
    evidenceDocumentId?: string | null;
    evidenceUrl?: string | null;
    dueDate?: string | null;
  }) => Promise<ActionResult>;
  logActivity: (input: {
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
  }) => Promise<ActionResult>;
  reportIncident: (input: {
    kind: string;
    severity: string;
    occurredOn: string;
    employeeId?: string | null;
    place?: string | null;
    description: string;
    daysLost?: number | null;
  }) => Promise<ActionResult>;
  updateIncident: (input: {
    id: string;
    furatReportedOn?: string | null;
    investigationDoneOn?: string | null;
    investigationDocumentId?: string | null;
    correctiveActions?: string | null;
    close?: boolean;
  }) => Promise<ActionResult>;
}

const TABS = [
  { id: 'estandares', label: 'Estándares mínimos' },
  { id: 'actividades', label: 'Plan y actividades' },
  { id: 'incidentes', label: 'Accidentes e incidentes' },
  { id: 'configuracion', label: 'Configuración' },
] as const;

const STATUS_OPTIONS = [
  { value: 'pendiente', label: 'Sin evaluar' },
  { value: 'cumple', label: 'Cumple' },
  { value: 'no_cumple', label: 'No cumple' },
  { value: 'no_aplica', label: 'No aplica' },
];

const RATING_TONE = { critico: 'rose', moderado: 'amber', aceptable: 'emerald' } as const;

async function upload(file: File): Promise<string | null> {
  const form = new FormData();
  form.append('file', file);
  const res = await fetch('/api/kb/documents', { method: 'POST', body: form });
  const body = (await res.json().catch(() => ({}))) as { document?: { id: string } };
  return res.ok ? (body.document?.id ?? null) : null;
}

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

function ComplianceBar({ c }: { c: ComplianceView }) {
  return (
    <Panel className="p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-xs text-ink-muted">Cumplimiento de estándares mínimos</div>
          <div className="text-3xl font-extrabold tabular-nums text-ink">{c.score} %</div>
        </div>
        <span className={statusPill(RATING_TONE[c.rating])}>{c.ratingLabel}</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-pill bg-surface-2">
        <div
          className={clsx(
            'h-full',
            c.rating === 'aceptable'
              ? 'bg-emerald'
              : c.rating === 'moderado'
                ? 'bg-amber'
                : 'bg-rose',
          )}
          style={{ width: `${Math.min(100, c.score)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-ink-muted">
        {c.met} cumplen · {c.notMet} no cumplen · {c.pending} sin evaluar · {c.notApplicable} no
        aplican (de {c.total}). {c.action}
      </p>
      {c.withoutEvidence > 0 && (
        <p className="mt-1 text-xs font-semibold text-amber">
          {c.withoutEvidence} marcados «cumple» sin evidencia: en una visita de MinTrabajo no
          contarían.
        </p>
      )}
    </Panel>
  );
}

function StandardRow({
  s,
  canManage,
  actions,
}: { s: StandardView; canManage: boolean; actions: SstActions }) {
  const { note, pending, run } = useRunner();
  const [url, setUrl] = useState(s.evidenceUrl ?? '');
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">
            <span className="tabular-nums text-ink-faint">{s.code}</span> {s.title}
          </div>
          <div className="text-xs text-ink-muted">
            Peso {s.weight}
            {s.dueDate ? ` · meta ${s.dueDate}` : ''}
            {s.evidenceDocumentId || s.evidenceUrl ? ' · con evidencia' : ''}
            {s.justification ? ` · ${s.justification}` : ''}
          </div>
        </div>
        {canManage ? (
          <select
            aria-label={`Estado de ${s.code}`}
            className={clsx(fieldClass, 'w-40')}
            value={s.status}
            disabled={pending}
            onChange={(e) => {
              const status = e.target.value;
              if (status === 'no_aplica') {
                const why = window.prompt(
                  '¿Por qué no aplica? (la Resolución 0312 pide justificarlo)',
                );
                if (!why?.trim()) return;
                run(() => actions.updateStandard({ id: s.id, status, justification: why }));
              } else run(() => actions.updateStandard({ id: s.id, status }));
            }}
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <span
            className={statusPill(
              s.status === 'cumple' ? 'emerald' : s.status === 'no_cumple' ? 'rose' : 'neutral',
            )}
          >
            {STATUS_OPTIONS.find((o) => o.value === s.status)?.label}
          </span>
        )}
      </div>
      {canManage && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <label className={clsx(pillLink, 'cursor-pointer')}>
            <Paperclip className="h-3.5 w-3.5" aria-hidden />
            Subir evidencia
            <input
              type="file"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                run(async () => {
                  const id = await upload(file);
                  if (!id) return { ok: false, error: 'No se pudo subir el archivo.' };
                  return actions.updateStandard({ id: s.id, evidenceDocumentId: id });
                });
              }}
            />
          </label>
          <input
            className={clsx(fieldClass, 'w-64')}
            aria-label="Enlace de evidencia"
            placeholder="o un enlace https://…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button
            type="button"
            className={pillLink}
            disabled={pending || !url}
            onClick={() => run(() => actions.updateStandard({ id: s.id, evidenceUrl: url }))}
          >
            <Link2 className="h-3.5 w-3.5" aria-hidden />
            Guardar enlace
          </button>
          <input
            type="date"
            aria-label="Fecha meta"
            className={clsx(fieldClass, 'w-40')}
            defaultValue={s.dueDate ?? ''}
            onBlur={(e) => {
              if (e.target.value && e.target.value !== s.dueDate)
                run(() => actions.updateStandard({ id: s.id, dueDate: e.target.value }));
            }}
          />
          <ActionNote note={note} />
        </div>
      )}
    </li>
  );
}

const ACTIVITY_COLUMNS: GridColumn[] = [
  { key: 'actividad', label: 'Actividad', type: 'text', pinned: true, primary: true, width: 240 },
  { key: 'tipo', label: 'Tipo', type: 'text' },
  { key: 'fecha', label: 'Fecha', type: 'date' },
  {
    key: 'estado',
    label: 'Estado',
    type: 'status',
    options: [
      { value: 'programada', label: 'Programada', tone: 'primary' },
      { value: 'vencida', label: 'Sin registrar', tone: 'amber' },
      { value: 'realizada', label: 'Realizada', tone: 'emerald' },
      { value: 'cancelada', label: 'Cancelada', tone: 'neutral' },
    ],
  },
  { key: 'participantes', label: 'Participantes', type: 'number' },
  { key: 'persona', label: 'Persona (examen)', type: 'text' },
  { key: 'estandar', label: 'Estándar', type: 'text' },
  { key: 'evidencia', label: 'Evidencia', type: 'boolean' },
];

function ActivitiesTab({
  activities,
  kinds,
  people,
  canManage,
  today,
  actions,
}: {
  activities: ActivityView[];
  kinds: SstOption[];
  people: SstOption[];
  canManage: boolean;
  today: string;
  actions: SstActions;
}) {
  const { note, pending, run } = useRunner();
  const [f, setF] = useState({
    kind: 'capacitacion',
    title: '',
    date: '',
    participants: '',
    employeeId: '',
    examType: 'periodico',
    url: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const rows: GridRow[] = useMemo(
    () =>
      activities.map((a) => ({
        id: a.id,
        locked: true,
        values: {
          actividad: a.title,
          tipo: a.kindLabel,
          fecha: a.doneDate ?? a.plannedDate,
          estado: a.overdue ? 'vencida' : a.status,
          participantes: a.participants,
          persona: a.person,
          estandar: a.standardCode,
          evidencia: a.hasEvidence,
        },
      })),
    [activities],
  );
  const byId = useMemo(() => new Map(activities.map((a) => [a.id, a])), [activities]);
  return (
    <div className="space-y-6">
      {canManage && (
        <Panel className="space-y-3 p-5">
          <h3 className="text-base font-bold text-ink">Programar o registrar una actividad</h3>
          <div className="grid gap-3 sm:grid-cols-4">
            <label className="block text-xs font-semibold text-ink-muted">
              Tipo
              <select
                className={fieldClass}
                value={f.kind}
                onChange={(e) => setF({ ...f, kind: e.target.value })}
              >
                {kinds.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-semibold text-ink-muted sm:col-span-2">
              Título
              <input
                className={fieldClass}
                value={f.title}
                maxLength={200}
                onChange={(e) => setF({ ...f, title: e.target.value })}
              />
            </label>
            <label className="block text-xs font-semibold text-ink-muted">
              Fecha (pasada = realizada)
              <input
                type="date"
                className={fieldClass}
                value={f.date}
                onChange={(e) => setF({ ...f, date: e.target.value })}
              />
            </label>
            <label className="block text-xs font-semibold text-ink-muted">
              Participantes
              <input
                inputMode="numeric"
                className={fieldClass}
                value={f.participants}
                onChange={(e) => setF({ ...f, participants: e.target.value })}
              />
            </label>
            {f.kind === 'examen_medico' && (
              <>
                <label className="block text-xs font-semibold text-ink-muted">
                  Persona
                  <select
                    className={fieldClass}
                    value={f.employeeId}
                    onChange={(e) => setF({ ...f, employeeId: e.target.value })}
                  >
                    <option value="">—</option>
                    {people.map((p) => (
                      <option key={p.value} value={p.value}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-xs font-semibold text-ink-muted">
                  Tipo de examen
                  <select
                    className={fieldClass}
                    value={f.examType}
                    onChange={(e) => setF({ ...f, examType: e.target.value })}
                  >
                    <option value="ingreso">Ingreso</option>
                    <option value="periodico">Periódico</option>
                    <option value="retiro">Retiro</option>
                    <option value="post_incapacidad">Post incapacidad</option>
                  </select>
                </label>
              </>
            )}
            <label className="block text-xs font-semibold text-ink-muted">
              Evidencia (archivo)
              <input
                type="file"
                className="mt-2 text-xs"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label className="block text-xs font-semibold text-ink-muted">
              o enlace
              <input
                className={fieldClass}
                value={f.url}
                placeholder="https://…"
                onChange={(e) => setF({ ...f, url: e.target.value })}
              />
            </label>
          </div>
          {f.kind === 'examen_medico' && (
            <p className="text-xs text-ink-muted">
              Cortex guarda que el examen se hizo y de qué tipo, nunca el resultado: la historia
              clínica la custodia la IPS.
            </p>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              className={pillPrimary}
              disabled={pending || !f.date}
              onClick={() =>
                run(async () => {
                  let evidenceDocumentId: string | null = null;
                  if (file) {
                    evidenceDocumentId = await upload(file);
                    if (!evidenceDocumentId)
                      return { ok: false, error: 'No se pudo subir la evidencia.' };
                  }
                  const past = f.date <= today;
                  const r = await actions.logActivity({
                    kind: f.kind,
                    title: f.title || null,
                    plannedDate: past ? null : f.date,
                    doneDate: past ? f.date : null,
                    participants: f.participants ? Number(f.participants) : null,
                    employeeId: f.kind === 'examen_medico' ? f.employeeId || null : null,
                    examType: f.kind === 'examen_medico' ? f.examType : null,
                    evidenceDocumentId,
                    evidenceUrl: f.url || null,
                  });
                  if (r.ok) {
                    setF({ ...f, title: '', date: '', participants: '', url: '' });
                    setFile(null);
                  }
                  return r;
                })
              }
            >
              <Plus className="h-4 w-4" aria-hidden />
              Guardar
            </button>
            <ActionNote note={note} />
          </div>
        </Panel>
      )}
      <DataGrid
        columns={ACTIVITY_COLUMNS}
        rows={rows}
        noun={{ one: 'actividad', many: 'actividades', gender: 'f' }}
        exportName="sst-actividades"
        initialView={{ sort: [{ key: 'fecha', dir: 'desc' }] }}
        urlParam={false}
        height="calc(100vh - 420px)"
        renderRowDetail={(row) => {
          const a = byId.get(row.id);
          if (!a) return null;
          return (
            <div className="space-y-3 text-sm">
              <div className="font-bold text-ink">{a.title}</div>
              <div className="text-xs text-ink-muted">
                {a.kindLabel} ·{' '}
                {a.doneDate ? `realizada el ${a.doneDate}` : `programada para el ${a.plannedDate}`}
              </div>
              {canManage && a.status === 'programada' && (
                <button
                  type="button"
                  className={pillPrimary}
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      actions.logActivity({
                        id: a.id,
                        kind: a.kind,
                        title: a.title,
                        plannedDate: a.plannedDate,
                        doneDate: today,
                      }),
                    )
                  }
                >
                  <CheckCircle2 className="h-4 w-4" aria-hidden />
                  Marcar realizada hoy
                </button>
              )}
            </div>
          );
        }}
        emptyState={{
          title: 'Sin actividades',
          body: 'Programa las capacitaciones, exámenes, inspecciones y simulacros del año.',
        }}
      />
    </div>
  );
}

function IncidentsTab({
  incidents,
  people,
  canManage,
  today,
  actions,
}: {
  incidents: IncidentView[];
  people: SstOption[];
  canManage: boolean;
  today: string;
  actions: SstActions;
}) {
  const { note, pending, run } = useRunner();
  const [f, setF] = useState({
    kind: 'accidente',
    severity: 'leve',
    occurredOn: today,
    employeeId: '',
    place: '',
    description: '',
  });
  return (
    <div className="grid gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
      <Panel className="space-y-3 p-5">
        <h3 className="flex items-center gap-2 text-base font-bold text-ink">
          <AlertTriangle className="h-4 w-4 text-rose" aria-hidden />
          Reportar un accidente o incidente
        </h3>
        <p className="text-xs text-ink-muted">
          Lo puede reportar cualquiera. Cortex calcula los plazos y avisa; el FURAT se radica en el
          portal de la ARL.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs font-semibold text-ink-muted">
            Qué fue
            <select
              className={fieldClass}
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value })}
            >
              <option value="accidente">Accidente de trabajo</option>
              <option value="incidente">Incidente (casi accidente)</option>
              <option value="enfermedad_laboral">Enfermedad laboral</option>
            </select>
          </label>
          <label className="block text-xs font-semibold text-ink-muted">
            Gravedad
            <select
              className={fieldClass}
              value={f.severity}
              onChange={(e) => setF({ ...f, severity: e.target.value })}
            >
              <option value="leve">Leve</option>
              <option value="grave">Grave</option>
              <option value="mortal">Mortal</option>
            </select>
          </label>
          <label className="block text-xs font-semibold text-ink-muted">
            Cuándo
            <input
              type="date"
              className={fieldClass}
              value={f.occurredOn}
              max={today}
              onChange={(e) => setF({ ...f, occurredOn: e.target.value })}
            />
          </label>
          <label className="block text-xs font-semibold text-ink-muted">
            A quién
            <select
              className={fieldClass}
              value={f.employeeId}
              onChange={(e) => setF({ ...f, employeeId: e.target.value })}
            >
              <option value="">—</option>
              {people.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="block text-xs font-semibold text-ink-muted">
          Dónde
          <input
            className={fieldClass}
            value={f.place}
            maxLength={200}
            onChange={(e) => setF({ ...f, place: e.target.value })}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Qué pasó
          <textarea
            className={fieldClass}
            rows={3}
            value={f.description}
            maxLength={2000}
            onChange={(e) => setF({ ...f, description: e.target.value })}
          />
        </label>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className={pillPrimary}
            disabled={pending || f.description.trim().length < 3}
            onClick={() =>
              run(async () => {
                const r = await actions.reportIncident({
                  kind: f.kind,
                  severity: f.severity,
                  occurredOn: f.occurredOn,
                  employeeId: f.employeeId || null,
                  place: f.place || null,
                  description: f.description,
                });
                if (r.ok) setF({ ...f, description: '', place: '' });
                return r;
              })
            }
          >
            Reportar
          </button>
          <ActionNote note={note} />
        </div>
      </Panel>
      <Panel className="p-5">
        <h3 className="mb-3 text-base font-bold text-ink">Registro</h3>
        {incidents.length === 0 ? (
          <p className="text-sm text-ink-muted">
            {canManage
              ? 'Sin accidentes ni incidentes registrados.'
              : 'El registro lo ve el responsable del SG-SST.'}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {incidents.map((i) => (
              <li key={i.id} className="space-y-1 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-semibold text-ink">
                    {i.kindLabel} ({i.severity}) · {i.occurredOn}
                    {i.person ? ` · ${i.person}` : ''}
                  </span>
                  <span
                    className={statusPill(
                      i.status === 'cerrado'
                        ? 'emerald'
                        : i.alerts.some((a) => a.overdue)
                          ? 'rose'
                          : 'amber',
                    )}
                  >
                    {i.status}
                  </span>
                </div>
                <p className="text-xs text-ink-muted">{i.description}</p>
                <ul className="text-xs">
                  {i.alerts.map((a) => (
                    <li
                      key={a.what}
                      className={a.overdue ? 'font-semibold text-rose' : 'text-amber'}
                    >
                      {a.what === 'furat' ? 'FURAT a la ARL' : 'Investigación'}:{' '}
                      {a.overdue ? 'venció' : 'vence'} el {a.due}
                    </li>
                  ))}
                  {i.ministryDue && (
                    <li className="text-rose">Reporte a MinTrabajo: {i.ministryDue}</li>
                  )}
                </ul>
                {canManage && i.status !== 'cerrado' && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    {i.furatDue && !i.furatReportedOn && (
                      <button
                        type="button"
                        className={pillLink}
                        disabled={pending}
                        onClick={() =>
                          run(() => actions.updateIncident({ id: i.id, furatReportedOn: today }))
                        }
                      >
                        FURAT reportado hoy
                      </button>
                    )}
                    {!i.investigationDoneOn && (
                      <label className={clsx(pillLink, 'cursor-pointer')}>
                        <Paperclip className="h-3.5 w-3.5" aria-hidden />
                        Subir investigación
                        <input
                          type="file"
                          className="sr-only"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (!file) return;
                            run(async () => {
                              const id = await upload(file);
                              if (!id) return { ok: false, error: 'No se pudo subir el informe.' };
                              return actions.updateIncident({
                                id: i.id,
                                investigationDoneOn: today,
                                investigationDocumentId: id,
                              });
                            });
                          }}
                        />
                      </label>
                    )}
                    {i.investigationDoneOn && (
                      <button
                        type="button"
                        className={pillLink}
                        disabled={pending}
                        onClick={() => run(() => actions.updateIncident({ id: i.id, close: true }))}
                      >
                        Cerrar caso
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function SettingsTab({
  settings,
  team,
  actions,
  canConfigure,
}: {
  settings: SstSettingsView;
  team: SstOption[];
  actions: SstActions;
  canConfigure: boolean;
}) {
  const { note, pending, run } = useRunner();
  const [f, setF] = useState({ ...settings });
  if (!canConfigure)
    return (
      <Panel className="p-5 text-sm text-ink-muted">
        La configuración del SG-SST la cambia quien administra la empresa.
      </Panel>
    );
  return (
    <Panel className="max-w-2xl space-y-3 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs font-semibold text-ink-muted">
          Trabajadores (incluye contratistas en sus instalaciones)
          <input
            inputMode="numeric"
            className={fieldClass}
            value={f.workers}
            onChange={(e) => setF({ ...f, workers: Number(e.target.value) || 1 })}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Clase de riesgo más alta
          <select
            className={fieldClass}
            value={f.maxRiskClass}
            onChange={(e) => setF({ ...f, maxRiskClass: Number(e.target.value) })}
          >
            {[1, 2, 3, 4, 5].map((r) => (
              <option key={r} value={r}>
                {['I', 'II', 'III', 'IV', 'V'][r - 1]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Comité
          <select
            className={fieldClass}
            value={f.committee}
            onChange={(e) => setF({ ...f, committee: e.target.value as 'copasst' | 'vigia' })}
          >
            <option value="vigia">Vigía de SST (menos de 10 trabajadores)</option>
            <option value="copasst">COPASST</option>
          </select>
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Responsable del SG-SST en Cortex
          <select
            className={fieldClass}
            value={f.responsibleUserId ?? ''}
            onChange={(e) => setF({ ...f, responsibleUserId: e.target.value || null })}
          >
            <option value="">Quien administra</option>
            {team.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Responsable (nombre, si es externo)
          <input
            className={fieldClass}
            value={f.responsibleName ?? ''}
            onChange={(e) => setF({ ...f, responsibleName: e.target.value })}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          Licencia SST / curso de 50 horas
          <input
            className={fieldClass}
            value={f.responsibleLicense ?? ''}
            onChange={(e) => setF({ ...f, responsibleLicense: e.target.value })}
          />
        </label>
        <label className="block text-xs font-semibold text-ink-muted">
          ARL
          <input
            className={fieldClass}
            value={f.arl ?? ''}
            onChange={(e) => setF({ ...f, arl: e.target.value })}
          />
        </label>
      </div>
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
  );
}

export function SstScreen(props: {
  tab: string;
  today: string;
  year: number;
  group: number;
  canManage: boolean;
  canConfigure: boolean;
  settings: SstSettingsView;
  compliance: ComplianceView | null;
  standards: StandardView[];
  activities: ActivityView[];
  incidents: IncidentView[];
  activityKinds: SstOption[];
  people: SstOption[];
  team: SstOption[];
  actions: SstActions;
}) {
  const { note, pending, run } = useRunner();
  const cycles = ['planear', 'hacer', 'verificar', 'actuar'];
  return (
    <div className="space-y-6">
      {!props.settings.configured && (
        <Panel className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
          <span>
            Para saber qué estándares le aplican, dile a Cortex cuántos trabajadores tiene la
            empresa y su riesgo más alto.
          </span>
          <Link href="/sst?tab=configuracion" className={pillLink}>
            Configurar
          </Link>
        </Panel>
      )}
      <nav
        className="flex flex-wrap gap-1 border-b border-border"
        aria-label="Secciones del SG-SST"
      >
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/sst?tab=${t.id}`}
            aria-current={props.tab === t.id ? 'page' : undefined}
            className={clsx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-semibold',
              props.tab === t.id
                ? 'border-primary text-ink'
                : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {props.tab === 'estandares' && (
        <div className="space-y-6">
          {props.compliance && props.standards.length > 0 && <ComplianceBar c={props.compliance} />}
          {props.standards.length === 0 ? (
            <Panel className="space-y-3 p-5 text-sm">
              <p>
                Con {props.settings.workers} trabajadores y riesgo {props.settings.maxRiskClass}, a
                la empresa le aplican {props.group} estándares mínimos de la Resolución 0312 de
                2019. La autoevaluación de {props.year} todavía no está armada.
              </p>
              {props.canManage && (
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    className={pillPrimary}
                    disabled={pending}
                    onClick={() => run(() => props.actions.ensurePlan(props.year))}
                  >
                    Armar la autoevaluación {props.year}
                  </button>
                  <ActionNote note={note} />
                </div>
              )}
            </Panel>
          ) : (
            cycles.map((c) => {
              const list = props.standards.filter((s) => s.cycle === c);
              if (!list.length) return null;
              return (
                <Panel key={c} className="p-5">
                  <h3 className="text-base font-bold capitalize text-ink">{c}</h3>
                  <ul className="divide-y divide-border">
                    {list.map((s) => (
                      <StandardRow
                        key={s.id}
                        s={s}
                        canManage={props.canManage}
                        actions={props.actions}
                      />
                    ))}
                  </ul>
                </Panel>
              );
            })
          )}
          <p className="text-xs text-ink-muted">
            {props.group < 60
              ? 'Para los grupos de 7 y 21 estándares, Cortex reparte el 100 % en proporción a los pesos de la tabla de 60: valídalo con el responsable del SG-SST o tu ARL. '
              : ''}
            Cortex lleva el registro, los plazos y la evidencia; el SG-SST lo diseña y firma una
            persona con licencia en SST.
          </p>
        </div>
      )}
      {props.tab === 'actividades' && (
        <ActivitiesTab
          activities={props.activities}
          kinds={props.activityKinds}
          people={props.people}
          canManage={props.canManage}
          today={props.today}
          actions={props.actions}
        />
      )}
      {props.tab === 'incidentes' && (
        <IncidentsTab
          incidents={props.incidents}
          people={props.people}
          canManage={props.canManage}
          today={props.today}
          actions={props.actions}
        />
      )}
      {props.tab === 'configuracion' && (
        <SettingsTab
          settings={props.settings}
          team={props.team}
          actions={props.actions}
          canConfigure={props.canConfigure}
        />
      )}
    </div>
  );
}
