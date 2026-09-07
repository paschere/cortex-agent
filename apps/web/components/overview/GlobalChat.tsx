'use client';

import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { VoiceDictation } from '@/components/chat/VoiceDictation';
import { VoiceMode } from '@/components/chat/VoiceMode';
import type { Workspace, WorkspaceListPayload } from '@/lib/workspace-switch';
import {
  Brain,
  Check,
  CheckCheck,
  Copy,
  Download,
  FileText,
  Loader2,
  Mic,
  Paperclip,
  Send,
  ShieldCheck,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { GlobalActionCards } from './GlobalActionCards';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
}
interface GlobalAttachment {
  id: string;
  filename: string;
  mime: string;
  byteSize: number;
  truncated: boolean;
  createdAt: string;
  expiresAt: string;
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
  const conversationRef = useRef<string | undefined>(undefined);
  const selectedRef = useRef<string[]>([]);
  const turnLocked = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const latestRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const [history, setHistory] = useState<Array<{ id: string; title: string }>>([]);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dictating, setDictating] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<GlobalAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    conversationRef.current = conversationId;
  }, [conversationId]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  useEffect(() => {
    void input;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = '0px';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 144)}px`;
  }, [input]);
  useEffect(() => {
    void messages;
    void error;
    if (nearBottomRef.current)
      latestRef.current?.scrollIntoView({ block: 'end', behavior: sending ? 'smooth' : 'auto' });
    else setShowLatest(true);
  }, [messages, sending, error]);

  const interactionLocked = sending || opening || dictating || voiceOpen || uploading;

  useEffect(() => {
    setAttachments([]);
    if (!conversationId) {
      return;
    }
    const abort = new AbortController();
    void fetch(
      `/api/chat/global/attachments?conversationId=${encodeURIComponent(conversationId)}`,
      { signal: abort.signal },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('No se pudieron abrir los adjuntos.');
        const data = await response.json();
        if (!abort.signal.aborted) setAttachments(data.attachments ?? []);
      })
      .catch((reason) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'No se pudieron abrir los adjuntos.');
      });
    return () => abort.abort();
  }, [conversationId]);

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
    if (interactionLocked) return;
    setOpening(true);
    setAttachments([]);
    setError(null);
    try {
      const response = await fetch(`/api/chat/global?conversationId=${encodeURIComponent(id)}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'No se pudo abrir la conversación.');
      setSelected(data.workspaceIds);
      selectedRef.current = data.workspaceIds;
      setMessages(data.messages);
      setConversationId(data.id);
      conversationRef.current = data.id;
    } catch (reason) {
      setMessages([]);
      setConversationId(undefined);
      conversationRef.current = undefined;
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
    if (interactionLocked) return;
    setSelected(next);
    selectedRef.current = next;
    setMessages([]);
    setAttachments([]);
    setConversationId(undefined);
    conversationRef.current = undefined;
    setError(null);
  }

  const sendMessage = useCallback(
    async (message: string, externalSignal?: AbortSignal) => {
      const cleanMessage = message.trim();
      if (!cleanMessage || turnLocked.current || opening || loadingSpaces)
        throw new Error('Espera a que termine la consulta actual.');
      turnLocked.current = true;
      setSending(true);
      nearBottomRef.current = true;
      setShowLatest(false);
      setError(null);
      setNotice(null);
      const userMessage: Message = { id: crypto.randomUUID(), role: 'user', content: cleanMessage };
      const assistantId = crypto.randomUUID();
      setMessages((current) => [
        ...current,
        userMessage,
        { id: assistantId, role: 'assistant', content: '' },
      ]);
      controller.current = new AbortController();
      const abort = () => controller.current?.abort();
      externalSignal?.addEventListener('abort', abort, { once: true });
      if (externalSignal?.aborted) abort();
      let answer = '';
      try {
        const response = await fetch('/api/chat/global', {
          signal: controller.current.signal,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: conversationRef.current,
            workspaceIds: selectedRef.current,
            message: cleanMessage,
          }),
        });
        if (!response.ok || !response.body) {
          const failure = await response.json().catch(() => ({}));
          throw new Error(failure.error ?? 'Cortex no pudo responder en este momento.');
        }
        const nextConversation =
          response.headers.get('X-Conversation-Id') ?? conversationRef.current;
        setConversationId(nextConversation);
        conversationRef.current = nextConversation;
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
          if (text) {
            answer += text;
            setMessages((current) =>
              current.map((item) =>
                item.id === assistantId ? { ...item, content: item.content + text } : item,
              ),
            );
          }
        }
        pending += decoder.decode();
        const tail = decodeChunk(pending);
        if (tail) {
          answer += tail;
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantId ? { ...item, content: item.content + tail } : item,
            ),
          );
        }
        return answer;
      } catch (reason) {
        const stopped = reason instanceof DOMException && reason.name === 'AbortError';
        setMessages((current) =>
          current.filter((item) => item.id !== assistantId || item.content.length > 0),
        );
        if (stopped) setNotice('Consulta detenida. Puedes editarla y volver a enviarla.');
        else setError(reason instanceof Error ? reason.message : 'Cortex no pudo responder.');
        throw reason;
      } finally {
        externalSignal?.removeEventListener('abort', abort);
        controller.current = null;
        turnLocked.current = false;
        setSending(false);
      }
    },
    [loadingSpaces, opening],
  );

  async function send() {
    const message = input.trim();
    if (!message || interactionLocked || loadingSpaces) return;
    setInput('');
    try {
      await sendMessage(message);
    } catch {
      setInput((current) => current || message);
    }
  }

  async function copyAnswer(message: Message) {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopiedId(message.id);
      window.setTimeout(
        () => setCopiedId((current) => (current === message.id ? null : current)),
        1800,
      );
    } catch {
      setError('No se pudo copiar. Revisa el permiso del portapapeles del navegador.');
    }
  }

  function exportConversation() {
    if (!messages.length) return;
    const scope = spaces
      .filter((space) => selected.includes(space.id))
      .map((space) => space.name)
      .join(', ');
    const body = messages
      .map((message) => `## ${message.role === 'user' ? 'Tú' : 'Cortex'}\n\n${message.content}`)
      .join('\n\n');
    const blob = new Blob(
      [`# Consulta global\n\nAlcance: ${scope || 'Sin espacios'}\n\n${body}\n`],
      {
        type: 'text/markdown;charset=utf-8',
      },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `consulta-global-${new Date().toISOString().slice(0, 10)}.md`;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function uploadAttachment(file: File) {
    if (interactionLocked || attachments.length >= 2) return;
    if (file.size === 0 || file.size > 4 * 1024 * 1024) {
      setError('El archivo debe pesar entre 1 byte y 4 MB.');
      return;
    }
    setUploading(true);
    setError(null);
    setNotice(null);
    try {
      const form = new FormData();
      form.set('file', file);
      if (conversationRef.current) form.set('conversationId', conversationRef.current);
      else form.set('workspaceIds', JSON.stringify(selectedRef.current));
      const response = await fetch('/api/chat/global/attachments', { method: 'POST', body: form });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'No se pudo adjuntar el archivo.');
      conversationRef.current = data.conversationId;
      setConversationId(data.conversationId);
      setAttachments((current) => [...current, data.attachment]);
      setNotice(
        `${data.attachment.filename} estará disponible en esta conversación durante 7 días.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo adjuntar el archivo.');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function removeAttachment(attachment: GlobalAttachment) {
    const id = conversationRef.current;
    if (!id || interactionLocked) return;
    setUploading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/chat/global/attachments?conversationId=${encodeURIComponent(id)}&attachmentId=${encodeURIComponent(attachment.id)}`,
        { method: 'DELETE' },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'No se pudo retirar el adjunto.');
      setAttachments((current) => current.filter((item) => item.id !== attachment.id));
      setNotice(
        `${attachment.filename} fue retirado. Las respuestas ya generadas permanecen en el historial.`,
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo retirar el adjunto.');
    } finally {
      setUploading(false);
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
                disabled={interactionLocked}
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
            disabled={interactionLocked}
            onClick={() => select(spaces.map((space) => space.id))}
            className="text-xs font-semibold text-violet-300 hover:text-violet-200"
          >
            Seleccionar todos
          </button>
          <span className="text-zinc-700">/</span>
          <button
            type="button"
            disabled={interactionLocked}
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
              disabled={interactionLocked}
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
                disabled={interactionLocked}
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
            <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
              <select
                aria-label="Abrir conversación reciente"
                disabled={interactionLocked}
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
              <button
                type="button"
                disabled={!messages.length || interactionLocked}
                onClick={exportConversation}
                aria-label="Exportar conversación en Markdown"
                title="Exportar conversación"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-zinc-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
              >
                <Download className="h-4 w-4" />
              </button>
              <button
                type="button"
                disabled={sending || opening || dictating || loadingSpaces}
                onClick={() => setVoiceOpen(true)}
                aria-label="Abrir conversación por voz"
                title="Conversar por voz"
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-violet-300/20 bg-violet-300/10 text-violet-200 transition-colors hover:bg-violet-300/15 disabled:opacity-30"
              >
                <Mic className="h-4 w-4" />
              </button>
              <Brain className="h-5 w-5 shrink-0 text-violet-300" />
            </div>
          </div>
        </header>
        <div
          ref={scrollAreaRef}
          onScroll={(event) => {
            const area = event.currentTarget;
            nearBottomRef.current = area.scrollHeight - area.scrollTop - area.clientHeight < 96;
            if (nearBottomRef.current) setShowLatest(false);
          }}
          className="scroll-slim relative flex-1 overflow-y-auto px-4 py-6 md:px-8"
        >
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
              <div key={message.id} className={message.role === 'assistant' ? 'group' : ''}>
                <div
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
                {message.role === 'assistant' && message.content && (
                  <button
                    type="button"
                    onClick={() => void copyAnswer(message)}
                    className="mt-1 inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] text-zinc-600 transition-colors hover:bg-white/5 hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                    aria-label="Copiar respuesta de Cortex"
                  >
                    {copiedId === message.id ? (
                      <CheckCheck className="h-3.5 w-3.5" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                    {copiedId === message.id ? 'Copiada' : 'Copiar'}
                  </button>
                )}
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
            {notice && (
              <output className="rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-zinc-400">
                {notice}
              </output>
            )}
            <div ref={latestRef} tabIndex={-1} aria-label="Fin de la conversación" />
          </div>
          {showLatest && (
            <button
              type="button"
              onClick={() => {
                nearBottomRef.current = true;
                setShowLatest(false);
                latestRef.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
                latestRef.current?.focus({ preventScroll: true });
              }}
              className="sticky bottom-2 mx-auto mt-3 flex min-h-9 items-center rounded-full border border-white/10 bg-[#201e26] px-3 text-xs font-medium text-zinc-300 shadow-xl"
            >
              Ir a lo más reciente
            </button>
          )}
        </div>
        <div className="border-t border-white/10 bg-[#17161c] px-4 py-4 md:px-8">
          <div className="mx-auto max-w-3xl">
            {attachments.length > 0 && (
              <div className="mb-2 flex min-w-0 flex-wrap gap-2" aria-label="Adjuntos temporales">
                {attachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-white/10 bg-white/5 py-1.5 pl-2.5 pr-1.5 text-xs text-zinc-300"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                    <span className="max-w-48 truncate">{attachment.filename}</span>
                    {attachment.truncated && (
                      <span className="shrink-0 text-[10px] text-amber-300">parcial</span>
                    )}
                    <button
                      type="button"
                      disabled={interactionLocked}
                      onClick={() => void removeAttachment(attachment)}
                      aria-label={`Retirar ${attachment.filename}`}
                      className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-zinc-500 hover:bg-white/5 hover:text-white disabled:opacity-30"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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
                ref={textareaRef}
                id="global-message"
                rows={1}
                maxLength={12000}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    void send();
                  }
                }}
                placeholder={
                  selected.length
                    ? 'Consulta los espacios seleccionados…'
                    : 'Conversación general, sin datos de espacios…'
                }
                className="max-h-36 min-h-10 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent px-2 py-2 text-sm text-white outline-none placeholder:text-zinc-600"
              />
              <VoiceDictation
                disabled={sending || opening || voiceOpen || uploading || loadingSpaces}
                hideUnsupported
                ariaLabel="Dictar mensaje"
                getBaseText={() => input}
                onText={setInput}
                onListeningChange={setDictating}
              />
              <input
                ref={fileRef}
                type="file"
                className="sr-only"
                accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown"
                aria-label="Seleccionar archivo temporal"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadAttachment(file);
                }}
              />
              <button
                type="button"
                disabled={interactionLocked || attachments.length >= 2}
                onClick={() => fileRef.current?.click()}
                aria-label={
                  attachments.length >= 2
                    ? 'Máximo de dos adjuntos alcanzado'
                    : 'Adjuntar archivo temporal'
                }
                title="Adjuntar PDF, DOCX, TXT o MD"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-zinc-400 transition-colors hover:bg-white/5 hover:text-white disabled:opacity-30"
              >
                {uploading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Paperclip className="h-4 w-4" />
                )}
              </button>
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
                disabled={!input.trim() || interactionLocked || loadingSpaces}
                aria-label="Enviar"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-violet-300 text-[#17151d] disabled:opacity-30"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
            <p className="mt-2 text-center text-[10px] text-zinc-600">
              El alcance queda guardado con esta conversación. Este chat no se añade a ningún
              cerebro. Puedes adjuntar hasta 2 archivos PDF, DOCX, TXT o MD de 4 MB; dejan de estar
              disponibles a los 7 días.
            </p>
          </div>
        </div>
      </main>
      {voiceOpen && (
        <VoiceMode
          onClose={() => setVoiceOpen(false)}
          history={messages.slice(-10).map((message) => ({
            role: message.role === 'user' ? 'you' : 'cortex',
            text: message.content,
            id: message.id,
          }))}
          realtimeEndpoint="/api/chat/global/realtime"
          workspaceIds={selected}
          scopeLabel={
            selected.length
              ? spaces
                  .filter((space) => selected.includes(space.id))
                  .map((space) => space.name)
                  .join(', ')
              : 'Sin espacios'
          }
          consult={(question, signal) => sendMessage(question, signal)}
          onCompose={(voiceText) =>
            setInput((current) => [current, voiceText].filter(Boolean).join('\n\n'))
          }
          allowLegacy={false}
        />
      )}
    </div>
  );
}
