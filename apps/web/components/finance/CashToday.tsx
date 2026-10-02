'use client';

import { type CashToday as Cash, type Piece, fullMoney } from '@/lib/finance/dashboard-shape';
import { FileUp, Pencil, Plus, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import {
  ActionNote,
  NoData,
  Section,
  fieldClass,
  pillLink,
  pillPrimary,
  statusPill,
} from './pieces';
import type { FinanceActions } from './types';

/**
 * CAJA HOY: cuánto hay, en qué cuenta, de cuándo es cada saldo y quién lo dijo.
 * Un saldo viejo se marca: lo que se movió después no está en la proyección.
 * Quien administra lo corrige aquí mismo («Actualizar saldo»).
 */
export function CashToday({
  cash,
  isAdmin,
  actions,
  bankImport,
}: {
  cash: Piece<Cash>;
  isAdmin: boolean;
  actions: FinanceActions;
  bankImport: string;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Section
      id="caja"
      title="Caja hoy"
      icon={<Wallet className="h-4 w-4" aria-hidden />}
      subtitle="La suma de los saldos de tus cuentas, cada uno con su fecha."
      right={
        cash.ok && cash.data.accounts.length > 0 ? (
          <Link href={bankImport} className={pillLink}>
            <FileUp className="h-3.5 w-3.5" aria-hidden />
            Subir extracto
          </Link>
        ) : null
      }
    >
      {!cash.ok ? (
        <NoData reason={cash.error} />
      ) : (
        <div className="space-y-4">
          <div>
            <p className="field-label text-ink-faint">Total en {cash.data.currency}</p>
            <p className="tabular stat-num mt-1 font-mono text-xl font-bold text-ink md:text-display">
              {fullMoney(cash.data.total, cash.data.currency)}
            </p>
            {cash.data.others.length > 0 && (
              <p className="mt-1 text-xs text-ink-muted">
                Aparte, sin convertir:{' '}
                {cash.data.others.map((o, i) => (
                  <span key={o.currency}>
                    {i > 0 && ' · '}
                    <span className="tabular font-mono">{fullMoney(o.total, o.currency)}</span>
                  </span>
                ))}
              </p>
            )}
          </div>

          {cash.data.accounts.length === 0 ? (
            <div className="rounded-sm border border-dashed border-border-strong px-4 py-4 text-sm text-ink-muted">
              <p>
                Todavía no hay cuentas con saldo. Sube el extracto de tu banco y Cortex toma el
                saldo y los movimientos de ahí.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={bankImport} className={pillPrimary}>
                  <FileUp className="h-3.5 w-3.5" aria-hidden />
                  Importar extracto
                </Link>
                {isAdmin && !adding && (
                  <button type="button" className={pillLink} onClick={() => setAdding(true)}>
                    <Plus className="h-3.5 w-3.5" aria-hidden />
                    Escribir un saldo
                  </button>
                )}
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-border/70">
              {cash.data.accounts.map((a) => (
                <AccountRow key={a.id} account={a} isAdmin={isAdmin} actions={actions} />
              ))}
            </ul>
          )}

          {isAdmin && cash.data.accounts.length > 0 && !adding && (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
              onClick={() => setAdding(true)}
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Agregar otra cuenta
            </button>
          )}
          {isAdmin && adding && (
            <BalanceForm
              actions={actions}
              currency={cash.data.currency}
              onDone={() => setAdding(false)}
            />
          )}
        </div>
      )}
    </Section>
  );
}

function AccountRow({
  account,
  isAdmin,
  actions,
}: {
  account: Cash['accounts'][number];
  isAdmin: boolean;
  actions: FinanceActions;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-ink">{account.name}</p>
          <p className="mt-0.5 text-micro text-ink-faint">
            {account.source} · actualizado{' '}
            <span className={account.stale ? 'font-semibold text-amber' : undefined}>
              {account.age}
            </span>
          </p>
        </div>
        <div className="flex items-center gap-2">
          {account.stale && <span className={statusPill('amber')}>Saldo viejo</span>}
          <span className="tabular font-mono text-sm font-semibold text-ink">
            {fullMoney(account.balance, account.currency)}
          </span>
          {isAdmin && !editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="grid h-8 w-8 place-items-center rounded-pill text-ink-faint transition-colors hover:bg-surface-2 hover:text-ink"
              aria-label={`Actualizar saldo de ${account.name}`}
              title="Actualizar saldo"
            >
              <Pencil className="h-3.5 w-3.5" aria-hidden />
            </button>
          )}
        </div>
      </div>
      {editing && (
        <BalanceForm
          actions={actions}
          account={account.name}
          currency={account.currency}
          onDone={() => setEditing(false)}
        />
      )}
    </li>
  );
}

function BalanceForm({
  actions,
  account,
  currency,
  onDone,
}: {
  actions: FinanceActions;
  account?: string;
  currency: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(account ?? '');
  const [balance, setBalance] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="mt-3 grid gap-2 rounded-sm bg-surface-2 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await actions.updateBalance({ account: name, currency, balance });
          if (r.ok) {
            setNote({ ok: true, text: r.note });
            router.refresh();
            onDone();
          } else setNote({ ok: false, text: r.error });
        });
      }}
    >
      {!account && (
        <label className="block">
          <span className="field-label text-ink-faint">Cuenta</span>
          <input
            className={`${fieldClass} mt-1`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Bancolombia corriente"
            required
            maxLength={80}
          />
        </label>
      )}
      <label className={account ? 'block sm:col-span-2' : 'block'}>
        <span className="field-label text-ink-faint">Saldo de hoy en {currency}</span>
        <input
          className={`${fieldClass} tabular mt-1 font-mono`}
          value={balance}
          onChange={(e) => setBalance(e.target.value)}
          placeholder="48.300.000"
          inputMode="decimal"
          required
          // biome-ignore lint/a11y/noAutofocus: se abre al pedirlo; el foco va donde se escribe.
          autoFocus
        />
      </label>
      <div className="flex items-end gap-2">
        <button type="submit" className={pillPrimary} disabled={pending}>
          {pending ? 'Guardando…' : 'Guardar saldo'}
        </button>
        <button type="button" className={pillLink} onClick={onDone}>
          Cancelar
        </button>
      </div>
      <div className="sm:col-span-3">
        <ActionNote note={note} />
      </div>
    </form>
  );
}
