'use client';

import { clsx } from 'clsx';
import { ArrowUp, CornerDownLeft, Loader2, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import type { DesignQuestions } from '../useDesigner';

/**
 * LA CAJA DE CORTEX DEL ESTUDIO: FLOTA SOBRE EL LIENZO.
 *
 * En reposo es una píldora con «Pídele a Cortex… ⌘K»: no le quita alto al
 * lienzo y siempre está a mano. Con el foco (⌘K, «/» o un clic) se abre hacia
 * arriba con frases sugeridas que salen de ESTA vista (`studioSuggestions`:
 * sus tablas y campos, lo que le falta), que se mandan con un clic o con las
 * flechas y Enter. Lo que Cortex responde —el resumen del cambio, sus
 * preguntas cuando la frase no le alcanzó, un error— aparece encima.
 *
 * La frase cambia el BORRADOR del estudio, no la vista guardada: se deshace
 * con ⌘Z como cualquier cambio a mano.
 */
export function CommandBar({
  value,
  onChange,
  onSubmit,
  busy,
  error,
  questions,
  note,
  onDismissNote,
  suggestions,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (text?: string) => void;
  busy: boolean;
  error: string | null;
  questions: DesignQuestions | null;
  /** Lo que Cortex dijo del último cambio. */
  note: string | null;
  /** Cierra el resumen, las preguntas o el error. */
  onDismissNote: () => void;
  suggestions: string[];
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const open = focused && !busy;
  const shown = open && !value.trim() ? suggestions : [];

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-3 z-30 flex justify-center px-3 lg:bottom-5">
      <div
        className="pointer-events-auto w-full max-w-2xl"
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            setFocused(false);
            setActive(-1);
          }
        }}
      >
        {(error || questions || (note && !focused)) && (
          <div
            aria-live="polite"
            className={clsx(
              'mb-2 flex items-start gap-2 rounded-card border bg-surface px-4 py-3 text-sm shadow-pop',
              error ? 'border-rose/40 text-rose' : 'border-border text-ink',
            )}
          >
            {!error && !questions && (
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
            )}
            <div className="min-w-0 flex-1">
              {error ??
                (questions ? (
                  <>
                    <p className="text-ink-muted">{questions.explanation}</p>
                    <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                      {questions.items.map((q) => (
                        <li key={q}>{q}</li>
                      ))}
                    </ul>
                  </>
                ) : (
                  <p className="line-clamp-3 leading-relaxed">{note}</p>
                ))}
            </div>
            {(note || error || questions) && (
              <button
                type="button"
                onClick={onDismissNote}
                aria-label="Cerrar el aviso de Cortex"
                className="grid h-6 w-6 shrink-0 place-items-center rounded-pill text-ink-faint hover:bg-surface-2 hover:text-ink"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        {shown.length > 0 && (
          <div className="mb-2 overflow-hidden rounded-card border border-border bg-surface shadow-pop">
            <p className="field-label px-4 pb-1 pt-3">Sugerencias para esta vista</p>
            <ul id="cortex-sugerencias" aria-label="Sugerencias para esta vista" className="pb-1.5">
              {shown.map((s, i) => (
                <li key={s}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onSubmit(s)}
                    onMouseEnter={() => setActive(i)}
                    className={clsx(
                      'flex w-full items-center gap-2.5 px-4 py-2 text-left text-sm transition-colors duration-100',
                      active === i ? 'bg-primary-soft text-ink' : 'text-ink-muted hover:text-ink',
                    )}
                  >
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{s}</span>
                    {active === i && (
                      <CornerDownLeft className="h-3.5 w-3.5 shrink-0 text-ink-faint" aria-hidden />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className={clsx(
            'flex items-end gap-2 rounded-card border bg-surface/95 p-1.5 shadow-pop backdrop-blur-md transition-colors duration-150',
            focused ? 'border-primary/60' : 'border-border-strong',
          )}
        >
          {busy ? (
            <Loader2
              className="mb-2.5 ml-2.5 h-4 w-4 shrink-0 animate-spin text-primary"
              aria-hidden
            />
          ) : (
            <Sparkles className="mb-2.5 ml-2.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          )}
          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            aria-label="Pídele un cambio a Cortex"
            aria-controls={shown.length ? 'cortex-sugerencias' : undefined}
            onChange={(e) => {
              onChange(e.target.value);
              setActive(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && shown.length) {
                e.preventDefault();
                setActive((a) => (a + 1) % shown.length);
              } else if (e.key === 'ArrowUp' && shown.length) {
                e.preventDefault();
                setActive((a) => (a <= 0 ? shown.length - 1 : a - 1));
              } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                const pick = shown[active];
                onSubmit(pick);
              } else if (e.key === 'Escape') {
                e.currentTarget.blur();
              }
            }}
            maxLength={4000}
            disabled={busy}
            placeholder={busy ? 'Cortex está armando el cambio…' : 'Pídele un cambio a Cortex…'}
            className="max-h-36 min-h-[2.25rem] flex-1 resize-none bg-transparent px-1 py-2 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
          {!focused && !value && (
            <kbd className="mb-2 hidden shrink-0 rounded-sm border border-border bg-surface-2 px-1.5 font-mono text-micro text-ink-faint sm:block">
              ⌘K
            </kbd>
          )}
          <button
            type="submit"
            disabled={busy || value.trim().length < 4}
            aria-label="Enviar a Cortex"
            className="cortex-primary-button grid h-9 w-9 shrink-0 place-items-center rounded-pill bg-primary text-white transition-all duration-150 hover:bg-primary-strong disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </form>
      </div>
    </div>
  );
}
