'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel, PanelHead } from '@/components/ui/panel';
import { CURRENCIES } from '@/lib/payments-shape';
import { type StatusTone, chipClass } from '@/lib/status-chip';
import clsx from 'clsx';
import {
  CheckCircle2,
  FileSpreadsheet,
  Landmark,
  Loader2,
  SearchCheck,
  Upload,
} from 'lucide-react';
import { useMemo, useRef, useState, useTransition } from 'react';
import { applySuggestion, importStatement, previewStatement } from '../bank-actions';
import type {
  BankPreviewResult,
  BankReconView,
  ColumnRole,
  ReconItemView,
  SuggestionChoice,
} from './bank-types';
import { money, plural, shortDate } from './format';

/**
 * El extracto del banco, del lado del navegador: subirlo, mirarlo, importarlo,
 * y atar cada abono a la factura que paga.
 *
 * No decide nada. Qué banco es, qué abonos son nuevos y a qué factura iría cada
 * uno lo dice el servidor (`previewBankStatement`); aquí sólo se enseña y se
 * pide el clic. El archivo se queda en el navegador entre la vista previa y la
 * importación y se vuelve a mandar entero: lo que se importa es exactamente lo
 * que se vio.
 */

const SELECT_CLASS =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/20';

/** Los papeles que se ofrecen al escoger columnas a mano, en el orden de la pantalla. */
const MAPPING_ROLES: Array<{ role: ColumnRole; label: string; hint?: string }> = [
  { role: 'date', label: 'Fecha', hint: 'obligatoria' },
  { role: 'credit', label: 'Créditos (lo que entró)' },
  { role: 'debit', label: 'Débitos (lo que salió)' },
  { role: 'amount', label: 'Valor con signo', hint: 'si no hay créditos/débitos aparte' },
  { role: 'description', label: 'Descripción' },
  { role: 'reference', label: 'Referencia' },
  { role: 'txid', label: 'Id de la transacción' },
  { role: 'balance', label: 'Saldo' },
  { role: 'direction', label: 'Tipo (débito/crédito)' },
  { role: 'nit', label: 'NIT de quien paga' },
];

const HEADER_ROW_CHOICES = Array.from({ length: 15 }, (_, n) => n);

const DETECTED_BY: Record<string, string> = {
  name: 'por el nombre en el archivo',
  headers: 'por las columnas',
  none: 'no se reconoció el banco; se leyó como formato genérico',
  chosen: 'escogido a mano',
};

const STATUS_CHIP: Record<string, { tone: StatusTone; label: string }> = {
  matched: { tone: 'emerald', label: 'Se ata solo' },
  suggested: { tone: 'amber', label: 'Por revisar' },
  unmatched: { tone: 'neutral', label: 'Sin factura' },
  disputed: { tone: 'rose', label: 'En disputa' },
};

interface Props {
  recon: BankReconView;
}

