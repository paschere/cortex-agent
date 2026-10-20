'use client';

import {
  type AutofillConfig,
  autofillReady,
  mergeSuggestions,
  triggerSignature,
} from '@cortex/agent-tools/src/trackers/autofill-shape';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * «Llenar con Cortex» en un formulario.
 *
 * Al completarse los campos disparadores de un campo con `autofill` (con una
 * pausa), o al tocar el botón, se le pide al servidor una sugerencia. Lo que
 * llega se mezcla con `mergeSuggestions`: NUNCA pisa lo que la persona escribió.
 * Lo sugerido queda marcado hasta que la persona lo toca. Una misma pregunta
 * (mismos disparadores) se guarda en memoria y no se vuelve a hacer.
 */

export interface AutofillField {
  key: string;
  label: string;
  type: string;
  options?: string[];
  autofill?: AutofillConfig;
}

export type AutofillPhase = 'idle' | 'loading' | 'done' | 'error';
export interface AutofillStatus {
  phase: AutofillPhase;
  message: string | null;
}

interface Answer {
  suggestions: Record<string, { value: string; source?: string }>;
  note: string | null;
}

const answers = new Map<string, Answer>();
const DEBOUNCE_MS = 900;

export function useAutofill(opts: {
  blockId: string;
  fields: AutofillField[];
  values: Record<string, string>;
  setValues: (patch: Record<string, string>) => void;
  /** null = este formulario no puede pedirle nada a Cortex. */
  url: string | null;
  enabled: boolean;
}) {
  const { blockId, fields, values, setValues, url, enabled } = opts;
  const [status, setStatus] = useState<Record<string, AutofillStatus>>({});
  const [suggested, setSuggested] = useState<Record<string, { source?: string }>>({});
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const lastSig = useRef<Record<string, string>>({});
  const applied = useRef<Record<string, string>>({});
  const inflight = useRef<AbortController | null>(null);

  const configs = fields.flatMap((f) => (f.autofill ? [{ field: f, config: f.autofill }] : []));

  // biome-ignore lint/correctness/useExhaustiveDependencies: configs se deriva de fields.
  const run = useCallback(
    async (fieldKey: string, manual: boolean) => {
      const entry = configs.find((c) => c.field.key === fieldKey);
      if (!entry || !url || !enabled) return;
      const cur = valuesRef.current;
      if (!autofillReady(entry.config, cur)) {
        if (manual)
          setStatus((s) => ({
            ...s,
            [fieldKey]: { phase: 'error', message: 'Completa primero los datos para buscar.' },
          }));
        return;
      }
      const sig = triggerSignature(entry.config, cur);
      lastSig.current[fieldKey] = sig;
      const cacheKey = `${blockId}:${fieldKey}:${sig}`;
      let answer = answers.get(cacheKey);
      if (!answer) {
        inflight.current?.abort();
        const ctl = new AbortController();
        inflight.current = ctl;
        setStatus((s) => ({ ...s, [fieldKey]: { phase: 'loading', message: null } }));
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              block: blockId,
              field: fieldKey,
              values: Object.fromEntries(entry.config.from.map((k) => [k, cur[k] ?? ''])),
            }),
            signal: ctl.signal,
          });
          const body = (await res.json().catch(() => null)) as (Answer & { error?: string }) | null;
          if (!res.ok || !body?.suggestions) {
            setStatus((s) => ({
              ...s,
              [fieldKey]: {
                phase: 'error',
                message: body?.error ?? 'Cortex no pudo llenarlo ahora. Llénalo a mano.',
              },
            }));
            return;
          }
          answer = { suggestions: body.suggestions, note: body.note ?? null };
          if (Object.keys(answer.suggestions).length) answers.set(cacheKey, answer);
        } catch (err) {
          if ((err as { name?: string }).name === 'AbortError') return;
          setStatus((s) => ({
            ...s,
            [fieldKey]: { phase: 'error', message: 'Sin conexión: llénalo a mano.' },
          }));
          return;
        }
      }
      const merged = mergeSuggestions(
        fields,
        entry.config,
        valuesRef.current,
        answer.suggestions,
        applied.current,
      );
      if (Object.keys(merged.applied).length) {
        setValues(merged.applied);
        Object.assign(applied.current, merged.applied);
        setSuggested((s) => ({
          ...s,
          ...Object.fromEntries(
            Object.keys(merged.applied).map((k) => [k, { source: merged.sources[k] }]),
          ),
        }));
      }
      const kept = merged.skipped.filter((x) => x.reason === 'escrito').length;
      setStatus((s) => ({
        ...s,
        [fieldKey]: {
          phase: 'done',
          message: Object.keys(merged.applied).length
            ? kept
              ? `Cortex llenó ${Object.keys(merged.applied).length} y dejó lo que ya escribiste.`
              : 'Cortex llenó los campos: revísalos.'
            : (answer.note ??
              (kept ? 'Ya habías escrito esos campos: no los cambié.' : 'No encontré datos.')),
        },
      }));
    },
    [blockId, enabled, fields, setValues, url],
  );

  // Automático: cuando los disparadores se completan o cambian, con una pausa.
  const sigNow = configs
    .map((c) =>
      autofillReady(c.config, values) ? `${c.field.key}:${triggerSignature(c.config, values)}` : '',
    )
    .join('~');
  // biome-ignore lint/correctness/useExhaustiveDependencies: sólo reacciona a la huella.
  useEffect(() => {
    if (!enabled || !url) return;
    const timers: number[] = [];
    for (const c of configs) {
      if (!autofillReady(c.config, valuesRef.current)) continue;
      const sig = triggerSignature(c.config, valuesRef.current);
      if (lastSig.current[c.field.key] === sig) continue;
      timers.push(window.setTimeout(() => void run(c.field.key, false), DEBOUNCE_MS));
    }
    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
  }, [sigNow, enabled, url]);

  useEffect(() => () => inflight.current?.abort(), []);

  /** La persona tocó este campo: deja de ser «sugerido» y ya no se actualiza solo. */
  const markEdited = useCallback((key: string) => {
    setSuggested((s) => {
      if (!(key in s)) return s;
      const { [key]: _gone, ...rest } = s;
      return rest;
    });
    delete applied.current[key];
  }, []);

  /**
   * Otro origen de sugerencias (la lectura de un documento) puso estos valores:
   * quedan marcados como sugeridos —y reemplazables— igual que los del autofill.
   * `appliedNow` ya pasó por el merge, que no pisa lo que la persona escribió.
   */
  const adopt = useCallback((appliedNow: Record<string, string>, source?: string) => {
    Object.assign(applied.current, appliedNow);
    setSuggested((s) => ({
      ...s,
      ...Object.fromEntries(Object.keys(appliedNow).map((k) => [k, { source }])),
    }));
  }, []);

  /** Lo que se puso por sugerencia y la persona no tocó (para que el merge lo pueda actualizar). */
  const previous = useCallback(() => ({ ...applied.current }), []);

  const reset = useCallback(() => {
    setStatus({});
    setSuggested({});
    applied.current = {};
    lastSig.current = {};
  }, []);

  return {
    status,
    suggested,
    run,
    markEdited,
    reset,
    adopt,
    previous,
    available: Boolean(url) && enabled,
  };
}
