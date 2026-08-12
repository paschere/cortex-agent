'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { ArrowUp, Bot, Building2, ChevronDown, FileText, Layers, Terminal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AttachmentTray } from './AttachmentTray';

interface AgentInfo {
  slug: string;
  name: string;
  description?: string;
}

interface InputBarProps {
  onSend: (text: string) => void;
  disabled: boolean;
  conversationId?: string;
  agents: AgentInfo[];
  agentSlug: string;
  onAgentChange: (slug: string) => void;
  draft?: string;
  onDraftConsumed?: () => void;
}

const CHAR_COUNT_THRESHOLD = 3500;

/**
 * `/` COMMANDS AND `@` MENTIONS — and the thing that is deliberately absent.
 *
 * ===========================================================================
 * NO MODEL SELECTOR
 * ===========================================================================
 * The reference puts one in the composer and it is the one idea from it that is
 * rejected outright here. Which model answers is a product decision, argued and
 * MEASURED in packages/agent-tools/src/model.ts — Sonnet 5 over Opus 5 on cost
 * for a tool-heavy turn, reasoning off because at `max` it ate the answer's
 * budget on exactly the long turns this product is made of. Exposing that as a
 * dropdown would hand a dispatcher a dial whose settings they cannot evaluate,
 * make every support conversation start with "which model were you on", and
 * quietly invalidate the latency and quality numbers the product is tuned
 * against. The agent pill stays because agents differ in what they are ALLOWED
 * to do, which is the person's business; the model is not.
 *
 * ===========================================================================
 * BOTH MENUS EXPAND TO PLAIN TEXT
 * ===========================================================================
 * `@Coltrans` becomes the client's name and `/vencimientos` becomes a sentence.
 * Neither attaches a hidden parameter to the request, and that is the whole
 * design: a question composed with the menus and the same question typed by
 * hand produce byte-identical turns. So there is nothing here that can widen
 * what the model sees, nothing that behaves differently for the person who
 * knows the shortcuts, and nothing extra to reason about when a turn goes
 * wrong. A command is a phrase somebody would have had to type; a mention is a
 * name they would have had to spell.
 */

interface Command {
  name: string;
  hint: string;
  /** What lands in the composer. A trailing space means "keep typing here". */
  expands: string;
}

const COMMANDS: Command[] = [
  {
    name: '/vencimientos',
    hint: 'Qué se vence y cuándo',
    expands: '¿Qué documentos y compromisos se vencen en los próximos 30 días?',
  },
  {
    name: '/placa',
    hint: 'Consultar RUNT y SIMIT',
    expands: 'Consulta la placa ',
  },
  {
    name: '/informe',
    hint: 'Generar y guardar un informe',
    expands: 'Hazme el informe de vencimientos de este mes.',
  },
  {
    name: '/grafica',
    hint: 'Dibujar lo que se acaba de calcular',
    expands: 'Gráfica ',
  },
  {
    name: '/buscar',
    hint: 'Buscar en Brain Knowledge',
    expands: 'Busca en Brain Knowledge lo que tengamos sobre ',
  },
  {
    name: '/rutina',
    hint: 'Programar algo que se repita',
    expands: 'Todos los lunes a las 8 de la mañana, ',
  },
  {
    name: '/briefing',
    hint: 'Estado del negocio desde HubSpot',
    expands: '/briefing ',
  },
];

interface MentionHit {
  kind: 'client' | 'document' | 'space';
  id: string;
  label: string;
  detail: string | null;
}

const MENTION_ICON = {
  client: Building2,
  document: FileText,
  space: Layers,
} as const;

const BRIEFING_COMMAND = '/briefing';

function expandBriefingCommand(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(BRIEFING_COMMAND)) return null;
  const company = trimmed.slice(BRIEFING_COMMAND.length).trim();
  if (!company) return null;
  return `Fetch a deal health briefing for ${company}: search HubSpot for the company, get the most recent deal, list BANT signals present/missing, and summarize last 3 activities.`;
}

/** The `@word` being typed at the caret, if any. */
function mentionAtCaret(text: string, caret: number): { query: string; start: number } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  // Must start a word: `correo@empresa.com` is an address, not a mention.
  if (at > 0 && !/\s/.test(before[at - 1] ?? '')) return null;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return null;
  return { query, start: at };
}