export function BankStatements({ recon }: Props) {
  return (
    <div className="space-y-6">
      <ImportPanel accounts={recon.accounts} />
      <Reconciliation recon={recon} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Importar
// ---------------------------------------------------------------------------

function ImportPanel({ accounts }: { accounts: string[] }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [account, setAccount] = useState(accounts[0] ?? '');
  const [currency, setCurrency] = useState('');
  const [preview, setPreview] = useState<BankPreviewResult | null>(null);
  const [mapping, setMapping] = useState<Partial<Record<ColumnRole, number>>>({});
  const [headerRow, setHeaderRow] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<'preview' | 'import' | null>(null);

  function formData(withMapping: boolean): FormData | null {
    if (!file) {
      setError('Elige el archivo del extracto.');
      return null;
    }
    const form = new FormData();
    form.set('file', file);
    form.set('accountLabel', account);
    form.set('currency', currency);
    if (withMapping && Object.keys(mapping).length > 0) {
      form.set('mapping', JSON.stringify({ headerRow: headerRow ?? undefined, columns: mapping }));
    }
    return form;
  }

  function runPreview(withMapping: boolean) {
    setError(null);
    setNote(null);
    const form = formData(withMapping);
    if (!form) return;
    setBusy('preview');
    startTransition(async () => {
      const res = await previewStatement(form);
      setBusy(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPreview(res.result);
      if (res.result.status === 'needs_mapping') setHeaderRow(res.result.headerRow);
    });
  }

  function runImport() {
    setError(null);
    const form = formData(true);
    if (!form) return;
    setBusy('import');
    startTransition(async () => {
      const res = await importStatement(form);
      setBusy(null);
      if (!res.ok) {
        setError(res.error ?? 'No se pudo importar.');
        return;
      }
      setNote(res.note ?? 'Importado.');
      setPreview(null);
      setFile(null);
      setMapping({});
      setHeaderRow(null);
      if (fileRef.current) fileRef.current.value = '';
    });
  }

  const ready = preview?.status === 'ready' ? preview : null;
  const needs = preview?.status === 'needs_mapping' ? preview : null;

  return (
    <Panel className="overflow-hidden">
      <PanelHead
        icon={<Landmark className="h-4 w-4" aria-hidden />}
        title="Importar extracto del banco"
        right={
          <span className="text-xs text-ink-faint">
            Bancolombia, Davivienda, BBVA, Bogotá u otro
          </span>
        }
      />
      <div className="space-y-4 px-5 py-4">
        <p className="text-sm text-ink-muted">
          Descarga los movimientos desde la banca en línea en Excel (.xlsx) o CSV y súbelo aquí.
          Cortex toma sólo lo que entró, busca la factura que paga cada abono y no duplica nada
          aunque subas el mismo archivo o meses que se cruzan.
        </p>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,0.6fr)]">
          <label className="block">
            <span className="field-label">Archivo</span>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setPreview(null);
                setMapping({});
                setHeaderRow(null);
                setNote(null);
              }}
              aria-label="Archivo del extracto"
              className="block w-full text-sm text-ink file:mr-3 file:rounded-pill file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-ink"
            />
          </label>
          <label className="block" htmlFor="banco-cuenta">
            <span className="field-label">Cuenta</span>
            <Input
              id="banco-cuenta"
              list="banco-cuentas"
              value={account}
              onChange={(e) => {
                setAccount(e.target.value);
                setPreview(null);
              }}
              placeholder="Bancolombia corriente 1234"
              aria-label="Nombre de la cuenta"
            />
            <datalist id="banco-cuentas">
              {accounts.map((a) => (
                <option key={a} value={a} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className="field-label">Moneda</span>
            {/* Sin moneda por defecto, igual que al anotar un pago: nunca se asume. */}
            <select
              value={currency}
              onChange={(e) => {
                setCurrency(e.target.value);
                setPreview(null);
              }}
              aria-label="Moneda de la cuenta"
              className={SELECT_CLASS}
            >
              <option value="">Elige</option>
              {CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-xs text-ink-faint">
          Usa siempre el mismo nombre para la misma cuenta: es lo que permite reconocer lo que ya se
          importó.
        </p>

        {error || note ? (
          <div
            className={clsx(
              'rounded-sm px-3 py-2 text-xs',
              error ? 'bg-rose-soft text-rose' : 'bg-emerald-soft text-emerald',
            )}
          >
            {error ?? note}
          </div>
        ) : null}

        {!ready ? (
          <Button
            onClick={() => runPreview(Boolean(needs))}
            disabled={pending || !file || !currency || account.trim().length < 2}
          >
            {busy === 'preview' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <Upload className="h-3.5 w-3.5" aria-hidden />
            )}
            {needs ? 'Leer con estas columnas' : 'Ver qué trae'}
          </Button>
        ) : null}

        {needs ? (
          <MappingChooser
            preview={needs}
            mapping={mapping}
            headerRow={headerRow}
            onMapping={setMapping}
            onHeaderRow={setHeaderRow}
          />
        ) : null}

        {ready ? (
          <PreviewSummary
            preview={ready}
            pending={pending}
            importing={busy === 'import'}
            onImport={runImport}
            onCancel={() => setPreview(null)}
          />
        ) : null}
      </div>
    </Panel>
  );
}

function MappingChooser({
  preview,
  mapping,
  headerRow,
  onMapping,
  onHeaderRow,
}: {
  preview: Extract<BankPreviewResult, { status: 'needs_mapping' }>;
  mapping: Partial<Record<ColumnRole, number>>;
  headerRow: number | null;
  onMapping: (m: Partial<Record<ColumnRole, number>>) => void;
  onHeaderRow: (n: number) => void;
}) {
  // Las columnas y las filas de muestra son posicionales: su clave es su lugar.
  const columns = preview.headers.map((h, index) => ({
    key: `col-${index}`,
    index,
    label: `${index + 1}. ${h}`,
  }));
  const sample = preview.sample.map((cells, index) => ({ key: `row-${index}`, cells }));
  return (
    <div className="space-y-3 rounded-card border border-border bg-surface-2 px-4 py-3">
      <p className="text-sm font-semibold text-ink">No reconocí todas las columnas</p>
      <p className="text-xs text-ink-muted">{preview.message}</p>

      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="text-left text-ink-muted">
              {columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-2 py-1 font-semibold">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.map((row) => (
              <tr key={row.key} className="border-t border-border text-ink">
                {columns.map((c) => (
                  <td key={c.key} className="whitespace-nowrap px-2 py-1 tabular">
                    {row.cells[c.index] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <label className="block max-w-xs">
        <span className="field-label">¿En qué fila están los encabezados?</span>
        <select
          className={SELECT_CLASS}
          value={headerRow ?? preview.headerRow}
          onChange={(e) => onHeaderRow(Number(e.target.value))}
        >
          <option value={-1}>El archivo no trae encabezados</option>
          {HEADER_ROW_CHOICES.map((n) => (
            <option key={n} value={n}>
              Fila {n + 1}
            </option>
          ))}
        </select>
      </label>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {MAPPING_ROLES.map(({ role, label, hint }) => (
          <label key={role} className="block">
            <span className="field-label">
              {label}
              {hint ? <span className="ml-1 font-normal text-ink-faint">({hint})</span> : null}
            </span>
            <select
              className={SELECT_CLASS}
              value={mapping[role] ?? ''}
              onChange={(e) => {
                const next = { ...mapping };
                if (e.target.value === '') delete next[role];
                else next[role] = Number(e.target.value);
                onMapping(next);
              }}
            >
              <option value="">— no hay —</option>
              {columns.map((c) => (
                <option key={c.key} value={c.index}>
                  {c.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

function PreviewSummary({
  preview,
  pending,
  importing,
  onImport,
  onCancel,
}: {
  preview: Extract<BankPreviewResult, { status: 'ready' }>;
  pending: boolean;
  importing: boolean;
  onImport: () => void;
  onCancel: () => void;
}) {
  const facts: Array<{ label: string; value: string; tone?: StatusTone }> = [
    {
      label: 'Abonos en el archivo',
      value: `${preview.credits} · ${money(preview.creditsTotal, preview.currency)}`,
    },
    {
      label: 'Nuevos',
      value: `${preview.newCredits} · ${money(preview.newTotal, preview.currency)}`,
      tone: 'primary',
    },
    {
      label: 'Ya importados (se saltan)',
      value: String(preview.duplicates),
      tone: preview.duplicates ? 'neutral' : undefined,
    },
    { label: 'Se atan solos', value: String(preview.matched), tone: 'emerald' },
    { label: 'Por revisar', value: String(preview.suggested), tone: 'amber' },
    { label: 'Sin factura', value: String(preview.unmatched) },
  ];
  return (
    <div className="space-y-3">
      <div className="rounded-card border border-border bg-surface-2 px-4 py-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <FileSpreadsheet className="h-4 w-4 self-center text-ink-muted" aria-hidden />
          <span className="text-base font-semibold text-ink">{preview.bank.label}</span>
          <span className="text-xs text-ink-muted">{DETECTED_BY[preview.bank.detectedBy]}</span>
          {preview.period ? (
            <span className="ml-auto text-xs text-ink-muted">
              del {shortDate(preview.period.from)} al {shortDate(preview.period.to)}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-ink-faint">
          Cuenta «{preview.accountLabel}»
          {preview.accountHint
            ? ` · el archivo dice cuenta terminada en ${preview.accountHint.slice(-4)}`
            : ''}
          {' · columnas: '}
          {Object.values(preview.columnNames).join(', ')}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
          {facts.map((f) => (
            <div key={f.label}>
              <dt className="text-micro text-ink-faint">{f.label}</dt>
              <dd className="stat-num text-sm font-semibold text-ink">{f.value}</dd>
            </div>
          ))}
        </dl>
        {preview.debitsIgnored > 0 || preview.skipped > 0 ? (
          <p className="mt-2 text-xs text-ink-muted">
            {preview.debitsIgnored > 0
              ? `${plural(preview.debitsIgnored, 'salida')} por ${money(preview.debitsTotal, preview.currency)} no se importan. `
              : ''}
            {preview.skipped > 0
              ? `${plural(preview.skipped, 'fila')} no se pudieron leer (${preview.skippedExamples
                  .map((s) => `fila ${s.line}: ${s.reason}`)
                  .join('; ')}).`
              : ''}
          </p>
        ) : null}
        {preview.warnings.map((w) => (
          <p key={w} className="mt-2 text-xs text-amber">
            {w}
          </p>
        ))}
      </div>

      {preview.lines.length > 0 ? (
        <ul className="max-h-96 divide-y divide-border overflow-y-auto rounded-card border border-border">
          {preview.lines.map((l) => {
            const chip = l.duplicate
              ? { tone: 'neutral' as StatusTone, label: 'Ya estaba' }
              : l.status
                ? STATUS_CHIP[l.status]
                : null;
            return (
              <li key={l.sourceRef} className={clsx('px-3 py-2', l.duplicate && 'opacity-60')}>
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="stat-num text-sm font-semibold text-ink">
                    {money(l.amount, preview.currency)}
                  </span>
                  <span className="text-xs text-ink-muted">{shortDate(l.date)}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink">{l.description}</span>
                  {chip ? <span className={chipClass(chip.tone)}>{chip.label}</span> : null}
                </div>
                {!l.duplicate && l.suggestions[0] ? (
                  <p className="mt-0.5 text-xs text-ink-muted">
                    → {l.suggestions[0].label}
                    {l.suggestions[0].reasons.length
                      ? ` (${l.suggestions[0].reasons.join('; ')})`
                      : ''}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onImport} disabled={pending || preview.newCredits === 0}>
          {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : null}
          {preview.newCredits === 0
            ? 'Nada nuevo que importar'
            : `Importar ${plural(preview.newCredits, 'abono')}`}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={pending}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conciliar
// ---------------------------------------------------------------------------

type Tab = 'suggested' | 'unmatched' | 'matched';

function Reconciliation({ recon }: { recon: BankReconView }) {
  const [tab, setTab] = useState<Tab>(recon.suggested.length > 0 ? 'suggested' : 'unmatched');
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const total = recon.matched.length + recon.suggested.length + recon.unmatched.length;
  const items = recon[tab];

  function apply(item: ReconItemView, choice: SuggestionChoice) {
    setError(null);
    setNote(null);
    setBusy(`${item.paymentId}:${choice.id}`);
    startTransition(async () => {
      const res = await applySuggestion({
        paymentId: item.paymentId,
        kind: choice.kind,
        invoiceId: choice.id,
      });
      setBusy(null);
      if (!res.ok) setError(res.error ?? 'No se pudo.');
      else setNote(res.note ?? 'Listo.');
    });
  }

  const tabs: Array<{ id: Tab; label: string; count: number }> = [
    { id: 'suggested', label: 'Por revisar', count: recon.suggested.length },
    { id: 'unmatched', label: 'Sin factura', count: recon.unmatched.length },
    { id: 'matched', label: 'Atados a su factura', count: recon.matched.length },
  ];

  return (
    <Panel className="overflow-hidden">
      <PanelHead
        icon={<SearchCheck className="h-4 w-4" aria-hidden />}
        title="Conciliación del banco"
        right={
          recon.suggested.length > 0 ? (
            <span className={chipClass('amber')}>
              {plural(recon.suggested.length, 'por revisar', 'por revisar')}
            </span>
          ) : null
        }
      />
      {total === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-base font-semibold text-ink">Todavía no hay movimientos del banco</p>
          <p className="mt-1 text-sm text-ink-muted">
            Importa un extracto y aquí verás qué abono paga qué factura.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 px-5 pt-4" role="tablist">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={clsx(
                  'rounded-pill border px-3 py-1 text-xs font-semibold',
                  tab === t.id
                    ? 'border-primary bg-primary text-white'
                    : 'border-border bg-surface text-ink-muted hover:text-ink',
                )}
              >
                {t.label} · {t.count}
              </button>
            ))}
          </div>

          {error || note ? (
            <div
              className={clsx(
                'mx-5 mt-3 rounded-sm px-3 py-2 text-xs',
                error ? 'bg-rose-soft text-rose' : 'bg-emerald-soft text-emerald',
              )}
            >
              {error ?? note}
            </div>
          ) : null}

          {items.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-muted">
              {tab === 'suggested'
                ? 'Nada por revisar: todo lo que tenía una factura probable ya está atado.'
                : tab === 'unmatched'
                  ? 'Todos los abonos tienen al menos una factura probable.'
                  : 'Todavía no hay abonos atados a su factura.'}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border">
              {items.map((item) => (
                <ReconRow
                  key={item.paymentId}
                  item={item}
                  openInvoices={recon.openInvoices}
                  pending={pending}
                  busy={busy}
                  onApply={apply}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </Panel>
  );
}

function ReconRow({
  item,
  openInvoices,
  pending,
  busy,
  onApply,
}: {
  item: ReconItemView;
  openInvoices: BankReconView['openInvoices'];
  pending: boolean;
  busy: string | null;
  onApply: (item: ReconItemView, choice: SuggestionChoice) => void;
}) {
  const [manual, setManual] = useState('');
  const sameCurrency = useMemo(
    () => openInvoices.filter((i) => i.currency === item.currency),
    [openInvoices, item.currency],
  );
  const chip = STATUS_CHIP[item.status];
  return (
    <li className="px-5 py-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="stat-num text-base font-semibold text-ink">{item.amount}</span>
        <span className="text-sm text-ink-muted">{item.date}</span>
        {item.account ? <span className="text-xs text-ink-faint">{item.account}</span> : null}
        {chip ? <span className={clsx(chipClass(chip.tone), 'ml-auto')}>{chip.label}</span> : null}
      </div>
      <p className="mt-0.5 text-sm text-ink">{item.description || 'Sin descripción'}</p>
      {item.status === 'matched' ? (
        <p className="mt-1 flex items-center gap-1.5 text-xs text-emerald">
          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
          {item.invoiceNumber ? `Factura ${item.invoiceNumber}` : 'Factura atada'}
          {item.client ? ` · ${item.client}` : ''}
        </p>
      ) : (
        <p className="mt-1 text-xs text-ink-muted">{item.reason}</p>
      )}

      {item.status === 'suggested' && item.suggestions.length > 0 ? (
        <ul className="mt-3 space-y-2">
          {item.suggestions.map((s) => (
            <li
              key={`${s.kind}:${s.id}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-sm border border-border bg-surface-2 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">{s.label}</p>
                <p className="text-xs text-ink-muted">{s.reasons.join(' · ')}</p>
              </div>
              <Button onClick={() => onApply(item, s)} disabled={pending}>
                {busy === `${item.paymentId}:${s.id}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                ) : null}
                Es esta
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {item.status === 'suggested' || item.status === 'unmatched' ? (
        sameCurrency.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              value={manual}
              onChange={(e) => setManual(e.target.value)}
              aria-label="Escoger otra factura"
              className={clsx(SELECT_CLASS, 'max-w-md')}
            >
              <option value="">
                {item.status === 'suggested' ? 'Es otra factura…' : 'Escoger la factura…'}
              </option>
              {sameCurrency.map((i) => (
                <option key={`${i.kind}:${i.id}`} value={`${i.kind}:${i.id}`}>
                  {i.label}
                </option>
              ))}
            </select>
            <Button
              variant="outline"
              disabled={pending || !manual}
              onClick={() => {
                const choice = sameCurrency.find((i) => `${i.kind}:${i.id}` === manual);
                if (choice) onApply(item, choice);
              }}
            >
              Atar
            </Button>
          </div>
        ) : null
      ) : null}
    </li>
  );
}
