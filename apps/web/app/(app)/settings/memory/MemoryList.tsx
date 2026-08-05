'use client';

import {
  MEMORY_LIMIT_VIEW,
  type MemoryAction,
  type MemoryKindView,
  type MemorySourceView,
  type MemoryView,
} from '@/app/api/settings/memories/schema';
import { Button } from '@/components/ui/button';
import { Eyebrow, Panel } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { Archive, Brain, Check, Loader2, MessageSquare, RotateCcw, Trash2, X } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

/**
 * Memories read as sentences, not as rows of fields — they are things Cortex
 * would say about you, and seeing them as a table of `kind | source | status`
 * makes it impossible to judge whether one is actually right. The metadata is
 * still there, underneath, in the smallest type on the page.
 */

const KIND_LABEL: Record<MemoryKindView, string> = {
  instruction: 'Siempre lo hace así',
  preference: 'Cómo te gustan las cosas',
  vocabulary: 'A qué te refieres',
  fact: 'Sobre ti',
};

const SOURCE_LABEL: Record<MemorySourceView, string> = {
  explicit: 'Se lo dijiste tú',
  derived: 'Lo notó en tus conversaciones',
  behavioural: 'Lo contó de lo que realmente haces',
};

function whenLastUseful(memory: MemoryView): string {
  if (!memory.lastUsedAt) return 'sin usar todavía';
  const days = Math.floor((Date.now() - new Date(memory.lastUsedAt).getTime()) / 86_400_000);
  if (days <= 0) return 'usada hoy';
  if (days === 1) return 'usada ayer';
  if (days < 30) return `útil hace ${days} días`;
  const months = Math.floor(days / 30);
  return `útil hace ${months} ${months === 1 ? 'mes' : 'meses'}`;
}

function Meta({ children }: { children: React.ReactNode }) {
  return <span className="text-[12px] text-ink-faint">{children}</span>;
}

/** One memory: the sentence first, everything else smaller and underneath. */
function MemoryCard({
  memory,
  busy,
  actions,
}: {
  memory: MemoryView;
  busy: boolean;
  actions: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        'flex flex-col gap-3 border-b border-border px-5 py-4 transition-colors duration-150 last:border-b-0 hover:bg-surface-2 sm:flex-row sm:items-start sm:justify-between',
        busy && 'opacity-50',
      )}
    >
      <div className="min-w-0">
        <p className="text-[14px] leading-relaxed text-ink">{memory.content}</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Meta>{KIND_LABEL[memory.kind]}</Meta>
          <Meta>·</Meta>
          <Meta>{SOURCE_LABEL[memory.source]}</Meta>
          {memory.status === 'active' && (
            <>
              <Meta>·</Meta>
              <Meta>{whenLastUseful(memory)}</Meta>
            </>
          )}
        </div>
        {memory.sourceNote && (
          <p className="mt-2 border-l-2 border-border pl-3 text-[12.5px] leading-relaxed text-ink-muted">
            {memory.sourceNote}
          </p>
        )}
        {memory.sourceConversationId && (
          <Link
            href={`/chat/${memory.sourceConversationId}`}
            className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-primary hover:underline"
          >
            <MessageSquare className="h-3.5 w-3.5" />
            Abrir la conversación de donde salió
          </Link>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">{actions}</div>
    </div>
  );
}

