'use client';

import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import type { Workspace, WorkspaceListPayload } from '@/lib/workspace-switch';
import { Brain, Check, Loader2, Send, ShieldCheck } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { GlobalActionCards } from './GlobalActionCards';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}

function decodeChunk(line: string): string {
  const clean = line.trim();
  if (clean.startsWith('3:')) throw new Error(String(JSON.parse(clean.slice(2))));
  if (!clean.startsWith('0:')) return '';
  const value: unknown = JSON.parse(clean.slice(2));
  return typeof value === 'string' ? value : '';
}

function ScopeButton({
  workspace,
  checked,
  onChange,
  disabled,
}: { workspace: Workspace; checked: boolean; onChange: () => void; disabled: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={checked}
      disabled={disabled}
      onClick={onChange}
      className={`flex min-h-10 min-w-44 items-center gap-2 rounded-lg border px-3 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400 md:min-w-0 ${checked ? 'border-violet-400/40 bg-violet-400/10 text-white' : 'border-white/10 text-zinc-400 hover:border-white/20 hover:text-white'}`}
    >
      <span
        className={`grid h-4 w-4 place-items-center rounded border ${checked ? 'border-violet-400 bg-violet-400 text-[#17151d]' : 'border-zinc-600'}`}
      >
        {checked && <Check className="h-3 w-3" strokeWidth={3} />}
      </span>
      <span className="min-w-0">
        <span className="block truncate font-semibold">{workspace.name}</span>
        <span className="block text-[10px] text-zinc-500">
          {workspace.kind === 'personal' ? 'Personal' : 'Empresa'}
        </span>
      </span>
    </button>
  );
}

