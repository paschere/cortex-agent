'use client';

import { clsx } from 'clsx';
import { ArrowUp, Loader2, Sparkles } from 'lucide-react';
import type { DesignQuestions } from './useDesigner';

/**
 * LA CAJA DE ABAJO: «PÍDELE UN CAMBIO A CORTEX».
 *
 * Pegada al fondo del área que hace scroll, no `fixed`: así respeta el ancho
 * del rail y del panel lateral sin saber cuánto miden. Encima muestra el error
 * o las preguntas de Cortex cuando la frase no le alcanzó.
 */
export function PromptBar({
  value,
  onChange,
  onSubmit,
  busy,
  placeholder,
  error,
  questions,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  placeholder: string;
  error: string | null;
  questions: DesignQuestions | null;
  inputRef?: React.Ref<HTMLTextAreaElement>;
}) {
  return (
    <div className="sticky bottom-0 z-30 mt-6 pb-[max(env(safe-area-inset-bottom),0.75rem)]">
      <div className="mx-auto w-full max-w-3xl">
        {(error || questions) && (
          <div
            aria-live="polite"
            className={clsx(
              'mb-2 rounded-card border px-4 py-3 text-sm shadow-pop',
              error ? 'border-rose/40 bg-surface text-rose' : 'border-border bg-surface text-ink',
            )}
          >
            {error ?? (
              <>
                <p className="text-ink-muted">{questions?.explanation}</p>
                <ul className="mt-1.5 list-disc space-y-0.5 pl-5">
                  {questions?.items.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex items-end gap-2 rounded-card border border-border-strong bg-surface p-2 shadow-pop"
        >
          <Sparkles className="mb-2.5 ml-2 h-4 w-4 shrink-0 text-primary" aria-hidden />
          <textarea
            ref={inputRef}
            rows={1}
            value={value}
            aria-label="Pídele un cambio a Cortex"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSubmit();
              }
            }}
            maxLength={4000}
            placeholder={placeholder}
            className="max-h-40 min-h-[2.5rem] flex-1 resize-none bg-transparent px-1 py-2 text-sm text-ink outline-none placeholder:text-ink-faint"
          />
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