export function MemoryList({ initial }: { initial: MemoryView[] }) {
  const [memories, setMemories] = useState(initial);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function send(id: string, request: () => Promise<Response>) {
    setBusyId(id);
    setError(null);
    try {
      const res = await request();
      const json = (await res.json()) as { memories?: MemoryView[]; error?: string };
      if (!res.ok) {
        setError(json.error ?? 'Eso no funcionó. Inténtalo de nuevo en un momento.');
        return;
      }
      if (json.memories) setMemories(json.memories);
    } catch {
      setError('No se pudo conectar con Cortex. Revisa tu conexión.');
    } finally {
      setBusyId(null);
    }
  }

  const act = (id: string, action: MemoryAction) =>
    send(id, () =>
      fetch('/api/settings/memories', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      }),
    );

  const remove = (id: string) =>
    send(id, () =>
      fetch(`/api/settings/memories?id=${encodeURIComponent(id)}`, { method: 'DELETE' }),
    );

  const suggested = memories.filter((m) => m.status === 'suggested');
  const active = memories.filter((m) => m.status === 'active');
  const archived = memories.filter((m) => m.status === 'archived');

  return (
    <div className="flex flex-col gap-5">
      {error && (
        <div className="rounded-card border border-border bg-rose-soft px-4 py-3 text-[13px] text-rose shadow-card">
          {error}
        </div>
      )}

      {suggested.length > 0 && (
        <Panel>
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
            <Eyebrow>Esperando por ti</Eyebrow>
            <span className="text-[12px] text-ink-faint">
              <span className="tabular">{suggested.length}</span> por decidir
            </span>
          </div>
          <p className="px-5 pb-3 text-[13px] leading-relaxed text-ink-muted">
            Cortex notó estas cosas mientras trabajabas. Nada de esto se está usando todavía:
            empieza a influir en las respuestas solo cuando lo guardas.
          </p>
          <div className="border-t border-border">
            {suggested.map((m) => (
              <MemoryCard
                key={m.id}
                memory={m}
                busy={busyId === m.id}
                actions={
                  <>
                    <Button
                      variant="outline"
                      onClick={() => act(m.id, 'reject')}
                      disabled={busyId === m.id}
                    >
                      <X className="h-3.5 w-3.5" />
                      No es así
                    </Button>
                    <Button onClick={() => act(m.id, 'accept')} disabled={busyId === m.id}>
                      {busyId === m.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Check className="h-3.5 w-3.5" />
                      )}
                      Guardar
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        </Panel>
      )}

      <Panel>
        <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <Eyebrow>En cada conversación</Eyebrow>
          <span className="tabular text-[12px] text-ink-faint">
            {active.length} de {MEMORY_LIMIT_VIEW}
          </span>
        </div>
        <p className="px-5 pb-3 text-[13px] leading-relaxed text-ink-muted">
          Cortex lleva esto a cada conversación, en todas partes: la app, Google Chat y Claude.
          Nunca las cita en voz alta en un espacio de grupo, solo las usa.
        </p>
        {active.length === 0 ? (
          <div className="border-t border-border px-5 py-10 text-center">
            <Brain className="mx-auto h-6 w-6 text-ink-faint" />
            <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-ink-muted">
              Cortex todavía no lleva nada. Dile &ldquo;acuérdate de que…&rdquo; en una conversación,
              o déjalo así: empieza a sugerir cosas después de unos días trabajando contigo.
            </p>
            <Link href="/chat" className="mt-4 inline-block">
              <Button variant="outline">
                <MessageSquare className="h-3.5 w-3.5" />
                Empezar una conversación
              </Button>
            </Link>
          </div>
        ) : (
          <div className="border-t border-border">
            {active.map((m) => (
              <MemoryCard
                key={m.id}
                memory={m}
                busy={busyId === m.id}
                actions={
                  <>
                    <Button
                      variant="ghost"
                      aria-label="Dejar de usar esta memoria"
                      title="Deja de usarla, pero la conserva aquí"
                      onClick={() => act(m.id, 'archive')}
                      disabled={busyId === m.id}
                    >
                      <Archive className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label="Borrar esta memoria"
                      title="Bórrala para siempre"
                      onClick={() => remove(m.id)}
                      disabled={busyId === m.id}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        )}
      </Panel>

      {archived.length > 0 && (
        <Panel>
          <div className="px-5 pt-4 pb-3">
            <Eyebrow>Ya no se usan</Eyebrow>
          </div>
          <p className="px-5 pb-3 text-[13px] leading-relaxed text-ink-muted">
            Las guardaste aparte, o se salieron cuando llegaste a{' '}
            <span className="tabular">{MEMORY_LIMIT_VIEW}</span>. Cortex no las usa, y nada se borra
            a tus espaldas.
          </p>
          <div className="border-t border-border">
            {archived.map((m) => (
              <MemoryCard
                key={m.id}
                memory={m}
                busy={busyId === m.id}
                actions={
                  <>
                    <Button
                      variant="outline"
                      onClick={() => act(m.id, 'restore')}
                      disabled={busyId === m.id}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      Volver a usarla
                    </Button>
                    <Button
                      variant="ghost"
                      aria-label="Borrar esta memoria"
                      onClick={() => remove(m.id)}
                      disabled={busyId === m.id}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </>
                }
              />
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}
