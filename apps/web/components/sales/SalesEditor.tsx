'use client';

import type {
  ClientOption,
  ProductOption,
  SalesActionResult,
  SalesEditorInput,
  TaxRateView,
} from '@/lib/sales/types';
import {
  TAX_RATE_LABEL,
  displayTotal,
  documentTotals,
  formatMoney,
  withholdingWarnings,
} from '@cortex/agent-tools/src/sales/totals';
import { clsx } from 'clsx';
import { Building2, Loader2, Package, Plus, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';

/**
 * EL EDITOR DE UNA COTIZACIÓN O UN PEDIDO (migración 0182).
 *
 * El cliente sale de Clientes (con su NIT, su correo y sus días de pago) o se
 * escribe a mano; cada línea puede salir del catálogo del programa contable
 * (lo que después deja facturar electrónicamente) o ser texto libre. Los
 * totales se ven mientras se escribe con la MISMA función que usa el servidor
 * (sales/totals.ts); al guardar, el servidor los vuelve a calcular desde las
 * líneas y ésos son los que valen.
 */

export interface SalesEditorHandlers {
  save: (input: SalesEditorInput) => Promise<SalesActionResult<{ id: string }>>;
  searchClients: (q: string) => Promise<ClientOption[]>;
  clientDefaults: (id: string) => Promise<ClientOption | null>;
  searchProducts: (q: string) => Promise<ProductOption[]>;
}

type Line = SalesEditorInput['lines'][number] & { key: string };

const FIELD =
  'w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15';
const LABEL = 'mb-1 block text-xs font-semibold text-ink-muted';

let keySeq = 0;
const newLine = (): Line => ({
  key: `l${++keySeq}`,
  description: '',
  quantity: 1,
  unitPrice: 0,
  discountPct: 0,
  taxRate: 'iva_19',
  productRef: null,
  productCode: null,
  unit: null,
});

function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function num(raw: string): number {
  const n = Number(
    raw
      .replace(/\s/g, '')
      .replace(/\.(?=\d{3}(\D|$))/g, '')
      .replace(',', '.'),
  );
  return Number.isFinite(n) ? n : 0;
}

export function SalesEditor({
  kind,
  initial,
  handlers,
  cancelHref,
}: {
  kind: 'quote' | 'order';
  initial: SalesEditorInput;
  handlers: SalesEditorHandlers;
  cancelHref: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState<SalesEditorInput>(initial);
  const [lines, setLines] = useState<Line[]>(() =>
    initial.lines.length ? initial.lines.map((l) => ({ ...l, key: `l${++keySeq}` })) : [newLine()],
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, startSave] = useTransition();
  const [showWithholdings, setShowWithholdings] = useState(
    Boolean(
      initial.withholdings.retefuentePct ||
        initial.withholdings.reteicaPerMil ||
        initial.withholdings.reteivaPct,
    ),
  );

  const set = <K extends keyof SalesEditorInput>(key: K, value: SalesEditorInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const setLine = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const totals = useMemo(
    () =>
      documentTotals(
        lines.map((l) => ({
          quantity: l.quantity,
          unitPrice: l.unitPrice,
          discountPct: l.discountPct,
          taxRate: l.taxRate,
        })),
        form.withholdings,
      ),
    [lines, form.withholdings],
  );
  const warnings = withholdingWarnings(totals, form.withholdings);
  const shown = displayTotal(totals.total);

  function save() {
    setError(null);
    if (!form.clientName.trim()) {
      setError('Elige o escribe el cliente.');
      return;
    }
    const clean = lines.filter((l) => l.description.trim());
    if (!clean.length) {
      setError('Agrega al menos una línea con descripción.');
      return;
    }
    startSave(async () => {
      const result = await handlers.save({
        ...form,
        lines: clean.map(({ key: _key, ...l }) => l),
      });
      if (!result.ok || !result.data) {
        setError(result.error ?? 'No se pudo guardar.');
        return;
      }
      router.push(`/ventas/${result.data.id}`);
      router.refresh();
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-5">
        <section className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
            <Building2 className="h-4 w-4 text-ink-faint" aria-hidden />
            Cliente
          </h2>
          <ClientPicker form={form} setForm={setForm} handlers={handlers} />
        </section>

        <section className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-bold text-ink">
            <Package className="h-4 w-4 text-ink-faint" aria-hidden />
            Qué se vende
          </h2>
          <div className="space-y-3">
            {lines.map((line, i) => (
              <LineEditor
                key={line.key}
                index={i}
                line={line}
                total={totals.lines[i]?.lineTotal ?? 0}
                onChange={(patch) => setLine(line.key, patch)}
                onRemove={
                  lines.length > 1
                    ? () => setLines((ls) => ls.filter((l) => l.key !== line.key))
                    : undefined
                }
                searchProducts={handlers.searchProducts}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={() => setLines((ls) => [...ls, newLine()])}
            className="mt-3 inline-flex items-center gap-1.5 rounded-pill border border-dashed border-border-strong px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:border-primary hover:text-primary"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            Agregar línea
          </button>
        </section>

        <section className="grid gap-4 rounded-card border border-border bg-surface p-5 shadow-card sm:grid-cols-2">
          {kind === 'quote' && (
            <div>
              <label className={LABEL} htmlFor="valid-until">
                Válida hasta
              </label>
              <input
                id="valid-until"
                type="date"
                className={FIELD}
                value={form.validUntil ?? ''}
                onChange={(e) => set('validUntil', e.target.value || null)}
              />
            </div>
          )}
          <div>
            <label className={LABEL} htmlFor="payment">
              Forma de pago
            </label>
            <div className="flex gap-2">
              <select
                id="payment"
                className={FIELD}
                value={form.paymentForm}
                onChange={(e) => {
                  const v = e.target.value as 'contado' | 'credito';
                  setForm((f) => ({
                    ...f,
                    paymentForm: v,
                    paymentDays: v === 'contado' ? 0 : f.paymentDays || 30,
                  }));
                }}
              >
                <option value="credito">A crédito</option>
                <option value="contado">De contado</option>
              </select>
              {form.paymentForm === 'credito' && (
                <label className="flex w-28 shrink-0 items-center gap-1.5 text-xs text-ink-muted">
                  <input
                    type="number"
                    min={1}
                    max={365}
                    aria-label="Días de crédito"
                    className={FIELD}
                    value={form.paymentDays}
                    onChange={(e) =>
                      set('paymentDays', Math.max(0, Math.round(num(e.target.value))))
                    }
                  />
                  días
                </label>
              )}
            </div>
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="notes">
              Notas para el cliente
            </label>
            <textarea
              id="notes"
              rows={2}
              className={FIELD}
              value={form.notes ?? ''}
              placeholder="Incluye cargue y descargue…"
              onChange={(e) => set('notes', e.target.value || null)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className={LABEL} htmlFor="terms">
              Condiciones
            </label>
            <textarea
              id="terms"
              rows={2}
              className={FIELD}
              value={form.terms ?? ''}
              placeholder="Precios en pesos colombianos antes de IVA…"
              onChange={(e) => set('terms', e.target.value || null)}
            />
          </div>
          <div className="sm:col-span-2">
            <button
              type="button"
              onClick={() => setShowWithholdings((v) => !v)}
              aria-expanded={showWithholdings}
              className="text-xs font-semibold text-primary hover:underline"
            >
              {showWithholdings
                ? 'Ocultar retenciones'
                : 'Retenciones que practica el cliente (opcional)'}
            </button>
            {showWithholdings && (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                {(
                  [
                    [
                      'retefuentePct',
                      'Retención en la fuente (%)',
                      'Servicios 4, compras 2,5, transporte 1',
                    ],
                    ['reteicaPerMil', 'ReteICA (por mil)', 'Bogotá servicios 9,66'],
                    ['reteivaPct', 'ReteIVA (% del IVA)', 'Normalmente 15'],
                  ] as const
                ).map(([key, label, hint]) => (
                  <div key={key}>
                    <label className={LABEL} htmlFor={key}>
                      {label}
                    </label>
                    <input
                      id={key}
                      inputMode="decimal"
                      className={FIELD}
                      placeholder={hint}
                      value={form.withholdings[key] ?? ''}
                      onChange={(e) =>
                        set('withholdings', {
                          ...form.withholdings,
                          [key]: e.target.value ? num(e.target.value) : undefined,
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      </div>

      <aside className="space-y-3 lg:sticky lg:top-4 lg:self-start">
        <div className="rounded-card border border-border bg-surface p-5 shadow-card">
          <h2 className="mb-3 text-sm font-bold text-ink">Totales</h2>
          <dl className="space-y-1.5 text-sm">
            <TotalRow label="Subtotal" value={formatMoney(totals.subtotal)} />
            {totals.discountTotal > 0 && (
              <TotalRow label="Descuentos" value={`−${formatMoney(totals.discountTotal)}`} />
            )}
            {totals.ivaByRate
              .filter((r) => r.rate !== 'excluido')
              .map((r) => (
                <TotalRow key={r.rate} label={TAX_RATE_LABEL[r.rate]} value={formatMoney(r.iva)} />
              ))}
            <div className="flex items-baseline justify-between border-t border-border pt-2">
              <dt className="font-bold text-ink">Total</dt>
              <dd className="text-xl font-extrabold tabular-nums text-ink">
                {formatMoney(shown.value)}
              </dd>
            </div>
            {totals.withholdingTotal > 0 && (
              <>
                <TotalRow
                  label="Retenciones estimadas"
                  value={`−${formatMoney(totals.withholdingTotal)}`}
                />
                <TotalRow label="Neto a recibir" value={formatMoney(totals.netTotal)} strong />
              </>
            )}
          </dl>
          {warnings.map((w) => (
            <p key={w} className="mt-2 rounded-sm bg-amber-soft px-3 py-2 text-xs text-amber">
              {w}
            </p>
          ))}
        </div>
        {error && (
          <p role="alert" className="rounded-sm bg-rose-soft px-3 py-2 text-sm text-rose">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="cortex-primary-button inline-flex flex-1 items-center justify-center gap-1.5 rounded-pill bg-primary px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary-strong disabled:opacity-45"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
            {kind === 'quote' ? 'Guardar cotización' : 'Guardar pedido'}
          </button>
          <a
            href={cancelHref}
            className="inline-flex items-center rounded-pill px-4 py-2.5 text-sm font-semibold text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Cancelar
          </a>
        </div>
      </aside>
    </div>
  );
}

function TotalRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className={strong ? 'font-semibold text-ink' : 'text-ink-muted'}>{label}</dt>
      <dd className={clsx('tabular-nums', strong ? 'font-bold text-ink' : 'text-ink')}>{value}</dd>
    </div>
  );
}

function ClientPicker({
  form,
  setForm,
  handlers,
}: {
  form: SalesEditorInput;
  setForm: React.Dispatch<React.SetStateAction<SalesEditorInput>>;
  handlers: SalesEditorHandlers;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ClientOption[]>([]);
  const debounced = useDebounced(query);

  useEffect(() => {
    let alive = true;
    if (debounced.trim().length < 2) {
      setOptions([]);
      return;
    }
    handlers
      .searchClients(debounced)
      .then((o) => alive && setOptions(o))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [debounced, handlers]);

  async function choose(o: ClientOption) {
    setOpen(false);
    setQuery('');
    const full = (await handlers.clientDefaults(o.id).catch(() => null)) ?? o;
    setForm((f) => ({
      ...f,
      clientId: full.id,
      clientName: full.name,
      clientTaxId: full.nit,
      clientEmail: full.email ?? f.clientEmail,
      contactName: full.contact ?? f.contactName,
      paymentDays: full.paymentDays ?? f.paymentDays,
      paymentForm: full.paymentDays === 0 ? 'contado' : f.paymentForm,
    }));
  }

  return (
    <div className="space-y-3">
      <div className="relative">
        <label className={LABEL} htmlFor="client-search">
          Buscar en Clientes
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint"
            aria-hidden
          />
          <input
            id="client-search"
            className={clsx(FIELD, 'pl-9')}
            placeholder="Nombre o NIT…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
            }}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
        </div>
        {open && options.length > 0 && (
          <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-sm border border-border bg-surface py-1 shadow-card">
            {options.map((o) => (
              <li key={o.id}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span className="font-semibold text-ink">{o.name}</span>
                  {o.nit && <span className="text-xs text-ink-faint">NIT {o.nit}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={LABEL} htmlFor="client-name">
            Nombre{' '}
            {form.clientId && <span className="font-normal text-emerald">· de Clientes</span>}
          </label>
          <input
            id="client-name"
            className={FIELD}
            value={form.clientName}
            onChange={(e) => setForm((f) => ({ ...f, clientName: e.target.value, clientId: null }))}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="client-nit">
            NIT (sin dígito de verificación)
          </label>
          <input
            id="client-nit"
            inputMode="numeric"
            className={FIELD}
            value={form.clientTaxId ?? ''}
            onChange={(e) =>
              setForm((f) => ({ ...f, clientTaxId: e.target.value.replace(/[^\d]/g, '') || null }))
            }
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="client-contact">
            Atención
          </label>
          <input
            id="client-contact"
            className={FIELD}
            value={form.contactName ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, contactName: e.target.value || null }))}
          />
        </div>
        <div>
          <label className={LABEL} htmlFor="client-email">
            Correo
          </label>
          <input
            id="client-email"
            type="email"
            className={FIELD}
            value={form.clientEmail ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, clientEmail: e.target.value || null }))}
          />
        </div>
      </div>
    </div>
  );
}

function LineEditor({
  index,
  line,
  total,
  onChange,
  onRemove,
  searchProducts,
}: {
  index: number;
  line: Line;
  total: number;
  onChange: (patch: Partial<Line>) => void;
  onRemove?: () => void;
  searchProducts: (q: string) => Promise<ProductOption[]>;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ProductOption[]>([]);
  const debounced = useDebounced(line.description);
  const touched = useRef(false);

  useEffect(() => {
    let alive = true;
    if (!touched.current || debounced.trim().length < 2) {
      setOptions([]);
      return;
    }
    searchProducts(debounced)
      .then((o) => alive && setOptions(o))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [debounced, searchProducts]);

  return (
    <div className="rounded-sm border border-border p-3">
      <div className="flex items-start gap-2">
        <span className="mt-2 w-5 shrink-0 text-xs font-semibold text-ink-faint tabular-nums">
          {index + 1}
        </span>
        <div className="relative min-w-0 flex-1">
          <label className="sr-only" htmlFor={`desc-${line.key}`}>
            Descripción de la línea {index + 1}
          </label>
          <input
            id={`desc-${line.key}`}
            className={FIELD}
            placeholder="Producto o servicio (busca en el catálogo o escribe)"
            value={line.description}
            onChange={(e) => {
              touched.current = true;
              onChange({ description: e.target.value, productRef: null, productCode: null });
              setOpen(true);
            }}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
          {line.productCode || line.productRef ? (
            <p className="mt-1 text-micro text-emerald">
              Del catálogo{line.productCode ? ` · ${line.productCode}` : ''} — se puede facturar
              electrónicamente
            </p>
          ) : line.description.trim() ? (
            <p className="mt-1 text-micro text-ink-faint">
              Texto libre: para facturar, elige un producto del catálogo
            </p>
          ) : null}
          {open && options.length > 0 && (
            <ul className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-sm border border-border bg-surface py-1 shadow-card">
              {options.map((p) => (
                <li key={`${p.provider}-${p.ref}`}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setOpen(false);
                      touched.current = false;
                      onChange({
                        description: p.name,
                        productRef: p.ref,
                        productCode: p.code,
                        unit: p.unit,
                        unitPrice: line.unitPrice || p.price || 0,
                      });
                    }}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-surface-2"
                  >
                    <span className="min-w-0 truncate text-ink">
                      {p.name}
                      {p.code && <span className="ml-2 text-xs text-ink-faint">{p.code}</span>}
                    </span>
                    {p.price !== null && (
                      <span className="shrink-0 text-xs tabular-nums text-ink-muted">
                        {formatMoney(p.price)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Quitar la línea ${index + 1}`}
            className="mt-1.5 rounded-sm p-1.5 text-ink-faint hover:bg-rose-soft hover:text-rose"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        )}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 pl-7 sm:grid-cols-[90px_1fr_90px_150px_1fr]">
        <label className="text-micro text-ink-faint">
          Cantidad
          <input
            inputMode="decimal"
            className={FIELD}
            value={line.quantity || ''}
            onChange={(e) => onChange({ quantity: num(e.target.value) })}
          />
        </label>
        <label className="text-micro text-ink-faint">
          Precio unitario (antes de IVA)
          <input
            inputMode="decimal"
            className={FIELD}
            value={line.unitPrice || ''}
            onChange={(e) => onChange({ unitPrice: num(e.target.value) })}
          />
        </label>
        <label className="text-micro text-ink-faint">
          Desc. %
          <input
            inputMode="decimal"
            className={FIELD}
            value={line.discountPct || ''}
            onChange={(e) => onChange({ discountPct: Math.min(100, num(e.target.value)) })}
          />
        </label>
        <label className="text-micro text-ink-faint">
          IVA
          <select
            className={FIELD}
            value={line.taxRate}
            onChange={(e) => onChange({ taxRate: e.target.value as TaxRateView })}
          >
            {(Object.keys(TAX_RATE_LABEL) as TaxRateView[]).map((r) => (
              <option key={r} value={r}>
                {TAX_RATE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <div className="col-span-2 flex items-end justify-end text-sm font-bold tabular-nums text-ink sm:col-span-1">
          {formatMoney(total)}
        </div>
      </div>
    </div>
  );
}
