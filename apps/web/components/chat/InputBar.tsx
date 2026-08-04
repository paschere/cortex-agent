'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { ArrowUp, Bot, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { FileDropZone } from './FileDropZone';

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
const BRIEFING_COMMAND = '/briefing';

function expandBriefingCommand(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed.toLowerCase().startsWith(BRIEFING_COMMAND)) return null;
  const company = trimmed.slice(BRIEFING_COMMAND.length).trim();
  if (!company) return null;
  return `Fetch a deal health briefing for ${company}: search HubSpot for the company, get the most recent deal, list BANT signals present/missing, and summarize last 3 activities.`;
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
  const [showBriefingHint, setShowBriefingHint] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeAgent = agents.find((a) => a.slug === agentSlug) ?? agents[0];
  // Cortex is the only agent: an existing conversation is pinned to its agent,
  // and with a single agent there is nothing to switch to.
  const pillDisabled = !!conversationId || agents.length <= 1;

  // Prefill from an external suggestion click.
  useEffect(() => {
    if (draft) {
      setText(draft);
      setShowBriefingHint(draft.toLowerCase().startsWith(BRIEFING_COMMAND));
      const ta = textareaRef.current;
      if (ta) {
        ta.focus();
        ta.style.height = 'auto';
        ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
        ta.setSelectionRange(ta.value.length, ta.value.length);
      }
      onDraftConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const expanded = expandBriefingCommand(text);
    const trimmed = (expanded ?? text).trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
    setShowBriefingHint(false);
    if (textareaRef.current) textareaRef.current.style.height = 'auto';
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e as unknown as React.FormEvent);
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setText(value);
    setShowBriefingHint(value.toLowerCase().startsWith(BRIEFING_COMMAND));
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }

  return (
    <div className="shrink-0 px-4 pb-4 pt-1">
      <div className="mx-auto w-full max-w-3xl">
        {conversationId && (
          <div className="mb-2">
            <FileDropZone conversationId={conversationId} />
          </div>
        )}

        {showBriefingHint && (
          <div className="mb-1.5 px-1 text-xs text-ink-faint">
            <span className="font-mono text-primary">/briefing [Empresa]</span> — trae un informe
            del estado del negocio desde HubSpot
          </div>
        )}

        <form
          onSubmit={handleSubmit}
          className={clsx(
            // The box you write in is a box on a form: squared, ruled, flat.
            'rounded-card border transition-colors',
            focused
              ? 'border-primary bg-surface ring-1 ring-primary/20'
              : 'border-border bg-surface',
          )}
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Pregunta por una llamada, una placa o una rutina; o programa una…"
            disabled={disabled}
            rows={1}
            className="scroll-slim block max-h-[200px] min-h-[24px] w-full resize-none bg-transparent px-4 pt-3.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none disabled:opacity-50"
          />

          <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
            {/* Agent pill */}
            {pillDisabled ? (
              <span
                title="Empieza un chat nuevo para cambiar de agente"
                className="inline-flex items-center gap-1.5 rounded-card bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink-faint"
              >
                <Bot className="h-3.5 w-3.5" />
                {activeAgent?.name ?? 'Agente'}
              </span>
            ) : (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-card border border-border px-2.5 py-1.5 text-xs font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
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
                    // A menu genuinely floats over the page, so this is one of
                    // the few places elevation is earned.
                    className="z-50 min-w-[240px] rounded-card border border-border bg-surface p-1.5 shadow-pop"
                  >
                    {agents.map((a) => (
                      <DropdownMenu.Item
                        key={a.slug}
                        onSelect={() => onAgentChange(a.slug)}
                        className="flex cursor-pointer flex-col gap-0.5 rounded-card px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-surface-2"
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
                className="grid h-8 w-8 place-items-center rounded-card bg-primary text-white transition-colors hover:bg-primary-strong disabled:opacity-40"
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
            </div>
          </div>
        </form>
        <p className="mt-1.5 text-center text-[11px] text-ink-faint">
          Cada respuesta trae su fuente: revísala antes de actuar.
        </p>
      </div>
    </div>
  );
}
