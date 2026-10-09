'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { Check, ClipboardCopy, Pencil, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useState, useTransition } from 'react';
import { decideCase, editLesson, forgetLesson } from '../actions';

/**
 * «Lo que aprendí» y «casos candidatos» (migración 0219).
 *
 * Plain data only — no import of `@cortex/agent-tools`; the page maps rows to
 * these shapes on the server.
 */

export interface LessonCard {
  id: string;
  content: string;
  kind: string;
  createdAt: string;
}

export interface CaseCard {
  id: string;
  question: string;
  answer: string;
  reasonLabel: string | null;
  comment: string | null;
  createdAt: string;
}

export interface LessonsView {
  lessons: LessonCard[];
  cases: CaseCard[];
  /** JSON de los casos ya promovidos, listo para copiar a la suite. */
  promotedJson: string;
  promotedCount: number;
  pendingCompanyProposals: number;
}

type Result = { ok: true } | { ok: false; error: string };

export function Lessons({ view }: { view: LessonsView }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [copied, setCopied] = useState(false);

  const run = (fn: () => Promise<Result>, after?: () => void) => {
    setError(null);
    start(async () => {
      const out = await fn();
      if (!out.ok) setError(out.error);
      else after?.();
    });
  };

  return (
    <div className="mt-8 space-y-6">
      {error && (
        <div className="rounded-card border border-rose/30 bg-rose-soft px-4 py-3 text-xs text-rose">
          {error}
        </div>
      )}

      <Panel>
        <PanelHead title="Lo que aprendí" />
        <p className="px-6 pb-3 pt-1 text-xs text-ink-muted">
          Lo que me has corregido o pedido recordar. Puedes cambiarlo o borrarlo.
        </p>
        {view.lessons.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-ink-muted">
            Todavía nada. Cuando me corrijas en el chat, o pulses 👎 y me cuentes lo correcto,
            aparece aquí.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {view.lessons.map((lesson) => (
              <li key={lesson.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  {editing === lesson.id ? (
                    <div className="flex gap-2">
                      <input
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        maxLength={240}
                        aria-label="Texto del recuerdo"
                        className="min-w-0 flex-1 rounded-card border border-border bg-canvas px-2.5 py-1.5 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                      />
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(
                            () => editLesson(lesson.id, draft),
                            () => setEditing(null),
                          )
                        }
                        className="rounded-pill p-1.5 text-emerald hover:bg-emerald-soft"
                        aria-label="Guardar cambio"
                      >
                        <Check className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="rounded-pill p-1.5 text-ink-muted hover:bg-primary-soft"
                        aria-label="Cancelar"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  ) : (
                    <p className="text-sm text-ink">{lesson.content}</p>
                  )}
                </div>
                {editing !== lesson.id && (
                  <div className="flex shrink-0 gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(lesson.id);
                        setDraft(lesson.content);
                      }}
                      className="rounded-pill p-1.5 text-ink-faint hover:bg-primary-soft hover:text-primary-ink"
                      aria-label="Editar"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => run(() => forgetLesson(lesson.id))}
                      className="rounded-pill p-1.5 text-ink-faint hover:bg-rose-soft hover:text-rose"
                      aria-label="Olvidar"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {view.pendingCompanyProposals > 0 && (
          <p className="border-t border-border px-4 py-3 text-xs text-ink-muted">
            Hay {view.pendingCompanyProposals} dato(s) de la empresa esperando aprobación en{' '}
            <Link href="/kb" className="font-semibold text-primary-ink underline">
              Brain Knowledge
            </Link>
            .
          </p>
        )}
      </Panel>

      <Panel>
        <PanelHead title="Respuestas que fallaron" />
        <p className="px-6 pb-3 pt-1 text-xs text-ink-muted">
          Los 👎 con su pregunta. Conviértelos en caso de prueba para que la evaluación vigile que
          no se repitan.
        </p>
        {view.cases.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-ink-muted">Ningún 👎 por revisar.</p>
        ) : (
          <ul className="divide-y divide-border">
            {view.cases.map((c) => (
              <li key={c.id} className="space-y-1.5 px-4 py-3">
                <p className="text-sm font-semibold text-ink">{c.question}</p>
                <p className="line-clamp-3 text-xs text-ink-muted">{c.answer}</p>
                {(c.reasonLabel || c.comment) && (
                  <p className="text-xs text-rose">
                    {c.reasonLabel}
                    {c.reasonLabel && c.comment ? ' — ' : ''}
                    {c.comment}
                  </p>
                )}
                <div className="flex gap-2 pt-1">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => decideCase(c.id, 'promoted'))}
                    className="rounded-pill bg-primary px-3 py-1 text-micro font-semibold text-white disabled:opacity-60"
                  >
                    Convertir en caso de prueba
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => decideCase(c.id, 'dismissed'))}
                    className="rounded-pill border border-border px-3 py-1 text-micro font-semibold text-ink-muted hover:text-ink"
                  >
                    Descartar
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {view.promotedCount > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
            <p className="text-xs text-ink-muted">
              {view.promotedCount} caso(s) de prueba guardado(s). La suite de evaluación aún no los
              carga sola.
            </p>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(view.promotedJson);
                setCopied(true);
                setTimeout(() => setCopied(false), 1400);
              }}
              className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1 text-micro font-semibold text-ink-muted hover:text-ink"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <ClipboardCopy className="h-3.5 w-3.5" />
              )}
              Copiar JSON
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}
