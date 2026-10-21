'use client';

import { useChatCompose } from '@/components/chat/ChatCompose';
import { appCanFixAction, reportAppProblemAction } from '@/lib/apps/write-actions';
import { buildFixPrompt, chatHrefWith } from '@/lib/block-fix';
import { clsx } from 'clsx';
import { BellRing, Check, Loader2, Sparkles } from 'lucide-react';
import { createContext, useContext, useEffect, useState } from 'react';

/**
 * «ARREGLAR CON CORTEX» EN TODO AVISO DE BLOQUE ROTO.
 *
 * Quien puede editar la app ve un botón que abre el chat con el contexto ya
 * cargado (app, pantalla, bloque, el mensaje tal cual) y la instrucción de
 * diagnosticar y proponer; lo que Cortex cambie pasa por confirmación como
 * siempre. Quien no puede editar ve «Avisar al administrador», que manda un
 * aviso con el mismo contexto. Dentro del chat (hay compositor) la instrucción
 * entra al hilo; fuera de él se abre /chat con la instrucción escrita.
 */

export interface BlockFixInfo {
  /** `app`: una pantalla de aplicación (se decide por el servidor quién puede editar). */
  kind: 'app' | 'view';
  appName?: string;
  /** Slug o id con que se llama a la app desde el navegador (target.appId). */
  appRef?: string;
  screenTitle?: string;
  screenSlug?: string;
  viewName?: string;
  /** Ya se sabe que puede editar (el editor de apps, la vista propia). */
  canFix?: boolean;
}

const Ctx = createContext<BlockFixInfo | null>(null);
export const BlockFixProvider = Ctx.Provider;
export const useBlockFix = () => useContext(Ctx);

export function BlockFixActions({
  blockId,
  blockTitle,
  message,
  info: infoProp,
  className,
}: {
  blockId?: string;
  blockTitle?: string;
  message: string;
  /** Para un límite de error que vive fuera del proveedor (error.tsx de una pantalla). */
  info?: BlockFixInfo | null;
  className?: string;
}) {
  const ctx = useBlockFix();
  const info = infoProp ?? ctx;
  const chat = useChatCompose();
  const [can, setCan] = useState<boolean | null>(info?.canFix ?? null);
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [note, setNote] = useState('');

  const appRef = info?.appRef;
  const knownCanFix = info?.canFix;
  const kind = info?.kind;
  useEffect(() => {
    if (knownCanFix !== undefined || kind !== 'app' || !appRef) return;
    let alive = true;
    appCanFixAction(appRef)
      .then((ok) => alive && setCan(ok))
      .catch(() => alive && setCan(false));
    return () => {
      alive = false;
    };
  }, [appRef, knownCanFix, kind]);

  if (!info || can === null) return null;

  const prompt = buildFixPrompt({
    appName: info.appName,
    appRef: info.appRef,
    screenTitle: info.screenTitle,
    screenSlug: info.screenSlug,
    viewName: info.viewName,
    blockId,
    blockTitle,
    message,
  });
  const btn =
    'inline-flex min-h-10 items-center gap-1.5 rounded-pill border border-border-strong bg-surface px-3.5 text-xs font-semibold text-ink transition-colors hover:bg-surface-2 disabled:opacity-60';

  if (can) {
    const cls = clsx(btn, 'border-primary/40 text-primary-ink');
    return (
      <div className={clsx('flex flex-wrap items-center gap-2', className)}>
        {chat ? (
          <button type="button" className={cls} onClick={() => chat.ask(prompt)}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Arreglar con Cortex
          </button>
        ) : (
          // Fuera del chat: un enlace de verdad (se abre en otra pestaña con la instrucción escrita).
          <a href={chatHrefWith(prompt)} target="_blank" rel="noopener noreferrer" className={cls}>
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Arreglar con Cortex
          </a>
        )}
      </div>
    );
  }

  if (info.kind !== 'app' || !appRef) return null;
  return (
    <div className={clsx('flex flex-wrap items-center gap-2', className)}>
      {state === 'done' ? (
        <output className="inline-flex items-center gap-1.5 text-xs font-semibold text-emerald">
          <Check className="h-3.5 w-3.5" aria-hidden /> {note}
        </output>
      ) : (
        <button
          type="button"
          disabled={state === 'busy'}
          className={btn}
          onClick={async () => {
            setState('busy');
            const res = await reportAppProblemAction(
              appRef,
              info.screenSlug ?? null,
              blockId ?? null,
              message,
            ).catch(() => ({ ok: false as const, error: 'Sin conexión. Inténtalo otra vez.' }));
            if (res.ok) {
              setNote(res.message);
              setState('done');
            } else {
              setNote(res.error);
              setState('error');
            }
          }}
        >
          {state === 'busy' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <BellRing className="h-3.5 w-3.5" aria-hidden />
          )}
          Avisar al administrador
        </button>
      )}
      {state === 'error' && (
        <p role="alert" className="text-xs font-semibold text-rose">
          {note}
        </p>
      )}
    </div>
  );
}
