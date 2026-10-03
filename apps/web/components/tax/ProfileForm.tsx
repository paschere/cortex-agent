'use client';

import { ActionNote, fieldClass, pillLink, pillPrimary } from '@/components/finance/pieces';
import { clsx } from 'clsx';
import { FileSearch } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import type { TaxActions, TaxPerson, TaxProfileFormInput, TaxProfileView } from './types';

/**
 * El perfil tributario: el NIT y las casillas del RUT de las que sale el
 * calendario. Quien no sabe qué marcar tiene la otra puerta al lado: que
 * Cortex lea el RUT del Cerebro y se lo proponga en el chat.
 */

const EMPTY: TaxProfileFormInput = {
  nit: '',
  dv: null,
  personType: 'juridica',
  granContribuyente: false,
  regimenSimple: false,
  ivaPeriodicity: 'none',
  agenteRetencion: false,
  icaCity: null,
  icaPeriodicity: null,
  exogena: false,
  activosExterior: false,
  camaraComercio: true,
  nominaElectronica: false,
  pila: false,
  facturacionElectronica: false,
  ownerUserId: null,
  noticeDays: 7,
  source: 'manual',
};

type Flag =
  | 'granContribuyente'
  | 'regimenSimple'
  | 'agenteRetencion'
  | 'exogena'
  | 'activosExterior'
  | 'camaraComercio'
  | 'nominaElectronica'
  | 'pila'
  | 'facturacionElectronica';

const FLAGS: Array<{ key: Flag; label: string; hint: string }> = [
  { key: 'granContribuyente', label: 'Gran contribuyente', hint: 'Responsabilidad 13 del RUT' },
  { key: 'regimenSimple', label: 'Régimen Simple', hint: 'Responsabilidad 47; reemplaza la renta' },
  { key: 'agenteRetencion', label: 'Agente de retención', hint: 'Declara retención cada mes' },
  { key: 'exogena', label: 'Reporta exógena', hint: 'Información exógena anual' },
  {
    key: 'activosExterior',
    label: 'Activos en el exterior',
    hint: 'Más de 2.000 UVT al 1 de enero',
  },
  { key: 'camaraComercio', label: 'Matrícula mercantil', hint: 'Renovación hasta el 31 de marzo' },
  { key: 'nominaElectronica', label: 'Nómina electrónica', hint: 'Transmite la nómina cada mes' },
  { key: 'pila', label: 'Paga seguridad social', hint: 'Planilla PILA de empleados' },
  {
    key: 'facturacionElectronica',
    label: 'Factura electrónicamente',
    hint: 'Sin fecha de calendario',
  },
];

const ICA_PERIODS: Record<string, Array<{ value: 'bimestral' | 'anual'; label: string }>> = {
  bogota: [
    { value: 'bimestral', label: 'Bimestral (impuesto de más de 391 UVT)' },
    { value: 'anual', label: 'Anual' },
  ],
  medellin: [
    { value: 'anual', label: 'Anual (régimen ordinario)' },
    { value: 'bimestral', label: 'Bimestral (régimen simplificado)' },
  ],
};

