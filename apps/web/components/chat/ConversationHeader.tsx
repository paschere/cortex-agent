'use client';

import type { ScopeSpace } from '@/app/(chat)/chat/actions';
import { conversationMarkdown, markdownFileName } from '@/lib/chat-turn';
import { formatDuration } from '@/lib/tool-args';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import {
  Activity,
  BookOpen,
  Download,
  Filter,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useChatArtifacts } from './ChatArtifacts';
import { usePinned } from './ThreadHistory';
import { useTurnRows } from './TurnPanel';

/**
 * LA CABECERA DE LA CONVERSACIÓN, PARA QUIEN LA USA TODO EL DÍA.
 *
 * El título se renombra ahí mismo (clic, Enter guarda, Esc deja como estaba);
 * las pastillas dicen qué espacios están en juego (vacío = todo lo que esta
 * persona puede ver); una línea discreta da la duración del último turno que
 * ya medía el servidor; y las dos pestañas del panel (Fuentes, Actividad) se
 * abren desde aquí. El menú «…» fija, renombra, exporta y elimina con las
 * mismas rutas que la lista de chats. Junto a la duración va, discreto, lo que
 * costó la conversación («$ 1.240 · 12.400 tokens»): el consumo registrado de
 * sus turnos con precio en pesos (0228); sin consumo registrado, nada.
 */

const menuItem =
  'flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-2 text-sm text-ink-muted outline-none transition-colors duration-150 data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink motion-reduce:transition-none';

const chip =
  'inline-flex h-7 items-center gap-1.5 rounded-pill bg-surface-2 px-2.5 text-xs font-medium text-ink-muted transition-colors duration-150 hover:bg-border hover:text-ink motion-reduce:transition-none';

interface Props {
  conversationId: string | undefined;
  title: string;
  onTitle: (next: string) => void;
  scope: ScopeSpace[];
  messages: ReadonlyArray<{ role: string; content: string }>;
}