export function InputBar({
  onSend,
  disabled,
  conversationId,
  agents,
  agentSlug,
  onAgentChange,
  draft,
  onDraftConsumed,
}: InputBarProps) {
  const [text, setText] = useState('');
  const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(0);
  const [hits, setHits] = useState<MentionHit[]>([]);
  const [active, setActive] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeAgent = agents.find((a) => a.slug === agentSlug) ?? agents[0];
  const pillDisabled = !!conversationId || agents.length <= 1;

  const mention = useMemo(() => mentionAtCaret(text, caret), [text, caret]);
  const commandQuery =
    text.startsWith('/') && !text.includes(' ') ? text.toLowerCase() : null;
  const commands = useMemo(
    () => (commandQuery ? COMMANDS.filter((c) => c.name.startsWith(commandQuery)) : []),
    [commandQuery],
  );

  const menuOpen = (mention !== null && hits.length > 0) || commands.length > 0;
  const options: Array<{ key: string; run: () => void; node: React.ReactNode }> = [];

  // Look up mentions as the person types, and never block the composer on it.
  useEffect(() => {
    if (!mention || mention.query.length < 2) {
      setHits([]);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      fetch(`/api/chat/mentions?q=${encodeURIComponent(mention.query)}`)
        .then((r) => (r.ok ? r.json() : { hits: [] }))
        .then((data: { hits?: MentionHit[] }) => {
          if (alive) {
            setHits(data.hits ?? []);
            setActive(0);
          }
        })
        .catch(() => {
          if (alive) setHits([]);
        });
    }, 140);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [mention]);

  const resize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, []);

  const put = useCallback(
    (value: string, caretAt?: number) => {
      setText(value);
      const ta = textareaRef.current;
      if (!ta) return;
      requestAnimationFrame(() => {
        ta.focus();
        const at = caretAt ?? value.length;
        ta.setSelectionRange(at, at);
        setCaret(at);
        resize();
      });
    },
    [resize],
  );

  // Prefill from a suggestion, a follow-up chip or a quoted selection.
  useEffect(() => {
    if (draft) {
      put(draft);
      onDraftConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  function applyMention(hit: MentionHit) {
    if (!mention) return;
    const before = text.slice(0, mention.start);
    const after = text.slice(caret);
    // The NAME, not the id: the next turn is a sentence a person could have
    // typed, and nothing downstream has to know a menu was involved.
    const inserted = `${hit.label} `;
    put(`${before}${inserted}${after}`, before.length + inserted.length);
    setHits([]);
  }

  function applyCommand(command: Command) {
    put(command.expands);
  }

  for (const command of commands) {
    options.push({
      key: command.name,
      run: () => applyCommand(command),
      node: (
        <>
          <Terminal className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          <span className="font-mono text-[12.5px] font-semibold text-ink">{command.name}</span>
          <span className="truncate text-[12px] text-ink-faint">{command.hint}</span>
        </>
      ),
    });
  }
  if (mention) {
    for (const hit of hits) {
      const Icon = MENTION_ICON[hit.kind];
      options.push({
        key: `${hit.kind}:${hit.id}`,
        run: () => applyMention(hit),
        node: (
          <>
            <Icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
            <span className="truncate text-[12.5px] font-medium text-ink">{hit.label}</span>
            {hit.detail && (
              <span className="truncate text-[12px] text-ink-faint">{hit.detail}</span>
            )}
          </>
        ),
      });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const expanded = expandBriefingCommand(text);
    const trimmed = (expanded ?? text).trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    setHits([]);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menuOpen && options.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % options.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + options.length) % options.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        options[active]?.run();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setHits([]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    setCaret(e.target.selectionStart ?? e.target.value.length);
    resize();
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      <div className="mx-auto w-full max-w-3xl">
        {conversationId && (
          <div className="mb-2">
            <AttachmentTray
              conversationId={conversationId}
              onAsk={(question) => put(question)}
            />
          </div>
        )}

        <div className="relative">
          {menuOpen && options.length > 0 && (
            /*
              A real listbox, not a styled div: arrow keys move `aria-activedescendant`
              and the textarea keeps focus, so somebody driving this from the
              keyboard never loses their place in what they were writing.
            */
            <ul
              id="composer-menu"
              // biome-ignore lint/a11y/useSemanticElements: the listbox pattern is correct here; focus stays in the textarea.
              role="listbox"
              aria-label={mention ? 'Fuentes' : 'Comandos'}
              className="scroll-slim absolute bottom-full z-40 mb-2 max-h-64 w-full overflow-y-auto rounded-card border border-border bg-surface p-1.5 shadow-pop"
            >
              {options.map((option, i) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handling lives on the textarea, which keeps focus.
                <li
                  key={option.key}
                  id={`composer-option-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseEnter={() => setActive(i)}
                  onMouseDown={(e) => {
                    // Before blur, so the caret position is still valid.
                    e.preventDefault();
                    option.run();
                  }}
                  className={clsx(
                    'flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5',
                    i === active && 'bg-primary-soft',
                  )}
                >
                  {option.node}
                </li>
              ))}
            </ul>
          )}

          <form
            onSubmit={handleSubmit}
            className={clsx(
              'rounded-card border bg-surface transition-all duration-150 motion-reduce:transition-none',
              focused
                ? 'border-primary/40 shadow-pop ring-4 ring-primary/10'
                : 'border-border shadow-card',
            )}
          >
            <textarea
              ref={textareaRef}
              value={text}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Pregunta por una llamada, una placa o una rutina. @ para nombrar algo, / para un comando…"
              disabled={disabled}
              rows={1}
              role="combobox"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? 'composer-menu' : undefined}
              aria-activedescendant={menuOpen ? `composer-option-${active}` : undefined}
              aria-autocomplete="list"
              className="scroll-slim block max-h-[200px] min-h-[24px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
            />

            <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
              {pillDisabled ? (
                <span
                  title="Empieza un chat nuevo para cambiar de agente"
                  className="inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3 py-1.5 text-xs font-medium text-ink-faint"
                >
                  <Bot className="h-3.5 w-3.5" />
                  {activeAgent?.name ?? 'Agente'}
                </span>
              ) : (
                <DropdownMenu.Root>
                  <DropdownMenu.Trigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-xs font-semibold text-ink-muted transition-colors duration-150 hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
                    >
                      <Bot className="h-3.5 w-3.5 text-primary" />
                      {activeAgent?.name ?? 'Agente'}
                      <ChevronDown size={12} className="opacity-60" />
                    </button>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      side="top"
                      align="start"
                      sideOffset={8}
                      className="z-50 min-w-[240px] rounded-card border border-border bg-surface p-1.5 shadow-pop"
                    >
                      {agents.map((a) => (
                        <DropdownMenu.Item
                          key={a.slug}
                          onSelect={() => onAgentChange(a.slug)}
                          className="flex cursor-pointer flex-col gap-0.5 rounded-sm px-2.5 py-2 text-sm outline-none transition-colors duration-150 data-[highlighted]:bg-primary-soft motion-reduce:transition-none"
                        >
                          <span className="font-semibold text-ink">{a.name}</span>
                          {a.description && (
                            <span className="line-clamp-1 text-xs text-ink-faint">
                              {a.description}
                            </span>
                          )}
                        </DropdownMenu.Item>
                      ))}
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              )}

              <div className="flex items-center gap-2">
                {text.length > CHAR_COUNT_THRESHOLD && (
                  <span className="tabular text-[10px] text-ink-faint">{text.length}</span>
                )}
                <button
                  type="submit"
                  disabled={disabled || !text.trim()}
                  aria-label="Enviar mensaje"
                  className="grid h-8 w-8 place-items-center rounded-full bg-primary text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong disabled:opacity-40 disabled:shadow-none motion-reduce:transform-none motion-reduce:transition-none"
                >
                  <ArrowUp size={16} strokeWidth={2.5} />
                </button>
              </div>
            </div>
          </form>
        </div>

        <p className="mt-1.5 text-center text-[11px] text-ink-faint">
          Cada respuesta trae su fuente: revísala antes de actuar.
        </p>
      </div>
    </div>
  );
}