export function ProfileForm({
  initial,
  suggestedNit,
  people,
  actions,
  rutHref,
  onDone,
}: {
  initial: TaxProfileView | null;
  suggestedNit: string | null;
  people: TaxPerson[];
  actions: TaxActions;
  rutHref: string;
  onDone?: () => void;
}) {
  const [form, setForm] = useState<TaxProfileFormInput>(() => {
    if (!initial) {
      // «900.123.456-8» de Datos de la empresa: el DV va en su casilla.
      const m = (suggestedNit ?? '').trim().match(/^([\d.\s]+)-\s*(\d)$/);
      return m
        ? { ...EMPTY, nit: (m[1] ?? '').trim(), dv: m[2] ?? null }
        : { ...EMPTY, nit: suggestedNit ?? '' };
    }
    const { ownerName: _o, updatedLabel: _u, ...rest } = initial;
    return rest;
  });
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const set = <K extends keyof TaxProfileFormInput>(key: K, value: TaxProfileFormInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const icaOptions = form.icaCity ? ICA_PERIODS[form.icaCity] : undefined;

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setNote(null);
        start(async () => {
          const r = await actions.saveProfile(form);
          setNote({ ok: r.ok, text: r.note });
          if (r.ok) onDone?.();
        });
      }}
    >
      <div className="flex flex-wrap items-start gap-3 rounded-sm bg-primary-soft/60 px-4 py-3 text-xs text-primary-ink">
        <FileSearch className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <p className="min-w-0 flex-1">
          ¿No sabes qué marcar? Todo está en el RUT.{' '}
          <Link href={rutHref} className="font-bold underline underline-offset-2">
            No sé, que Cortex lo deduzca del RUT
          </Link>{' '}
          — lo lee del Cerebro y te propone el perfil en el chat para que lo confirmes.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_5rem]">
        <label className="block">
          <span className="field-label text-ink-faint">NIT, sin dígito de verificación</span>
          <input
            className={`${fieldClass} tabular mt-1 font-mono`}
            value={form.nit}
            onChange={(e) => set('nit', e.target.value)}
            placeholder="900.123.456"
            inputMode="numeric"
            autoComplete="off"
            required
          />
        </label>
        <label className="block">
          <span className="field-label text-ink-faint">DV</span>
          <input
            className={`${fieldClass} tabular mt-1 text-center font-mono`}
            value={form.dv ?? ''}
            onChange={(e) => set('dv', e.target.value.replace(/\D/g, '').slice(0, 1) || null)}
            placeholder="–"
            inputMode="numeric"
            maxLength={1}
          />
        </label>
      </div>

      <fieldset>
        <legend className="field-label text-ink-faint">Tipo de persona</legend>
        <div className="mt-1 inline-flex rounded-pill border border-border bg-surface-2 p-1">
          {(['juridica', 'natural'] as const).map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={form.personType === t}
              onClick={() => set('personType', t)}
              className={clsx(
                'min-h-8 rounded-pill px-4 text-xs font-semibold transition-colors',
                form.personType === t
                  ? 'bg-surface text-ink shadow-card'
                  : 'text-ink-muted hover:text-ink',
              )}
            >
              {t === 'juridica' ? 'Persona jurídica' : 'Persona natural'}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="field-label text-ink-faint">Lo que dice el RUT</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {FLAGS.map((f) => (
            <label
              key={f.key}
              className={clsx(
                'flex cursor-pointer items-start gap-2.5 rounded-sm border px-3 py-2.5 transition-colors',
                form[f.key]
                  ? 'border-primary/30 bg-primary-soft/50'
                  : 'border-border hover:bg-surface-2',
              )}
            >
              <input
                type="checkbox"
                checked={form[f.key]}
                onChange={(e) => set(f.key, e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{f.label}</span>
                <span className="block text-micro text-ink-muted">{f.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-3">
        <label className="block">
          <span className="field-label text-ink-faint">IVA</span>
          <select
            className={`${fieldClass} mt-1`}
            value={form.ivaPeriodicity}
            onChange={(e) =>
              set('ivaPeriodicity', e.target.value as TaxProfileFormInput['ivaPeriodicity'])
            }
          >
            <option value="none">No responsable de IVA</option>
            <option value="bimestral">Bimestral</option>
            <option value="cuatrimestral">Cuatrimestral</option>
          </select>
        </label>
        <label className="block">
          <span className="field-label text-ink-faint">ICA en</span>
          <select
            className={`${fieldClass} mt-1`}
            value={form.icaCity ?? ''}
            onChange={(e) => {
              const city = (e.target.value || null) as TaxProfileFormInput['icaCity'];
              setForm((f) => ({
                ...f,
                icaCity: city,
                icaPeriodicity:
                  city && ICA_PERIODS[city] ? (ICA_PERIODS[city]?.[0]?.value ?? null) : null,
              }));
            }}
          >
            <option value="">No declara ICA aquí</option>
            <option value="bogota">Bogotá</option>
            <option value="medellin">Medellín</option>
            <option value="cali">Cali</option>
            <option value="barranquilla">Barranquilla</option>
            <option value="otra">Otra ciudad</option>
          </select>
        </label>
        <label className="block">
          <span className="field-label text-ink-faint">Periodicidad del ICA</span>
          <select
            className={`${fieldClass} mt-1`}
            value={form.icaPeriodicity ?? ''}
            disabled={!icaOptions}
            onChange={(e) =>
              set(
                'icaPeriodicity',
                (e.target.value || null) as TaxProfileFormInput['icaPeriodicity'],
              )
            }
          >
            {!icaOptions && (
              <option value="">{form.icaCity ? 'La que diga tu contador' : '—'}</option>
            )}
            {icaOptions?.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <label className="block">
          <span className="field-label text-ink-faint">Quién responde por los impuestos</span>
          <select
            className={`${fieldClass} mt-1`}
            value={form.ownerUserId ?? ''}
            onChange={(e) => set('ownerUserId', e.target.value || null)}
          >
            <option value="">Nadie todavía (avisa a quien administra)</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="field-label text-ink-faint">Avisar con</span>
          <span className="mt-1 flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={60}
              className={`${fieldClass} tabular w-20 font-mono`}
              value={form.noticeDays}
              onChange={(e) =>
                set('noticeDays', Math.max(1, Math.min(60, Number(e.target.value) || 7)))
              }
            />
            <span className="text-xs text-ink-muted">días</span>
          </span>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className={pillPrimary} disabled={pending || !form.nit.trim()}>
          {pending
            ? 'Guardando…'
            : initial
              ? 'Guardar y recalcular'
              : 'Guardar y armar el calendario'}
        </button>
        {onDone && initial && (
          <button type="button" className={pillLink} onClick={onDone} disabled={pending}>
            Cancelar
          </button>
        )}
        <ActionNote note={note} />
      </div>
      <p className="text-micro text-ink-faint">
        Cambiar el perfil recalcula sólo lo que está pendiente de aquí en adelante. Lo presentado o
        pagado no se toca.
      </p>
    </form>
  );
}
