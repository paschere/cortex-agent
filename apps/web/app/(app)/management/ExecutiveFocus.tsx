'use client';
import { buildManagementInbox } from '@/lib/management/inbox-overview';
import type { ManagementCase } from '@/lib/management/shape';
import { workspaceHref } from '@/lib/workspace-context';
import { ArrowUpRight, CircleCheck, CircleDot, CircleX } from 'lucide-react';
import Link from 'next/link';
import type { Person } from './form-fields';
export function ExecutiveFocus({
  cases,
  people,
  userId,
  today,
  isAdmin,
  workspaceId,
  onOpen,
}: {
  cases: ManagementCase[];
  people: Person[];
  userId: string;
  today: string;
  isAdmin: boolean;
  workspaceId: string;
  onOpen: (c: ManagementCase) => void;
}) {
  const inbox = buildManagementInbox(cases, userId, today, isAdmin);
  const personName = (id: string | null) =>
    people.find((person) => person.id === id)?.name ||
    people.find((person) => person.id === id)?.email ||
    'Sin responsable';
  const bucketConfig = [
    {
      key: 'decisions' as const,
      label: 'Decisiones',
      description: 'Resultados que requieren tu revisión.',
      icon: CircleCheck,
    },
    {
      key: 'blocked' as const,
      label: 'Bloqueos',
      description: 'Algo falta antes de poder avanzar.',
      icon: CircleX,
    },
    {
      key: 'working' as const,
      label: 'En curso',
      description: 'Trabajo abierto con siguiente paso.',
      icon: CircleDot,
    },
  ];
  return (
    <section
      className="space-y-4 rounded-xl border border-border p-5"
      aria-label="Mi bandeja de dirección"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Bandeja priorizada</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Decisiones, bloqueos y trabajo en curso ordenados por plazo, impacto y revisión.
          </p>
        </div>
        <Link
          href={workspaceHref(workspaceId, '/management/operation')}
          className="text-sm font-semibold text-primary"
        >
          Dirigir una operación de 30 días →
        </Link>
      </div>
      <div className="grid gap-5 md:grid-cols-3">
        {bucketConfig.map(({ key, label, description, icon: Icon }) => {
          const items = inbox[key];
          return (
            <div key={key} className="min-w-0">
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <div className="min-w-0">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                    {label} · {items.length}
                  </h3>
                  <p className="mt-1 text-xs text-ink-faint">{description}</p>
                </div>
              </div>
              {items.length === 0 ? (
                <p className="mt-3 text-sm text-ink-faint">Sin pendientes en esta vista.</p>
              ) : (
                <ul className="mt-2 divide-y divide-border">
                  {items.slice(0, 4).map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          const itemCase = cases.find((candidate) => candidate.id === item.id);
                          if (itemCase) onOpen(itemCase);
                        }}
                        className="w-full py-3 text-left text-sm hover:text-primary"
                      >
                        <span className="block break-words font-semibold">{item.title}</span>
                        <span className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
                          <span>{personName(item.ownerId)}</span>
                          <span>Plazo {item.dueOn}</span>
                          <span>{item.evidenceLabel}</span>
                        </span>
                        <span className="mt-1 block break-words text-xs text-ink-muted">
                          {item.blocker || item.nextAction}
                        </span>
                        <span className="mt-1 block text-xs font-medium text-primary">
                          {item.reasons.join(' · ')}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {items.length > 4 && (
                <Link
                  href={workspaceHref(workspaceId, '/management')}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-primary"
                >
                  {items.length - 4} más en la agenda <ArrowUpRight className="h-3 w-3" />
                </Link>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
