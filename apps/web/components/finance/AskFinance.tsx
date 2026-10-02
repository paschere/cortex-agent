'use client';

import { QUICK_PROMPTS, chatHref, promptWithContext } from '@/lib/finance/dashboard-shape';
import { ArrowRight, Sparkles } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * «CÁMBIALO CON CORTEX»: el panel no tiene botones para todo; lo que falta se
 * pide hablando. Es el mismo formulario GET a /chat que el de Inicio (funciona
 * sin JavaScript); con JavaScript, la pregunta viaja con una línea de contexto
 * —la caja de hoy, la semana más baja, el escenario abierto— para que Cortex
 * no tenga que volver a preguntarlo.
 */
export function AskFinance({ chat, context }: { chat: string; context: string }) {
  const router = useRouter();
  const [value, setValue] = useState('');
  const url = new URL(chat, 'https://cortex.invalid');
  // Sin JavaScript, el formulario GET pierde la consulta de `action`: lo que
  // ya traía la dirección (la empresa activa) viaja en campos ocultos.
  const carried = [...url.searchParams.entries()].filter(([k]) => k !== 'prompt');
  return (
    <div className="flex flex-col gap-3">
      <form
        action={url.pathname}
        method="get"
        onSubmit={(e) => {
          if (!value.trim()) return;
          e.preventDefault();
          router.push(chatHref(chat, promptWithContext(value, context)));
        }}
        className="flex items-center gap-2 rounded-[1.25rem] border-2 border-primary bg-surface py-1.5 pl-4 pr-1.5 shadow-pop focus-within:ring-4 focus-within:ring-primary/15"
      >
        {carried.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <Sparkles className="h-5 w-5 shrink-0 text-primary" aria-hidden />
        <label htmlFor="ask-finance" className="sr-only">
          Cámbialo con Cortex
        </label>
        <input
          id="ask-finance"
          name="prompt"
          type="text"
          autoComplete="off"
          required
          maxLength={2000}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Cámbialo con Cortex: «agrega una columna», «¿y si contrato a dos?»…"
          className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm font-medium text-ink outline-none placeholder:text-ink-faint sm:text-base"
        />
        <button
          type="submit"
          className="cortex-primary-button inline-flex h-10 shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 text-sm font-bold text-white transition-colors hover:bg-primary-strong"
        >
          <span className="hidden sm:inline">Preguntar</span>
          <ArrowRight className="h-4 w-4" aria-hidden />
        </button>
      </form>
      <ul className="flex flex-wrap gap-2" aria-label="Preguntas rápidas">
        {QUICK_PROMPTS.map((q) => (
          <li key={q}>
            <Link
              href={chatHref(chat, promptWithContext(q, context))}
              className="inline-flex min-h-9 items-center rounded-pill border border-border bg-surface px-3.5 py-1.5 text-xs font-semibold text-ink-muted shadow-card transition-colors hover:border-primary/30 hover:bg-primary-soft hover:text-primary-ink"
            >
              {q}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
