'use client';

import {
  type ArtifactMeta,
  askMorePrompt,
  csvFileName,
  saveAsViewPrompt,
  toCsv,
} from '@/lib/chat-artifact';
import * as Dialog from '@radix-ui/react-dialog';
import { clsx } from 'clsx';
import { BookmarkPlus, Download, MessageSquareText, PanelRightOpen, X } from 'lucide-react';
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { useChatCompose } from './ChatCompose';

/**
 * «LO QUE CORTEX ARMÓ»: EL PANEL DERECHO DEL CHAT.
 *
 * El resultado sigue dibujándose en la conversación, exactamente como antes
 * (`ArtifactFrame` sólo le añade una fila con «Abrir al lado»). Abrirlo lo
 * monta a tamaño completo en una hoja a la derecha —en el teléfono, una hoja
 * desde abajo— con las tres cosas que sí existen hoy: dejar «Guarda esto como
 * vista» escrito en el chat, bajar la tabla en CSV (que Excel abre) y seguir
 * preguntando sobre ello. Nada de eso inventa un protocolo: las dos primeras
 * son texto en el compositor y la tercera un archivo local.
 *
 * Sin proveedor (el showcase, una prueba), `ArtifactFrame` no dibuja la fila y
 * el resultado queda como siempre.
 */

export interface ChatArtifact extends ArtifactMeta {
  id: string;
  /** Vuelve a pintar el mismo resultado. Se llama en el panel, no en la conversación. */
  render: () => ReactNode;
}

interface ArtifactsApi {
  current: ChatArtifact | null;
  open: (artifact: ChatArtifact) => void;
  close: () => void;
}

const ArtifactsContext = createContext<ArtifactsApi | null>(null);

export function ChatArtifactsProvider({
  children,
  initial = null,
}: { children: ReactNode; initial?: ChatArtifact | null }) {
  const [current, setCurrent] = useState<ChatArtifact | null>(initial);
  const open = useCallback((artifact: ChatArtifact) => setCurrent(artifact), []);
  const close = useCallback(() => setCurrent(null), []);
  const value = useMemo(() => ({ current, open, close }), [current, open, close]);
  return <ArtifactsContext.Provider value={value}>{children}</ArtifactsContext.Provider>;
}

export function useChatArtifacts(): ArtifactsApi | null {
  return useContext(ArtifactsContext);
}

/** La fila bajo cada resultado que se puede abrir al lado. */
export function ArtifactFrame({
  artifact,
  children,
}: { artifact: ChatArtifact; children: ReactNode }) {
  const api = useChatArtifacts();
  if (!api) return <>{children}</>;
  const isOpen = api.current?.id === artifact.id;
  return (
    <div>
      {children}
      <div className="mt-1.5 flex justify-end">
        <button
          type="button"
          onClick={() => (isOpen ? api.close() : api.open(artifact))}
          aria-pressed={isOpen}
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-pill px-3 py-1 text-xs font-medium transition-colors duration-150 motion-reduce:transition-none',
            isOpen
              ? 'bg-primary-soft text-primary-ink'
              : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
          )}
        >
          <PanelRightOpen className="h-3.5 w-3.5" aria-hidden />
          {isOpen ? 'Abierto al lado' : 'Abrir al lado'}
        </button>
      </div>
    </div>
  );
}

const DESKTOP = '(min-width: 1024px)';

function useDesktop(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const mq = window.matchMedia(DESKTOP);
      mq.addEventListener('change', notify);
      return () => mq.removeEventListener('change', notify);
    },
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );
}

function downloadCsv(artifact: ChatArtifact) {
  if (!artifact.csv) return;
  const blob = new Blob([toCsv(artifact.csv)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = csvFileName(artifact.title);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const secondary =
  'inline-flex items-center gap-1.5 rounded-pill bg-surface-2 px-3.5 py-1.5 text-xs font-semibold text-ink transition-colors duration-150 hover:bg-border motion-reduce:transition-none';

function PanelBody({
  artifact,
  onClose,
  sheet,
}: { artifact: ChatArtifact; onClose: () => void; sheet?: boolean }) {
  const Title = sheet ? Dialog.Title : 'h2';
  const compose = useChatCompose();
  return (
    <>
      <div className="flex min-h-[3.5rem] shrink-0 items-center gap-2 border-b border-border px-4">
        <Title className="min-w-0 flex-1 truncate font-display text-lg text-ink">
          {artifact.title}
        </Title>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar panel"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink motion-reduce:transition-none"
        >
          <X className="h-4 w-4" aria-hidden />
        </button>
      </div>
      <div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-4">{artifact.render()}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={() => compose?.compose(saveAsViewPrompt(artifact.title))}
          className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-3.5 py-1.5 text-xs font-semibold text-white shadow-card transition-colors duration-150 hover:bg-primary-strong motion-reduce:transition-none"
        >
          <BookmarkPlus className="h-3.5 w-3.5" aria-hidden />
          Guardar como vista
        </button>
        {artifact.csv && (
          <button type="button" onClick={() => downloadCsv(artifact)} className={secondary}>
            <Download className="h-3.5 w-3.5" aria-hidden />
            Descargar (Excel/CSV)
          </button>
        )}
        <button
          type="button"
          onClick={() => compose?.compose(askMorePrompt(artifact.title))}
          className={secondary}
        >
          <MessageSquareText className="h-3.5 w-3.5" aria-hidden />
          Pregúntale más
        </button>
      </div>
    </>
  );
}

/** El panel mismo. Escritorio: hoja a la derecha. Teléfono y tableta: hoja desde abajo. */
export function ArtifactPanel() {
  const api = useChatArtifacts();
  const desktop = useDesktop();
  const current = api?.current ?? null;
  if (!api || !current) return null;

  if (desktop) {
    return (
      <aside
        aria-label="Lo que Cortex armó"
        className="animate-rise hidden min-h-0 w-[min(30rem,38%)] shrink-0 flex-col overflow-hidden rounded-[18px] bg-surface shadow-sheet lg:flex"
      >
        <PanelBody artifact={current} onClose={api.close} />
      </aside>
    );
  }

  return (
    <Dialog.Root open onOpenChange={(open) => !open && api.close()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] animate-veil bg-ink/40 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="cortex-workspace fixed inset-x-0 bottom-0 z-[61] flex max-h-[88dvh] flex-col overflow-hidden rounded-t-[22px] bg-surface pb-[env(safe-area-inset-bottom)] shadow-pop focus:outline-none"
        >
          <PanelBody artifact={current} onClose={api.close} sheet />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