export function ConversationHeader({ conversationId, title, onTitle, scope, messages }: Props) {
  const router = useRouter();
  const qc = useQueryClient();
  const api = useChatArtifacts();
  const rows = useTurnRows(api?.turn ?? null);
  const [pinned, togglePin] = usePinned();
  const [mode, setMode] = useState<'view' | 'rename'>('view');
  const [draft, setDraft] = useState(title);
  const [failed, setFailed] = useState(false);
  const [armed, setArmed] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode === 'rename') inputRef.current?.select();
  }, [mode]);

  const save = async () => {
    const next = draft.replace(/\s+/g, ' ').trim();
    if (!conversationId || !next || next === title) {
      setMode('view');
      return;
    }
    try {
      const r = await fetch(`/api/conversations/${conversationId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: next }),
      });
      if (!r.ok) throw new Error('rename');
      onTitle(next);
      void qc.invalidateQueries({ queryKey: ['conversations'] });
      setFailed(false);
      setMode('view');
    } catch {
      setFailed(true);
    }
  };

  const remove = async () => {
    if (!conversationId) return;
    try {
      const r = await fetch(`/api/conversations/${conversationId}`, { method: 'DELETE' });
      if (!r.ok) throw new Error('delete');
      await qc.invalidateQueries({ queryKey: ['conversations'] });
      router.push('/chat');
    } catch {
      setFailed(true);
    }
  };

  const exportMarkdown = () => {
    const blob = new Blob([conversationMarkdown(title, messages)], {
      type: 'text/markdown;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = markdownFileName(title);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const metrics = api?.turn?.metrics ?? null;
  const total = formatDuration(metrics?.totalMs);
  // El costo se relee cuando termina un turno nuevo (cambian sus medidas) y
  // una vez más poco después: el consumo se escribe justo tras la respuesta.
  const turnKey = metrics ? `${metrics.totalMs}:${metrics.toolCalls}` : null;
  const cost = useQuery({
    queryKey: ['conversation-cost', conversationId, turnKey],
    enabled: Boolean(conversationId),
    staleTime: 15_000,
    queryFn: async (): Promise<{ line: string; usd: number } | null> => {
      const r = await fetch(`/api/conversations/${conversationId}/cost`, { cache: 'no-store' });
      if (!r.ok) return null;
      const body = (await r.json()) as { cost: { line: string; usd: number } | null };
      return body.cost;
    },
  });
  useEffect(() => {
    if (!turnKey) return;
    const t = setTimeout(
      () => void qc.invalidateQueries({ queryKey: ['conversation-cost', conversationId] }),
      2500,
    );
    return () => clearTimeout(t);
  }, [turnKey, conversationId, qc]);
  const isPinned = conversationId ? pinned.has(conversationId) : false;
  const shownScope = scope.slice(0, 2);
  const restScope = scope.length - shownScope.length;

  return (
    <>
      <div className="flex min-w-0 flex-col justify-center gap-0.5">
        <div className="flex min-w-0 items-center gap-1.5">
          {mode === 'rename' ? (
            <input
              ref={inputRef}
              value={draft}
              maxLength={120}
              aria-label="Título de la conversación"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setDraft(title);
                  setMode('view');
                }
              }}
              onBlur={() => void save()}
              className="min-w-0 flex-1 rounded-sm border border-border-strong bg-surface px-2 py-0.5 font-display text-lg text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          ) : (
            <button
              type="button"
              disabled={!conversationId}
              onClick={() => {
                setDraft(title);
                setMode('rename');
              }}
              title={conversationId ? 'Clic para renombrar' : undefined}
              className="min-w-0 truncate rounded-sm px-1 text-left font-display text-lg tracking-[-0.01em] text-ink enabled:hover:bg-surface-2"
            >
              {title}
            </button>
          )}
          {isPinned && <Pin className="h-3 w-3 shrink-0 text-ink-faint" aria-label="Fijado" />}
          {failed && (
            <span role="alert" className="shrink-0 text-xs font-semibold text-rose">
              No se pudo
            </span>
          )}
        </div>
        <div className="hidden min-w-0 items-center gap-1.5 text-micro text-ink-faint sm:flex">
          <Filter className="h-3 w-3 shrink-0" aria-hidden />
          {scope.length === 0 ? (
            <span>Todo lo que puedes ver</span>
          ) : (
            <>
              {shownScope.map((s) => (
                <span
                  key={s.id}
                  className="truncate rounded-pill bg-surface-2 px-2 py-px text-ink-muted"
                >
                  {s.name}
                </span>
              ))}
              {restScope > 0 && <span>+{restScope}</span>}
            </>
          )}
        </div>
      </div>
      <HeaderActions
        api={api}
        sources={rows.sources.length}
        activity={rows.activity.length}
        menu={
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              aria-label="Más opciones de la conversación"
              className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
            >
              <MoreHorizontal className="h-4 w-4" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                onCloseAutoFocus={() => setArmed(false)}
                className="z-[70] w-56 rounded-card border border-border bg-surface p-1.5 shadow-pop"
              >
                {(cost.data || (total && metrics)) && (
                  <>
                    <div className="tabular px-2.5 py-1.5 font-mono text-micro leading-relaxed text-ink-faint">
                      {cost.data && (
                        <div title="Estimado, a la tasa de la empresa">{cost.data.line}</div>
                      )}
                      {total && metrics && (
                        <div>
                          {total}
                          {metrics.toolCalls > 0
                            ? ` · ${metrics.toolCalls} ${metrics.toolCalls === 1 ? 'paso' : 'pasos'}`
                            : ''}
                        </div>
                      )}
                    </div>
                    <DropdownMenu.Separator className="my-1 h-px bg-border" />
                  </>
                )}
                <DropdownMenu.Item
                  className={menuItem}
                  disabled={!conversationId}
                  onSelect={() => conversationId && togglePin(conversationId)}
                >
                  {isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
                  {isPinned ? 'Quitar de fijados' : 'Fijar'}
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={menuItem}
                  disabled={!conversationId}
                  onSelect={() => {
                    setDraft(title);
                    setMode('rename');
                  }}
                >
                  <Pencil className="h-4 w-4" /> Renombrar
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className={menuItem}
                  disabled={messages.length === 0}
                  onSelect={exportMarkdown}
                >
                  <Download className="h-4 w-4" /> Exportar como Markdown
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  className={clsx(menuItem, 'text-rose data-[highlighted]:text-rose')}
                  disabled={!conversationId}
                  onSelect={(e) => {
                    if (!armed) {
                      e.preventDefault();
                      setArmed(true);
                      return;
                    }
                    void remove();
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  {armed ? 'Pulsa otra vez para eliminar' : 'Eliminar'}
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        }
      />
    </>
  );
}

/** Las pestañas del panel y el menú «…», a la derecha del título. */
function HeaderActions({
  api,
  sources,
  activity,
  menu,
}: {
  api: ReturnType<typeof useChatArtifacts>;
  sources: number;
  activity: number;
  menu: React.ReactNode;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {api && (
        <>
          <button
            type="button"
            onClick={() => api.openTab('fuentes')}
            aria-pressed={api.panelOpen && api.tab === 'fuentes'}
            className={chip}
          >
            <BookOpen className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden md:inline">Fuentes</span>
            {sources > 0 && <span className="tabular">{sources}</span>}
          </button>
          <button
            type="button"
            onClick={() => api.openTab('actividad')}
            aria-pressed={api.panelOpen && api.tab === 'actividad'}
            className={chip}
          >
            <Activity className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden md:inline">Actividad</span>
            {activity > 0 && <span className="tabular">{activity}</span>}
          </button>
        </>
      )}
      {menu}
    </div>
  );
}
