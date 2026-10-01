'use client';

import type { NewTrackerDraft } from '@/lib/views/editor-spec';
import type { ComputedView } from '@cortex/agent-tools';
import { useState } from 'react';

/**
 * PEDIRLE UNA VISTA A CORTEX CON UNA FRASE (POST /api/views/design).
 *
 * Lo usan las dos superficies que tienen la caja «Pídele un cambio a
 * Cortex»: el estudio (crear o cambiar una vista hablando) y el lienzo (donde
 * la frase cambia el borrador que se está editando, no la versión guardada).
 * Devuelve el borrador listo o null; las preguntas y los errores quedan en el
 * estado para que la caja los muestre.
 */

export interface DesignDraft {
  name: string;
  description: string;
  explanation: string;
  spec: unknown;
  newTrackers: NewTrackerDraft[];
}

export interface DesignReady {
  draft: DesignDraft;
  preview: ComputedView;
  baseVersion: number | null;
}

type DesignResponse =
  | ({ status: 'ready' } & DesignReady)
  | { status: 'needs_input'; explanation: string; questions: string[] }
  | { error: string };

export interface DesignQuestions {
  explanation: string;
  items: string[];
}

export function useDesigner(viewId?: string) {
  const [designing, setDesigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [questions, setQuestions] = useState<DesignQuestions | null>(null);

  async function design(
    prompt: string,
    current?: { name: string; description: string; spec: unknown; newTrackers: NewTrackerDraft[] },
  ): Promise<DesignReady | null> {
    const ask = prompt.trim();
    if (ask.length < 4 || designing) return null;
    setDesigning(true);
    setError(null);
    setQuestions(null);
    try {
      const res = await fetch('/api/views/design', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: ask, viewId, draft: current }),
      });
      const body = (await res
        .json()
        .catch(() => ({ error: 'Respuesta inválida.' }))) as DesignResponse;
      if ('error' in body) setError(body.error);
      else if (body.status === 'needs_input')
        setQuestions({ explanation: body.explanation, items: body.questions });
      else return { draft: body.draft, preview: body.preview, baseVersion: body.baseVersion };
    } catch {
      setError('Sin conexión con Cortex. Inténtalo otra vez.');
    } finally {
      setDesigning(false);
    }
    return null;
  }

  return {
    design,
    designing,
    error,
    questions,
    setError,
    clear: () => {
      setError(null);
      setQuestions(null);
    },
  };
}
