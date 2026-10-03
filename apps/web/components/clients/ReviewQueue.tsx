'use client';

import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/panel';
import type {
  AccountingConflictView,
  ActionResult,
  BacklogView,
  DuplicateView,
  Piece,
  ProposalGroupView,
} from '@/lib/clients/types';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { Check, CopyCheck, Link2, Loader2, TriangleAlert, X } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';

/**
 * «POR CONFIRMAR»: lo que Cortex cree y nadie ha dicho.
 *
 * Cuatro montones, cada uno con su decisión:
 *
 *   1. Propuestas agrupadas — «47 movimientos dicen "COLTRANS SAS BOGOTA",
 *      ¿son de Coltrans?». Confirmar de a montón, y si la evidencia es un
 *      nombre, «recordar este nombre» para que la próxima vez se aplique solo.
 *   2. Posibles duplicados — dos fichas que parecen la misma empresa. Unir
 *      pide confirmar, y nunca une dos NIT distintos.
 *   3. Clientes del programa contable que chocan por nombre con uno sin NIT:
 *      no se crean solos (sería unir por nombre).
 *   4. Contrapartes escritas a mano en vencimientos, sin cliente.
 *
 * Nada de esto cuenta en ninguna cifra hasta que una persona decide.
 */

export interface ReviewHandlers {
  confirm: (ids: string[], rememberAlias?: string | null) => Promise<ActionResult>;
  reject: (ids: string[]) => Promise<ActionResult>;
  merge: (keepId: string, mergeId: string) => Promise<ActionResult>;
  assignCounterparty: (counterparty: string, clientId: string) => Promise<ActionResult>;
  claimCounterparty: (counterparty: string) => Promise<ActionResult>;
}

function useRunner() {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  function run(key: string, fn: () => Promise<ActionResult>, doneKey: string = key) {
    setBusy(key);
    setMessage(null);
    start(async () => {
      const r = await fn();
      setBusy(null);
      setMessage({ ok: r.ok, text: r.ok ? (r.note ?? 'Listo.') : (r.error ?? 'No se pudo.') });
      if (r.ok) setDone((prev) => new Set(prev).add(doneKey));
    });
  }
  return { pending, busy, message, done, run };
}

function Unread({ error }: { error: string }) {
  return <p className="px-5 py-4 text-sm text-ink-muted">Sin dato: {error}</p>;
}

