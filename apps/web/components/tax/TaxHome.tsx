'use client';

import {
  ActionNote,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from '@/components/finance/pieces';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  CalendarClock,
  Download,
  ExternalLink,
  FileText,
  Landmark,
  Paperclip,
  Pencil,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState, useTransition } from 'react';
import { ProfileForm } from './ProfileForm';
import { TaxTabs } from './TaxTabs';
import { obligationsCsv } from './export';
import type {
  TaxActions,
  TaxLinks,
  TaxObligationView,
  TaxScreenData,
  TaxStatus,
  TaxUpload,
} from './types';

/**
 * /impuestos: el calendario tributario de la empresa (0180). Arriba lo que
 * viene; al lado, el perfil del que sale; abajo, mes por mes, cada obligación
 * con su estado y su evidencia. Todo llega armado (lib/tax/screen.ts) y se
 * pinta igual en /v/impuestos-showcase.
 */

const FILTERS = [
  { id: 'pending', label: 'Pendientes' },
  { id: 'overdue', label: 'Vencidas' },
  { id: 'done', label: 'Hechas' },
  { id: 'all', label: 'Todo el año' },
] as const;
type FilterId = (typeof FILTERS)[number]['id'];

const MONTHS_LONG = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

function monthTitle(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${MONTHS_LONG[m - 1] ?? ''} ${y}`;
}

async function defaultUpload(api: string, file: File) {
  const body = new FormData();
  body.set('file', file);
  try {
    const res = await fetch(api, { method: 'POST', body });
    const json = (await res.json().catch(() => ({}))) as {
      document?: { id?: string };
      error?: string;
    };
    if (!res.ok || !json.document?.id)
      return {
        ok: false,
        note: json.error ? `No pude subirlo: ${json.error}` : 'No pude subirlo.',
      };
    return { ok: true, documentId: json.document.id, note: 'Subido al Cerebro.' };
  } catch {
    return { ok: false, note: 'No pude subirlo. Revisa la conexión e intenta de nuevo.' };
  }
}

export function TaxHome({
  data,
  links,
  actions,
  upload,
}: {
  data: TaxScreenData;
  links: TaxLinks;
  actions: TaxActions;
  upload?: TaxUpload;
}) {
  const [filter, setFilter] = useState<FilterId>(data.summary.pending > 0 ? 'pending' : 'all');
  const [kind, setKind] = useState<string>('');
  const [editing, setEditing] = useState(false);
  const doUpload: TaxUpload = upload ?? ((file) => defaultUpload(links.uploadApi, file));

  const kinds = useMemo(
    () => [...new Map(data.obligations.map((o) => [o.kind, o.kindLabel])).entries()],
    [data.obligations],
  );
  const shown = data.obligations.filter((o) => {
    if (kind && o.kind !== kind) return false;
    if (filter === 'pending') return o.status === 'pendiente';
    if (filter === 'overdue') return o.overdue;
    if (filter === 'done') return o.status !== 'pendiente';
    return true;
  });
  const byMonth = useMemo(() => {
    const map = new Map<string, TaxObligationView[]>();
    for (const o of shown) map.set(o.month, [...(map.get(o.month) ?? []), o]);
    return [...map.entries()];
  }, [shown]);

  const exportCsv = () => {
    const blob = new Blob([obligationsCsv(shown)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `impuestos-${data.year}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <>
      <PageHeader
        title="Impuestos"
        subtitle="Las fechas con la DIAN, tu ciudad y la seguridad social, sacadas del NIT y del RUT. Cortex le avisa a tu contador; presentar y pagar lo hacen ustedes."
        icon={<Landmark className="h-5 w-5" />}
        actions={
          data.profile ? (
            <>
              {data.years.length > 1 && (
                <nav
                  aria-label="Año"
                  className="inline-flex rounded-pill border border-border bg-surface-2 p-1"
                >
                  {data.years.map((y) => (
                    <Link
                      key={y}
                      href={`${links.self}${links.self.includes('?') ? '&' : '?'}anio=${y}`}
                      aria-current={y === data.year ? 'page' : undefined}
                      className={clsx(
                        'tabular min-h-8 rounded-pill px-3 py-1.5 font-mono text-xs font-semibold',
                        y === data.year
                          ? 'bg-surface text-ink shadow-card'
                          : 'text-ink-muted hover:text-ink',
                      )}
                    >
                      {y}
                    </Link>
                  ))}
                </nav>
              )}
              <button
                type="button"
                className={pillLink}
                onClick={exportCsv}
                disabled={shown.length === 0}
              >
                <Download className="h-3.5 w-3.5" aria-hidden />
                Exportar
              </button>
              <Link href={links.processes} className={pillLink}>
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                Trámites de la DIAN
              </Link>
            </>
          ) : undefined
        }
      />

      {data.profile && links.certificates && links.exogena && (
        <TaxTabs
          active="calendario"
          links={{
            calendario: links.self,
            certificados: links.certificates,
            exogena: links.exogena,
          }}
        />
      )}

      {!data.profile ? (
        <Panel className="p-5 sm:p-7">
          <div className="max-w-3xl">
            <h2 className="text-xl font-extrabold text-ink">Arma el calendario de la empresa</h2>
            <p className="mt-1 text-sm text-ink-muted">
              Con el NIT y unas casillas del RUT saco todas las fechas del año —renta, IVA,
              retención, exógena, Régimen Simple, ICA, PILA, nómina electrónica y la renovación de
              la Cámara de Comercio— y le aviso a quien lleve los impuestos antes de cada una.
            </p>
            <div className="mt-6">
              {data.canEdit ? (
                <ProfileForm
                  initial={null}
                  suggestedNit={data.suggestedNit}
                  people={data.people}
                  actions={actions}
                  rutHref={links.rutChat}
                />
              ) : (
                <p className="rounded-sm bg-surface-2 px-4 py-3 text-sm text-ink-muted">
                  El perfil tributario lo configura quien administra la empresa. Pídeselo, o pídele
                  a Cortex en el chat que lea el RUT y se lo proponga.
                </p>
              )}
            </div>
          </div>
        </Panel>
      ) : (
        <div className="space-y-6">
          <SummaryStrip data={data} />

          <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(300px,1fr)]">
            <Panel className="min-w-0 p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div
                  role="tablist"
                  aria-label="Qué mostrar"
                  className="inline-flex flex-wrap gap-1.5"
                >
                  {FILTERS.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      role="tab"
                      aria-selected={filter === f.id}
                      onClick={() => setFilter(f.id)}
                      className={clsx(
                        'min-h-8 rounded-pill border px-3.5 text-xs font-semibold transition-colors',
                        filter === f.id
                          ? 'border-primary/30 bg-primary-soft text-primary-ink'
                          : 'border-border text-ink-muted hover:bg-surface-2 hover:text-ink',
                      )}
                    >
                      {f.label}
                      {f.id === 'overdue' && data.summary.overdue > 0 && (
                        <span className="tabular ml-1.5 font-mono">{data.summary.overdue}</span>
                      )}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs text-ink-muted">
                  <span className="sr-only">Tipo de obligación</span>
                  <select
                    className={`${fieldClass} min-h-8 w-auto py-1 text-xs`}
                    value={kind}
                    onChange={(e) => setKind(e.target.value)}
                  >
                    <option value="">Todos los tipos</option>
                    {kinds.map(([k, label]) => (
                      <option key={k} value={k}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              {byMonth.length === 0 ? (
                <p className="rounded-sm bg-surface-2 px-4 py-6 text-center text-sm text-ink-muted">
                  {filter === 'overdue'
                    ? 'Nada vencido sin marcar. Bien.'
                    : filter === 'pending'
                      ? `No queda nada pendiente en ${data.year}.`
                      : 'Nada que mostrar con este filtro.'}
                </p>
              ) : (
                <div className="space-y-6">
                  {byMonth.map(([month, rows]) => (
                    <section key={month} aria-labelledby={`mes-${month}`}>
                      <h3
                        id={`mes-${month}`}
                        className="mb-2 flex items-baseline gap-2 text-base font-extrabold text-ink"
                      >
                        {monthTitle(month)}
                        <span className="tabular font-mono text-micro font-semibold text-ink-faint">
                          {rows.length}
                        </span>
                      </h3>
                      <ul className="divide-y divide-border overflow-hidden rounded-sm border border-border">
                        {rows.map((o) => (
                          <ObligationRow
                            key={o.id}
                            o={o}
                            canMark={data.canMark}
                            actions={actions}
                            upload={doUpload}
                          />
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </Panel>

            <div className="space-y-6">
              <Panel className="p-5 sm:p-6">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-extrabold text-ink">Perfil tributario</h2>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {data.profile.source === 'rut' ? 'Leído del RUT' : 'Escrito a mano'}
                      {data.profile.updatedLabel
                        ? ` · actualizado el ${data.profile.updatedLabel}`
                        : ''}
                    </p>
                  </div>
                  {data.canEdit && !editing && (
                    <button type="button" className={pillLink} onClick={() => setEditing(true)}>
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      Editar
                    </button>
                  )}
                </div>
                {editing ? (
                  <ProfileForm
                    initial={data.profile}
                    suggestedNit={null}
                    people={data.people}
                    actions={actions}
                    rutHref={links.rutChat}
                    onDone={() => setEditing(false)}
                  />
                ) : (
                  <ProfileSummary data={data} />
                )}
              </Panel>

              {data.gaps.length > 0 && (
                <Panel className="p-5 sm:p-6">
                  <h2 className="flex items-center gap-2 text-base font-extrabold text-ink">
                    <AlertTriangle className="h-4 w-4 text-amber" aria-hidden />
                    Lo que no calculo
                  </h2>
                  <ul className="mt-2 space-y-2 text-xs text-ink-muted">
                    {data.gaps.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ul>
                </Panel>
              )}

              <Panel className="p-5 sm:p-6">
                <h2 className="text-base font-extrabold text-ink">De dónde salen las fechas</h2>
                <p className="mt-1 text-xs text-ink-muted">{data.sourceLine}</p>
                <p className="mt-2 text-xs text-ink-muted">
                  Las marcadas <span className={statusPill('amber')}>Confirma con tu contador</span>{' '}
                  no las pude verificar contra la norma. Cada fecha pendiente es un vencimiento en{' '}
                  <Link
                    href={links.commitments}
                    className="font-semibold text-primary-ink underline-offset-2 hover:underline"
                  >
                    Vencimientos
                  </Link>
                  , con su aviso.
                </p>
              </Panel>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function SummaryStrip({ data }: { data: TaxScreenData }) {
  const next = data.summary.next;
  return (
    <Panel className="grid gap-px overflow-hidden bg-border p-0 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_repeat(3,minmax(0,1fr))]">
      <div className="bg-surface px-5 py-4 sm:px-6">
        <p className="field-label text-ink-faint">Lo próximo</p>
        {next ? (
          <>
            <p className="mt-1 text-base font-extrabold text-ink">{next.title}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span className="tabular font-mono">{next.dueLabel}</span>
              <span className={statusPill(next.tone)}>{next.whenText}</span>
              {next.needsConfirmation && (
                <span className={statusPill('amber')}>Confirma con tu contador</span>
              )}
            </p>
          </>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">Nada pendiente de aquí a fin de año.</p>
        )}
      </div>
      <Stat label="Pendientes" value={data.summary.pending} />
      <Stat
        label="Vencidas sin marcar"
        value={data.summary.overdue}
        tone={data.summary.overdue ? 'rose' : undefined}
      />
      <Stat
        label="Por confirmar"
        value={data.summary.toConfirm}
        tone={data.summary.toConfirm ? 'amber' : undefined}
      />
    </Panel>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'rose' | 'amber' }) {
  return (
    <div className="bg-surface px-5 py-4 sm:px-6">
      <p className="field-label text-ink-faint">{label}</p>
      <p
        className={clsx(
          'stat-num tabular mt-1 font-mono text-xl font-extrabold',
          tone === 'rose' ? 'text-rose' : tone === 'amber' ? 'text-amber' : 'text-ink',
        )}
      >
        {value}
      </p>
    </div>
  );
}

function ProfileSummary({ data }: { data: TaxScreenData }) {
  const p = data.profile;
  if (!p) return null;
  const flags = [
    p.personType === 'juridica' ? 'Persona jurídica' : 'Persona natural',
    p.granContribuyente && 'Gran contribuyente',
    p.regimenSimple && 'Régimen Simple',
    p.ivaPeriodicity !== 'none' && `IVA ${p.ivaPeriodicity}`,
    p.agenteRetencion && 'Agente de retención',
    p.exogena && 'Exógena',
    p.activosExterior && 'Activos en el exterior',
    p.camaraComercio && 'Matrícula mercantil',
    p.nominaElectronica && 'Nómina electrónica',
    p.pila && 'PILA',
    p.facturacionElectronica && 'Facturación electrónica',
    p.impuestoPatrimonio && 'Impuesto al patrimonio',
    p.vinculadosExterior && 'Vinculados del exterior',
    p.autorretencionRate != null &&
      `Autorretención ${String(p.autorretencionRate).replace('.', ',')} %`,
    p.simpleRate != null && `Tarifa SIMPLE ${String(p.simpleRate).replace('.', ',')} %`,
    ...p.icaActivities.map((a) => `ICA ${a.code}: ${String(a.ratePerMil).replace('.', ',')} ‰`),
    p.icaCity && `ICA ${cityLabel(p.icaCity)}${p.icaPeriodicity ? ` ${p.icaPeriodicity}` : ''}`,
  ].filter(Boolean) as string[];
  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="field-label text-ink-faint">NIT</dt>
        <dd className="tabular mt-0.5 font-mono text-base font-semibold text-ink">
          {p.nit}
          {p.dv ? `-${p.dv}` : ''}
        </dd>
      </div>
      <div>
        <dt className="field-label text-ink-faint">Responsabilidades</dt>
        <dd className="mt-1 flex flex-wrap gap-1.5">
          {flags.map((f) => (
            <span key={f} className={statusPill('neutral')}>
              {f}
            </span>
          ))}
        </dd>
      </div>
      <div>
        <dt className="field-label text-ink-faint">Responde por los impuestos</dt>
        <dd className="mt-0.5 text-ink">
          {p.ownerName ?? (
            <span className="text-amber">Nadie: los avisos van a quien administra</span>
          )}
          <span className="text-ink-muted"> · aviso {p.noticeDays} días antes</span>
        </dd>
      </div>
    </dl>
  );
}

function cityLabel(city: string): string {
  return (
    {
      bogota: 'Bogotá',
      medellin: 'Medellín',
      cali: 'Cali',
      barranquilla: 'Barranquilla',
      otra: 'otra ciudad',
    }[city] ?? city
  );
}

const MARK_OPTIONS: Array<{ value: TaxStatus; label: string }> = [
  { value: 'presentada', label: 'Presentada' },
  { value: 'pagada', label: 'Pagada' },
  { value: 'no_aplica', label: 'No aplica' },
  { value: 'pendiente', label: 'Pendiente' },
];

function ObligationRow({
  o,
  canMark,
  actions,
  upload,
}: {
  o: TaxObligationView;
  canMark: boolean;
  actions: TaxActions;
  upload: TaxUpload;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<TaxStatus>(
    o.status === 'pendiente' ? (o.requiresPayment ? 'pagada' : 'presentada') : o.status,
  );
  const [noteText, setNoteText] = useState(o.statusNote ?? '');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [day] = o.dueLabel.split(' ');

  return (
    <li className={clsx('bg-surface', o.overdue && 'bg-rose-soft/40')}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
        <div className="flex min-w-0 flex-1 basis-72 items-start gap-4">
          <div className="w-12 shrink-0 text-center">
            <p className="tabular font-mono text-lg font-extrabold leading-none text-ink">{day}</p>
            <p className="mt-0.5 text-micro text-ink-faint">{o.weekday.slice(0, 3)}</p>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">{o.title}</p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {o.authority}
              {o.form && (
                <>
                  {' · formulario '}
                  <span className="tabular font-mono">{o.form}</span>
                </>
              )}
              {o.statusNote && o.status !== 'pendiente' && ` · ${o.statusNote}`}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-16 sm:pl-0">
          {o.needsConfirmation && o.status === 'pendiente' && (
            <span className={statusPill('amber')} title={o.sourceNote ?? undefined}>
              Confirma con tu contador
            </span>
          )}
          <span className={statusPill(o.tone)}>
            {o.status === 'pendiente' ? o.whenText : o.statusLabel}
          </span>
          {o.evidenceHref && (
            <a
              href={o.evidenceHref}
              target={o.evidenceHref.startsWith('http') ? '_blank' : undefined}
              rel="noreferrer"
              className="inline-flex min-h-8 items-center gap-1 rounded-pill px-2.5 text-xs font-semibold text-primary-ink hover:bg-primary-soft"
            >
              <Paperclip className="h-3.5 w-3.5" aria-hidden />
              {o.evidenceLabel ?? 'Evidencia'}
            </a>
          )}
          {o.draftHref && (
            <Link
              href={o.draftHref}
              className="inline-flex min-h-8 items-center gap-1 rounded-pill px-2.5 text-xs font-semibold text-primary-ink hover:bg-primary-soft"
            >
              <FileText className="h-3.5 w-3.5" aria-hidden />
              {o.draftStatus === 'revisado'
                ? 'Borrador revisado'
                : o.draftStatus === 'presentado'
                  ? 'Borrador presentado'
                  : 'Ver borrador'}
            </Link>
          )}
          {canMark && (
            <button
              type="button"
              className={clsx(pillLink, 'min-h-8 px-3')}
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              {o.status === 'pendiente' ? 'Marcar' : 'Cambiar'}
            </button>
          )}
        </div>
      </div>
      {open && (
        <form
          className="space-y-3 border-t border-border bg-surface-2/60 px-4 py-4"
          onSubmit={(e) => {
            e.preventDefault();
            setNote(null);
            start(async () => {
              let evidenceDocumentId: string | null = null;
              if (file) {
                const up = await upload(file);
                if (!up.ok || !up.documentId) {
                  setNote({ ok: false, text: up.note });
                  return;
                }
                evidenceDocumentId = up.documentId;
              }
              const r = await actions.mark({
                id: o.id,
                status,
                note: noteText.trim() || null,
                evidenceDocumentId,
                evidenceUrl: url.trim() || null,
              });
              setNote({ ok: r.ok, text: r.note });
              if (r.ok) setOpen(false);
            });
          }}
        >
          <fieldset>
            <legend className="field-label text-ink-faint">Estado</legend>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {MARK_OPTIONS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  aria-pressed={status === m.value}
                  onClick={() => setStatus(m.value)}
                  className={clsx(
                    'min-h-8 rounded-pill border px-3.5 text-xs font-semibold',
                    status === m.value
                      ? 'border-primary/30 bg-primary-soft text-primary-ink'
                      : 'border-border bg-surface text-ink-muted hover:text-ink',
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>
            {status === 'presentada' && o.requiresPayment && (
              <p className="mt-1.5 text-micro text-ink-muted">
                Ésta se paga: el aviso sigue hasta que la marques pagada.
              </p>
            )}
          </fieldset>
          <label className="block">
            <span className="field-label text-ink-faint">
              Nota (número de formulario, radicado…)
            </span>
            <input
              className={`${fieldClass} mt-1`}
              value={noteText}
              onChange={(e) => setNoteText(e.target.value)}
              maxLength={500}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="field-label text-ink-faint">Comprobante (PDF al Cerebro)</span>
              <input
                type="file"
                accept="application/pdf"
                className="mt-1 block w-full text-xs text-ink-muted file:mr-3 file:rounded-pill file:border-0 file:bg-primary-soft file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary-ink"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label className="block">
              <span className="field-label text-ink-faint">o un enlace</span>
              <span className="relative mt-1 block">
                <input
                  className={`${fieldClass} pr-8`}
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://"
                  inputMode="url"
                />
                <ExternalLink
                  className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-ink-faint"
                  aria-hidden
                />
              </span>
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" className={pillPrimary} disabled={pending}>
              {pending ? 'Guardando…' : 'Guardar'}
            </button>
            <button
              type="button"
              className={pillLink}
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancelar
            </button>
            <ActionNote note={note} />
          </div>
          {o.sourceNote && (
            <p className="flex items-start gap-1.5 text-micro text-ink-faint">
              <CalendarClock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              {o.sourceNote}
            </p>
          )}
        </form>
      )}
      {!open && note && (
        <div className="px-4 pb-3">
          <ActionNote note={note} />
        </div>
      )}
    </li>
  );
}