export function GlobalChat() {
  const [spaces, setSpaces] = useState<Workspace[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [input, setInput] = useState('');
  const [loadingSpaces, setLoadingSpaces] = useState(true);
  const [sending, setSending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [history, setHistory] = useState<Array<{ id: string; title: string }>>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (sending) return;
    void fetch('/api/chat/global')
      .then(async (r) => {
        if (!r.ok) return;
        const data = await r.json();
        setHistory(data.conversations ?? []);
      })
      .catch(() => {});
  }, [sending]);

  async function openConversation(id: string) {
    if (sending || opening) return;
    setOpening(true);
    setError(null);
    try {
      const response = await fetch(`/api/chat/global?conversationId=${encodeURIComponent(id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'No se pudo abrir la conversación.');
      setSelected(data.workspaceIds);
      setMessages(data.messages);
      setConversationId(data.id);
    } catch (reason) {
      setMessages([]);
      setConversationId(undefined);
      setError(reason instanceof Error ? reason.message : 'No se pudo abrir la conversación.');
    } finally {
      setOpening(false);
    }
  }

  useEffect(() => {
    void fetch('/api/organizations')
      .then(async (response) => {
        if (!response.ok) throw new Error('No se pudieron cargar tus espacios.');
        return response.json() as Promise<WorkspaceListPayload>;
      })
      .then((data) => setSpaces(data.workspaces))
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoadingSpaces(false));
  }, []);

  const selectionLabel = useMemo(
    () =>
      selected.length === 0
        ? 'Sin espacios'
        : selected.length === spaces.length
          ? 'Todos tus espacios'
          : `${selected.length} ${selected.length === 1 ? 'espacio' : 'espacios'}`,
    [selected.length, spaces.length],
  );

  function select(next: string[]) {
    if (sending || opening) return;
    setSelected(next);
    setMessages([]);
    setConversationId(undefined);
    setError(null);
  }

  async function send() {
    const message = input.trim();
    if (!message || sending || opening || loadingSpaces) return;
    setInput('');
    setSending(true);
    setError(null);
    const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: message };
    const assistantId = crypto.randomUUID();
    setMessages((current) => [
      ...current,
      userMessage,
      { id: assistantId, role: 'assistant', content: '' },
    ]);
    controller.current = new AbortController();
    try {
      const response = await fetch('/api/chat/global', {
        signal: controller.current.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, workspaceIds: selected, message }),
      });
      if (!response.ok || !response.body) {
        const failure = await response.json().catch(() => ({}));
        throw new Error(failure.error ?? 'Cortex no pudo responder en este momento.');
      }
      setConversationId(response.headers.get('X-Conversation-Id') ?? conversationId);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        const text = lines.map(decodeChunk).join('');
        if (text)
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId ? { ...item, content: item.content + text } : item,
            ),
          );
      }
      const tail = decodeChunk(pending);
      if (tail)
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantId ? { ...item, content: item.content + tail } : item,
          ),
        );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Cortex no pudo responder.');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col bg-[#111015] text-zinc-100 md:flex-row">
      <aside className="w-full min-w-0 max-w-full shrink-0 border-b border-white/10 bg-[#17161c] px-4 py-3 md:w-72 md:border-b-0 md:border-r md:p-5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-violet-300" />
          <h2 className="text-sm font-semibold">Alcance de esta conversación</h2>
        </div>
        <p className="mt-2 hidden text-xs leading-relaxed text-zinc-500 md:block">
          Cambiar la selección inicia un chat limpio. Este historial es privado y no se añade a los
          cerebros.
        </p>
        <div className="scroll-slim mt-3 flex w-full min-w-0 gap-2 overflow-x-auto pb-1 md:mt-5 md:grid md:overflow-visible md:pb-0">
          {loadingSpaces ? (
            <div className="flex items-center gap-2 py-3 text-xs text-zinc-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Cargando espacios
            </div>
          ) : (
            spaces.map((workspace) => (
              <ScopeButton
                key={workspace.id}
                workspace={workspace}
                disabled={sending || opening}
                checked={selected.includes(workspace.id)}
                onChange={() =>
                  select(
                    selected.includes(workspace.id)
                      ? selected.filter((id) => id !== workspace.id)
                      : [...selected, workspace.id],
                  )
                }
              />
            ))
          )}
        </div>
        <div className="mt-2 flex gap-2 md:mt-3">
          <button
            type="button"
            disabled={sending || opening}
            onClick={() => select(spaces.map((space) => space.id))}
            className="text-xs font-semibold text-violet-300 hover:text-violet-200"
          >
            Seleccionar todos
          </button>
          <span className="text-zinc-700">/</span>
          <button
            type="button"
            disabled={sending || opening}
            onClick={() => select([])}
            className="text-xs font-semibold text-zinc-500 hover:text-zinc-300"
          >
            Ninguno
          </button>
        </div>
        <div className="mt-6 hidden border-t border-white/10 pt-4 md:block">
          <div className="mb-3 flex items-center justify-between text-xs text-zinc-500">
            <span>Conversaciones recientes</span>
            <button
              type="button"
              disabled={sending || opening}
              onClick={() => select(selected)}
              className="text-violet-300 disabled:opacity-40"
            >
              Nueva
            </button>
          </div>
          <div className="scroll-slim max-h-[35vh] space-y-1 overflow-y-auto">
            {history.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={sending || opening}
                onClick={() => void openConversation(item.id)}
                className={`block w-full truncate rounded-lg px-2 py-2 text-left text-xs hover:bg-white/5 disabled:opacity-40 ${conversationId === item.id ? 'bg-white/5 text-violet-200' : 'text-zinc-400'}`}
              >
                {item.title}
              </button>
            ))}
            {!history.length && (
              <p className="text-xs text-zinc-600">Tus conversaciones aparecerán aquí.</p>
            )}
          </div>
        </div>
      </aside>
      <main aria-busy={sending || opening} className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-white/10 px-5 py-4 md:px-8">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <div>
              <h1 className="text-base font-semibold tracking-tight">Consulta global</h1>
              <p className="mt-1 text-xs text-zinc-500">{selectionLabel}</p>
            </div>
            <div className="flex min-w-0 items-center gap-3">
              <select
                aria-label="Abrir conversación reciente"
                disabled={sending || opening}
                value={conversationId ?? ''}
                onChange={(event) =>
                  event.target.value ? void openConversation(event.target.value) : select(selected)
                }
                className="max-w-36 rounded-lg border border-white/10 bg-[#17161c] px-2 py-2 text-xs text-zinc-300 md:hidden"
              >
                <option value="">Nueva conversación</option>
                {history.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
              </select>
              <Brain className="h-5 w-5 shrink-0 text-violet-300" />
            </div>
          </div>
        </header>
        <div className="scroll-slim flex-1 overflow-y-auto px-4 py-6 md:px-8">
          <div className="mx-auto max-w-3xl space-y-5">
            {messages.length === 0 && (
              <div className="pt-[12vh]">
                <p className="max-w-lg text-2xl font-medium tracking-[-0.025em] text-white">
                  Pregunta con el alcance a la vista.
                </p>
                <p className="mt-3 max-w-md text-sm leading-relaxed text-zinc-500">
                  Consulta cerebros y trabajo pendiente de empresas autorizadas, o deja la selección
                  vacía para conversar sin datos ni herramientas. Cortex puede preparar acciones por
                  empresa. Revisa el destino y los datos de cada propuesta antes de aprobar su
                  ejecución.
                </p>
              </div>
            )}
            {messages.map((message) => (
              <div
                key={message.id}
                className={
                  message.role === 'user'
                    ? 'ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-white px-4 py-3 text-sm text-zinc-900'
                    : 'max-w-2xl whitespace-pre-wrap text-sm leading-7 text-zinc-200'
                }
              >
                {(message.content ? (
                  message.role === 'assistant' ? (
                    <ChatMarkdown
                      content={message.content}
                      isStreaming={sending}
                      className="prose-invert !text-zinc-200"
                    />
                  ) : (
                    message.content
                  )
                ) : null) ||
                  (sending && message.role === 'assistant' ? (
                    <Loader2 className="h-4 w-4 animate-spin text-violet-300" />
                  ) : null)}
              </div>
            ))}
            <GlobalActionCards
              conversationId={conversationId}
              refreshKey={sending}
              spaces={spaces}
            />
            {error && (
              <p
                role="alert"
                className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200"
              >
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="border-t border-white/10 bg-[#17161c] px-4 py-4 md:px-8">
          <div className="mx-auto max-w-3xl">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void send();
              }}
              className="flex items-end gap-2 rounded-2xl border border-white/10 bg-[#201e26] p-2 focus-within:border-violet-400/50"
            >
              <label className="sr-only" htmlFor="global-message">
                Mensaje
              </label>
              <textarea
                id="global-message"
                rows={1}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  selected.length
                    ? 'Consulta los espacios seleccionados…'
                    : 'Conversación general, sin datos de espacios…'
                }
                className="max-h-36 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-white outline-none placeholder:text-zinc-600"
              />
              {sending && (
                <button
                  type="button"
                  onClick={() => controller.current?.abort()}
                  className="px-2 py-3 text-xs text-zinc-400"
                >
                  Detener
                </button>
              )}
              <button
                type="submit"
                disabled={!input.trim() || sending || opening || loadingSpaces}
                aria-label="Enviar"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-300 text-[#17151d] disabled:opacity-30"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
            <p className="mt-2 text-center text-[10px] text-zinc-600">
              El alcance queda guardado con esta conversación. Este chat no se añade a ningún
              cerebro.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