export function ReviewQueue({
  groups,
  duplicates,
  backlog,
  conflicts,
  handlers,
}: {
  groups: Piece<ProposalGroupView[]>;
  duplicates: Piece<DuplicateView[]>;
  backlog: Piece<BacklogView[]>;
  conflicts: Piece<AccountingConflictView[]>;
  handlers: ReviewHandlers;
}) {
  const r = useRunner();
  const [learn, setLearn] = useState<Record<string, boolean>>({});
  const [confirmMerge, setConfirmMerge] = useState<string | null>(null);

  const visibleGroups = groups.ok ? groups.data.filter((g) => !r.done.has(g.key)) : [];
  const visibleDupes = duplicates.ok
    ? duplicates.data.filter((d) => !r.done.has(`${d.keep.id}|${d.merge.id}`))
    : [];
  const nothing =
    groups.ok &&
    duplicates.ok &&
    backlog.ok &&
    conflicts.ok &&
    visibleGroups.length === 0 &&
    visibleDupes.length === 0 &&
    backlog.data.length === 0 &&
    conflicts.data.length === 0;

  return (
    <div className="space-y-5">
      {r.message && (
        <p
          aria-live="polite"
          className={clsx(
            'rounded-sm px-3 py-2 text-xs leading-snug',
            r.message.ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
          )}
        >
          {r.message.text}
        </p>
      )}

      {nothing && (
        <Panel className="px-6 py-8 text-center">
          <Check className="mx-auto h-6 w-6 text-emerald" aria-hidden />
          <p className="mt-2 text-sm font-semibold text-ink">Nada por confirmar</p>
          <p className="mt-1 text-sm text-ink-muted">
            Todo lo que Cortex encontró ya está decidido. El barrido diario vuelve a mirar cada
            mañana.
          </p>
        </Panel>
      )}

      {/* 1. Propuestas ---------------------------------------------------- */}
      {(!groups.ok || visibleGroups.length > 0) && (
        <Panel>
          <div className="flex items-start gap-3 px-5 pt-4">
            <Link2 className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
            <div>
              <h2 className="text-sm font-semibold text-ink">¿Esto es de este cliente?</h2>
              <p className="mt-1 max-w-[680px] text-xs leading-snug text-ink-muted">
                Cortex los encontró por el nombre, no por el NIT ni por un correo registrado, así
                que no cuentan hasta que digas sí. Si alguno calza con dos clientes, aparece en los
                dos: confirmar uno descarta el otro.
              </p>
            </div>
          </div>
          {!groups.ok ? (
            <Unread error={groups.error} />
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {visibleGroups.map((g) => (
                <li key={g.key} className="px-5 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 max-w-[640px]">
                      <p className="text-sm text-ink">
                        <span className="tabular font-semibold">{g.count}</span>{' '}
                        {g.kindLabel.toLowerCase()}
                        {g.count === 1 ? '' : 's'} con «
                        <span className="font-semibold">{g.evidence}</span>» →{' '}
                        <Link
                          href={`/clients/${g.clientId}`}
                          className="font-semibold text-primary hover:underline"
                        >
                          {g.clientName}
                        </Link>
                      </p>
                      <p className="mt-1 text-xs text-ink-faint">
                        {g.methodLabel} · {g.why}
                      </p>
                      {g.rivals.length > 0 && (
                        <p className="mt-1 text-xs text-amber">
                          También podría ser de {g.rivals.join(', ')}.
                        </p>
                      )}
                      <ul className="mt-2 space-y-0.5">
                        {g.samples.map((s, i) => (
                          <li key={`${g.key}-${i}`} className="truncate text-xs text-ink-muted">
                            {s.date ? (
                              <span className="tabular text-ink-faint">{s.date} · </span>
                            ) : null}
                            {s.label}
                          </li>
                        ))}
                        {g.count > g.samples.length && (
                          <li className="text-xs text-ink-faint">
                            y {g.count - g.samples.length} más
                          </li>
                        )}
                      </ul>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          className="min-h-9 px-4 text-xs"
                          disabled={r.pending}
                          onClick={() =>
                            r.run(
                              `${g.key}:ok`,
                              () => handlers.confirm(g.ids, learn[g.key] ? g.evidence : null),
                              g.key,
                            )
                          }
                        >
                          {r.busy === `${g.key}:ok` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Check className="h-3.5 w-3.5" aria-hidden />
                          )}
                          Sí, es de {g.clientName}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="min-h-9 px-4 text-xs"
                          disabled={r.pending}
                          onClick={() => r.run(`${g.key}:no`, () => handlers.reject(g.ids), g.key)}
                        >
                          <X className="h-3.5 w-3.5" aria-hidden />
                          No
                        </Button>
                      </div>
                      {g.canLearnAlias && (
                        <label className="flex items-center gap-2 text-xs text-ink-muted">
                          <input
                            type="checkbox"
                            className="h-3.5 w-3.5 accent-[var(--color-primary,#4f46e5)]"
                            checked={Boolean(learn[g.key])}
                            onChange={(e) =>
                              setLearn((prev) => ({ ...prev, [g.key]: e.target.checked }))
                            }
                          />
                          Recordar este nombre: lo próximo se vincula solo
                        </label>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="h-2" />
        </Panel>
      )}

      {/* 2. Duplicados ---------------------------------------------------- */}
      {(!duplicates.ok || visibleDupes.length > 0) && (
        <Panel>
          <div className="flex items-start gap-3 px-5 pt-4">
            <CopyCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
            <div>
              <h2 className="text-sm font-semibold text-ink">¿Son la misma empresa?</h2>
              <p className="mt-1 max-w-[680px] text-xs leading-snug text-ink-muted">
                Al unir, todo lo del segundo pasa al primero y su nombre queda como otro nombre del
                primero. Dos NIT distintos nunca se unen.
              </p>
            </div>
          </div>
          {!duplicates.ok ? (
            <Unread error={duplicates.error} />
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {visibleDupes.map((d) => {
                const key = `${d.keep.id}|${d.merge.id}`;
                return (
                  <li
                    key={key}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5"
                  >
                    <div className="min-w-0 text-sm text-ink">
                      <span className="font-semibold">{d.merge.name}</span>
                      {d.merge.nit && (
                        <span className="tabular text-ink-faint"> · NIT {d.merge.nit}</span>
                      )}
                      <span className="text-ink-faint"> → </span>
                      <span className="font-semibold">{d.keep.name}</span>
                      {d.keep.nit && (
                        <span className="tabular text-ink-faint"> · NIT {d.keep.nit}</span>
                      )}
                      <p className="mt-0.5 text-xs text-ink-faint">{d.why}</p>
                    </div>
                    {confirmMerge === key ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-ink-muted">
                          ¿Unir {d.merge.name} dentro de {d.keep.name}? No se deshace solo.
                        </span>
                        <Button
                          type="button"
                          variant="danger"
                          className="min-h-9 px-4 text-xs"
                          disabled={r.pending}
                          onClick={() => r.run(key, () => handlers.merge(d.keep.id, d.merge.id))}
                        >
                          {r.busy === key && (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          )}
                          Sí, unir
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          className="min-h-9 px-3 text-xs"
                          onClick={() => setConfirmMerge(null)}
                        >
                          Cancelar
                        </Button>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-9 px-4 text-xs"
                        onClick={() => setConfirmMerge(key)}
                      >
                        Unir…
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="h-2" />
        </Panel>
      )}

      {/* 3. Programa contable que choca ------------------------------------ */}
      {(!conflicts.ok || conflicts.data.length > 0) && (
        <Panel>
          <div className="flex items-start gap-3 px-5 pt-4">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber" aria-hidden />
            <div>
              <h2 className="text-sm font-semibold text-ink">Del programa contable, sin crear</h2>
              <p className="mt-1 max-w-[680px] text-xs leading-snug text-ink-muted">
                Traen NIT, pero ya hay un cliente con ese nombre y sin NIT. No los creé para no
                tener dos fichas: si es el mismo, ponle el NIT en su ficha; si no, regístralo
                aparte.
              </p>
            </div>
          </div>
          {!conflicts.ok ? (
            <Unread error={conflicts.error} />
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {conflicts.data.map((c) => (
                <li
                  key={c.nit}
                  className="flex items-center justify-between gap-3 px-5 py-3 text-sm"
                >
                  <span className="text-ink">{c.name}</span>
                  <span className={chipClass('neutral')}>
                    NIT {c.nit} · {c.system}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="h-2" />
        </Panel>
      )}

      {/* 4. Contrapartes sin cliente --------------------------------------- */}
      {(!backlog.ok || backlog.data.length > 0) && (
        <Panel>
          <div className="flex items-start gap-3 px-5 pt-4">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-ink-faint" aria-hidden />
            <div>
              <h2 className="text-sm font-semibold text-ink">Contrapartes sin cliente</h2>
              <p className="mt-1 max-w-[680px] text-xs leading-snug text-ink-muted">
                Nombres escritos a mano en vencimientos. Muchos no son clientes (la DIAN, una
                aseguradora, un proveedor): los que sí, los enlazas tú.
              </p>
            </div>
          </div>
          {!backlog.ok ? (
            <Unread error={backlog.error} />
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {backlog.data
                .filter((b) => !r.done.has(b.counterparty))
                .map((row) => (
                  <li
                    key={row.counterparty}
                    className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"
                  >
                    <div className="min-w-0">
                      <span className="text-sm font-medium text-ink">{row.counterparty}</span>
                      <span className="ml-2 text-xs text-ink-faint">
                        {row.count} vencimiento{row.count === 1 ? '' : 's'}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {row.candidates.map((cand) => (
                        <Button
                          key={cand.id}
                          type="button"
                          variant="outline"
                          className="min-h-9 px-4 text-xs"
                          disabled={r.pending}
                          onClick={() =>
                            r.run(
                              `${row.counterparty}:${cand.id}`,
                              () => handlers.assignCounterparty(row.counterparty, cand.id),
                              row.counterparty,
                            )
                          }
                        >
                          Es {cand.name}
                        </Button>
                      ))}
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-9 px-3 text-xs"
                        disabled={r.pending}
                        onClick={() =>
                          r.run(row.counterparty, () =>
                            handlers.claimCounterparty(row.counterparty),
                          )
                        }
                      >
                        Crear cliente
                      </Button>
                    </div>
                  </li>
                ))}
            </ul>
          )}
          <div className="h-2" />
        </Panel>
      )}
    </div>
  );
}
