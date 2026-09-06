'use client';
import { operationInbox } from '@/lib/management/operation-shape';
import type { ManagementCase } from '@/lib/management/shape';
import Link from 'next/link';
export function ExecutiveFocus({
  cases,
  userId,
  today,
  isAdmin,
  onOpen,
}: {
  cases: ManagementCase[];
  userId: string;
  today: string;
  isAdmin: boolean;
  onOpen: (c: ManagementCase) => void;
}) {
  const inbox = operationInbox(cases, userId, today, isAdmin);
  return (
    <section
      className="space-y-4 rounded-xl border border-border p-5"
      aria-label="Mi bandeja de dirección"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Tu siguiente intervención</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Verifica resultados, desbloquea trabajo y cumple los encargos a tu nombre.
          </p>
        </div>
        <Link href="/management/operation" className="text-sm font-semibold text-primary">
          Dirigir una operación de 30 días →
        </Link>
      </div>
      <div className="grid gap-5 md:grid-cols-3">
        {[
          ['Necesita tu verificación', inbox.decisions],
          ['Necesita coordinación', inbox.blocked],
          ['A tu cargo', inbox.mine],
        ].map(([label, rows]) => {
          const items = rows as ManagementCase[];
          return (
            <div key={label as string}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                {label as string} · {items.length}
              </h3>
              {items.length === 0 ? (
                <p className="mt-3 text-sm text-ink-faint">Sin pendientes en esta vista.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border">
                  {items.slice(0, 3).map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => onOpen(c)}
                        className="w-full py-3 text-left text-sm hover:text-primary"
                      >
                        <span className="block font-semibold">{c.data.title}</span>
                        <span className="mt-1 block text-xs text-ink-muted">
                          {c.data.blocker || c.data.nextAction}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {items.length > 3 && (
                <p className="text-xs text-ink-muted">{items.length - 3} más en la agenda.</p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
