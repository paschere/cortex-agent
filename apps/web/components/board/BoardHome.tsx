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
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { CalendarClock, FileText, Loader2, Mail, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { BoardHomeProps } from './types';

/**
 * /informe-socios (0191): los informes de cada mes, armar uno ya, y la
 * configuración — que se arme solo el día N y a qué correos se manda (siempre
 * con aprobación). El informe se abre en /informe-socios/<id>.
 */

const COLUMNS: GridColumn[] = [
  { key: 'mes', label: 'Mes', type: 'text', pinned: true, primary: true, width: 200 },
  {
    key: 'estado',
    label: 'Estado',
    type: 'status',
    width: 130,
    options: [
      { value: 'borrador', label: 'Borrador', tone: 'amber' },
      { value: 'enviado', label: 'Enviado', tone: 'emerald' },
    ],
  },
  { key: 'generado', label: 'Armado', type: 'datetime', width: 170 },
  { key: 'enviado', label: 'Enviado', type: 'datetime', width: 170 },
  { key: 'a', label: 'A quién', type: 'text', width: 260 },
  {
    key: 'enlace',
    label: 'Enlace',
    type: 'select',
    width: 160,
    options: [
      { value: 'privado', label: 'Privado', tone: 'neutral' },
      { value: 'enlace', label: 'Con enlace', tone: 'primary' },
      { value: 'contrasena', label: 'Con contraseña', tone: 'primary' },
    ],
  },
  { key: 'vistas', label: 'Aperturas', type: 'number', width: 110 },
  { key: 'resumen', label: 'Resumen', type: 'long_text', width: 360 },
];

export function BoardHome(props: BoardHomeProps) {
  const router = useRouter();
  const [period, setPeriod] = useState(props.defaultPeriod);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const existing = props.reports.find((r) => r.period === period);

  const generate = () =>
    start(async () => {
      setNote(null);
      const r = await props.actions.generate(period);
      if (!r.ok) {
        setNote({ ok: false, text: r.error });
        return;
      }
      setNote({ ok: true, text: r.note ?? 'Listo.' });
      if (r.href) router.push(r.href);
      else router.refresh();
    });

  const rows: GridRow[] = props.reports.map((r) => ({
    id: r.id,
    href: props.hrefs[r.id]?.detail ?? null,
    locked: true,
    values: {
      mes: r.content.periodLabel.charAt(0).toUpperCase() + r.content.periodLabel.slice(1),
      estado: r.status,
      generado: r.generatedAt,
      enviado: r.sentAt,
      a: r.sentTo.join(', '),
      enlace: r.visibility,
      vistas: r.shareViews,
      resumen: r.content.summary[0] ?? '',
    },
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Informe para socios"
        subtitle="El informe mensual de gerencia, armado con las cifras de la empresa: resultados, presupuesto, caja, cartera, indicadores, hitos y riesgos. Con PDF de tu marca y enlace para compartir."
        icon={<FileText className="h-5 w-5" />}
        actions={
          <>
            <Link href={props.links.statements} className={pillLink}>
              Estados financieros
            </Link>
            <Link href={props.links.budget} className={pillLink}>
              Presupuesto
            </Link>
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.4fr)_minmax(320px,1fr)]">
        <Panel className="p-5 sm:p-6">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
              <Sparkles className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <h2 className="text-lg font-extrabold text-ink">Armar un informe</h2>
              <p className="mt-0.5 text-xs text-ink-muted">
                Toma unos segundos. Queda en borrador: nada sale de Cortex hasta que lo mandes. Cada
                cifra sale de los datos; si el resumen inventa un número, se descarta.
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold text-ink-muted">
              Mes
              <select
                className={clsx(fieldClass, 'mt-1 min-w-48')}
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
              >
                {props.periods.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            {props.canEdit ? (
              <button type="button" className={pillPrimary} onClick={generate} disabled={pending}>
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                {existing ? 'Volver a armarlo' : 'Armar el informe'}
              </button>
            ) : (
              <p className="text-xs text-ink-muted">Lo arma quien administra la empresa.</p>
            )}
            {existing && props.hrefs[existing.id] && (
              <Link href={props.hrefs[existing.id]?.detail ?? '#'} className={pillLink}>
                Abrir el de este mes
              </Link>
            )}
          </div>
          <div className="mt-3">
            <ActionNote note={note} />
          </div>
        </Panel>

        <SettingsPanel {...props} />
      </div>

      <DataGrid
        columns={COLUMNS}
        rows={rows}
        initialView={{ filters: [], sort: [], hidden: ['vistas'], layout: 'table' }}
        exportName="informes-para-socios"
        noun={{ one: 'informe', many: 'informes', gender: 'm' }}
        emptyState={{
          title: 'Todavía no hay informes',
          body: 'Arma el del mes pasado arriba, o prende la rutina para que se arme solo cada mes.',
        }}
        urlParam={false}
        height="auto"
      />
    </div>
  );
}

function SettingsPanel(props: BoardHomeProps) {
  const router = useRouter();
  const s = props.settings;
  const [enabled, setEnabled] = useState(s.enabled);
  const [day, setDay] = useState(String(s.dayOfMonth));
  const [hour, setHour] = useState(String(s.hour));
  const [recipients, setRecipients] = useState(s.recipients.join(', '));
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = () =>
    start(async () => {
      const r = await props.actions.saveSettings({
        enabled,
        dayOfMonth: Number(day),
        hour: Number(hour),
        recipients: recipients
          .split(/[,;\s]+/)
          .map((x) => x.trim())
          .filter(Boolean),
      });
      setNote(r.ok ? { ok: true, text: r.note ?? 'Guardado.' } : { ok: false, text: r.error });
      if (r.ok) router.refresh();
    });
  return (
    <Panel className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
            <CalendarClock className="h-4 w-4" aria-hidden />
          </span>
          <div>
            <h2 className="text-lg font-extrabold text-ink">Cada mes, solo</h2>
            <p className="mt-0.5 text-xs text-ink-muted">
              Se arma el día que digas, del mes anterior, y te avisa. Mandarlo siempre te lo
              pregunta.
            </p>
          </div>
        </div>
        <span className={statusPill(s.enabled ? 'emerald' : 'neutral')}>
          {s.enabled ? 'Prendido' : 'Apagado'}
        </span>
      </div>
      <fieldset disabled={!props.canEdit || pending} className="mt-4 space-y-3">
        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Armarlo solo cada mes
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs font-semibold text-ink-muted">
            Día del mes
            <input
              className={clsx(fieldClass, 'mt-1')}
              inputMode="numeric"
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </label>
          <label className="text-xs font-semibold text-ink-muted">
            Hora (0–23)
            <input
              className={clsx(fieldClass, 'mt-1')}
              inputMode="numeric"
              value={hour}
              onChange={(e) => setHour(e.target.value)}
            />
          </label>
        </div>
        <label className="block text-xs font-semibold text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <Mail className="h-3.5 w-3.5" aria-hidden /> Correos de los socios
          </span>
          <textarea
            className={clsx(fieldClass, 'mt-1 min-h-20')}
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
            placeholder="socia@empresa.co, junta@empresa.co"
          />
        </label>
      </fieldset>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {props.canEdit ? (
          <button type="button" className={pillPrimary} onClick={save} disabled={pending}>
            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
            Guardar
          </button>
        ) : (
          <p className="text-xs text-ink-muted">Sólo quien administra la empresa lo configura.</p>
        )}
        {s.jobId && (
          <Link
            href={props.links.schedules}
            className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
          >
            Ver la rutina
          </Link>
        )}
        <ActionNote note={note} />
      </div>
    </Panel>
  );
}
