'use client';

import { essentialArgs, formatDuration } from '@/lib/tool-args';
import { toolDisplayName } from '@/lib/tool-labels';
import type { ToolInvocation } from 'ai';
import { clsx } from 'clsx';
import { AlertCircle, Check, ChevronDown, Loader2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StructuralResult } from './results/StructuralResult';

/**
 * La línea de «cómo lo hice»: cuántos pasos y cuáles, en palabras.
 * «3 pasos: Consultar Siigo, Leer el correo y 1 más».
 */
export function howSummary(invocations: readonly ToolInvocation[]): string {
  const names = [...new Set(invocations.map((i) => toolDisplayName(i.toolName)))];
  const shown = names.slice(0, 2);
  const extra = names.length - shown.length;
  const list =
    shown.length === 2 && extra === 0
      ? `${shown[0]} y ${shown[1]}`
      : extra > 0
        ? `${shown.join(', ')} y ${extra} más`
        : (shown[0] ?? '');
  const n = invocations.length;
  return `${n} ${n === 1 ? 'paso' : 'pasos'}: ${list}`;
}

export interface TurnMetrics {
  firstVisibleMs: number | null;
  preludeMs: number;
  totalMs: number;
  toolCalls: number;
  toolMs: number;
  calls: Array<{ toolId: string; ms: number | null; status: string }>;
}

/**
 * Match the server's per-call rows onto the invocations on screen.
 *
 * `audit_events` predates the AI SDK's tool-call ids, so rows for the same tool
 * are told apart by ORDER: the nth row for a tool is the nth call to it. That
 * holds because `runTool` writes one row per call as it finishes, and it fails
 * safely — the worst case is a duration shown against the wrong call OF THE
 * SAME TOOL, never against a different tool and never a number nobody measured.
 */
export function matchDurations(
  invocations: readonly ToolInvocation[],
  metrics: TurnMetrics | null,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!metrics) return out;

  const queues = new Map<string, number[]>();
  for (const call of metrics.calls) {
    const key = call.toolId.replaceAll('.', '_');
    const queue = queues.get(key) ?? [];
    queue.push(call.ms ?? Number.NaN);
    queues.set(key, queue);
  }

  for (const inv of invocations) {
    const queue = queues.get(inv.toolName.replaceAll('.', '_'));
    const next = queue?.shift();
    if (next !== undefined && Number.isFinite(next)) out.set(inv.toolCallId, next);
  }
  return out;
}

/** A live counter, in whole seconds, for a call that has not come back yet. */
function useElapsed(active: boolean): number {
  const [ms, setMs] = useState(0);
  const startedAt = useRef<number | null>(null);

  useEffect(() => {
    if (!active) {
      startedAt.current = null;
      setMs(0);
      return;
    }
    startedAt.current = performance.now();
    // One second, not sixteen frames a second: this is a progress signal, and a
    // digit flickering at 60Hz next to a paragraph somebody is reading is the
    // kind of motion the design system rules out. It is also why there is no
    // transition here for `prefers-reduced-motion` to have to switch off.
    const id = setInterval(() => {
      if (startedAt.current !== null) setMs(performance.now() - startedAt.current);
    }, 1000);
    return () => clearInterval(id);
  }, [active]);

  return ms;
}

function isErrorResult(inv: ToolInvocation): boolean {
  if (inv.state !== 'result') return false;
  const result = (inv as { result?: unknown }).result;
  return !!result && typeof result === 'object' && '__error' in (result as Record<string, unknown>);
}

function TaskRow({
  invocation,
  durationMs,
  progress,
}: {
  invocation: ToolInvocation;
  durationMs: number | null | undefined;
  /** Última línea de avance de esta llamada (efímera; sólo mientras corre). */
  progress?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const running = invocation.state === 'call' || invocation.state === 'partial-call';
  const failed = isErrorResult(invocation);
  const elapsed = useElapsed(running);

  const label = toolDisplayName(invocation.toolName);
  const args = useMemo(() => essentialArgs(invocation.args), [invocation.args]);
  const measured = formatDuration(durationMs ?? null);
  const shown = running ? formatDuration(elapsed >= 1000 ? elapsed : null) : measured;

  const result =
    invocation.state === 'result' ? (invocation as { result?: unknown }).result : undefined;
  const evidence =
    'scroll-slim mt-1 max-h-52 overflow-auto rounded-sm border border-border bg-surface-2 p-2.5 font-mono text-micro leading-relaxed text-ink-muted';

  return (
    <li className={clsx('border-t border-border first:border-t-0', failed && 'bg-rose-soft')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors duration-150 hover:bg-surface-2 motion-reduce:transition-none"
      >
        <span className="grid h-4 w-4 shrink-0 place-items-center" aria-hidden>
          {running ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          ) : failed ? (
            <AlertCircle className="h-3.5 w-3.5 text-rose" />
          ) : (
            <Check className="h-3 w-3 text-ink-faint" />
          )}
        </span>

        <span
          className={clsx(
            'shrink-0 text-xs font-medium',
            failed ? 'text-rose' : running ? 'text-ink' : 'text-ink-muted',
          )}
        >
          {label}
        </span>

        {args && (
          // The arguments are evidence — what Cortex actually asked — so they
          // get the monospace face, like every other checkable value.
          <span className="min-w-0 flex-1 truncate font-mono text-micro text-ink-faint">
            {args}
          </span>
        )}
        {!args && <span className="flex-1" />}

        {shown && (
          <span
            className="tabular shrink-0 text-micro text-ink-faint"
            title={running ? 'Tiempo transcurrido' : 'Medido en el servidor'}
          >
            {running ? `${shown}…` : shown}
          </span>
        )}

        <ChevronDown
          className={clsx(
            'h-3 w-3 shrink-0 text-ink-faint transition-transform duration-150 group-hover:text-primary motion-reduce:transition-none',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      {running && progress && (
        // Una línea de avance bajo el renglón, truncada: el chip dice qué está
        // pasando AHORA ({«Listé 1.200 archivos…»}). Desaparece al terminar.
        <p
          className="min-w-0 truncate px-3 pb-1.5 pl-9 text-micro text-ink-muted"
          aria-live="polite"
          title={progress}
          data-testid="tool-progress"
        >
          {progress}
        </p>
      )}

      {open && (
        <div className="min-w-0 space-y-2 px-3 pb-2.5 pl-9">
          {/* The raw id: what identifies this call in the audit log and in a
              support conversation. */}
          <div className="break-all font-mono text-micro text-ink-faint">{invocation.toolName}</div>
          {invocation.args !== undefined && (
            <div>
              <div className="field-label">Argumentos</div>
              <ArgFields args={invocation.args} fallbackClassName={evidence} />
            </div>
          )}
          {result !== undefined && (
            <div>
              <div className="field-label">{failed ? 'Error' : 'Resultado'}</div>
              {/*
                UN PASO SIGUE SIENDO UN PASO — lo que cambia es que ahora se
                lee al desplegarlo.

                El resultado de ~130 de las 134 herramientas terminaba aquí
                como un objeto en bruto. `StructuralResult` mira la forma y
                dibuja una tabla o una lista de campos cuando la reconoce, y
                vuelve al JSON cuando no: una tabla que se come la mitad de los
                datos es peor que el JSON, porque el JSON al menos se ve entero.

                Deliberadamente NO asciende a tarjeta. La tesis de este archivo
                —una llamada es un renglón, doce tarjetas son una pared— sigue
                siendo cierta, y lo que la respeta es que esto viva dentro del
                chevron. Un error se queda en JSON: la forma de un fallo es
                justo la que nadie debería tener que interpretar.
              */}
              {failed || typeof result === 'string' ? (
                <pre className={evidence}>
                  {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
                </pre>
              ) : (
                <StructuralResult result={result} />
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * LO QUE SE LE PIDIÓ A LA HERRAMIENTA, SIN LLAVES.
 *
 * Esto era `JSON.stringify(args, null, 2)`, y en el caso más común de todo el
 * producto —una herramienta con UN argumento— producía esto:
 *
 *     {
 *       "reportId": "ea5d9703-7ef2-4698-8c32-eec9c9fc095d"
 *     }
 *
 * Tres renglones, dos de ellos puntuación, para enseñar un valor. Y la parte
 * que de verdad importa —si Cortex entendió la pregunta— quedaba escondida
 * entre sintaxis que no le dice nada a quien despliega un paso para comprobar
 * qué le pidió a quién.
 *
 * Ahora un objeto plano es una lista de campos: nombre a la izquierda, valor a
 * la derecha en monoespaciada porque es evidencia —la regla 3 del sistema de
 * diseño— y recortado a tres renglones, que es donde deja de ser un dato y
 * empieza a ser un adjunto.
 *
 * EL JSON SIGUE AHÍ para todo lo demás, y eso no es una concesión: un argumento
 * anidado dibujado como una fila plana miente sobre su forma, y la lista de
 * pasos existe precisamente para poder auditar lo que se pidió. Cuando la forma
 * no cabe en una fila, el objeto entero es más honesto que un resumen.
 */
function ArgFields({ args, fallbackClassName }: { args: unknown; fallbackClassName: string }) {
  const entries =
    typeof args === 'object' && args !== null && !Array.isArray(args)
      ? Object.entries(args as Record<string, unknown>)
      : null;

  if (entries && entries.length === 0) {
    // Una herramienta sin argumentos es un hecho, no un hueco: `{}` obliga a
    // quien lo lee a decidir si eso significa «ninguno» o «no se guardaron».
    return <p className="mt-1 text-micro text-ink-faint">Sin argumentos.</p>;
  }

  const flat =
    entries?.every(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v)) ===
    true;

  if (!entries || !flat) {
    return <pre className={fallbackClassName}>{JSON.stringify(args, null, 2)}</pre>;
  }

  return (
    <dl className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-[minmax(0,auto)_minmax(0,1fr)]">
      {entries.map(([key, value]) => (
        <div key={key} className="contents">
          <dt className="text-micro uppercase tracking-field text-ink-faint">{key}</dt>
          <dd
            className="line-clamp-3 min-w-0 break-all font-mono text-micro text-ink-muted"
            // El valor entero al pasar por encima: lo recortado sigue estando a
            // mano sin que un identificador de doscientos caracteres empuje la
            // fila. Nada de `null` en el atributo, que se escribiría «null».
            title={value === null ? undefined : String(value)}
          >
            {value === null
              ? '—'
              : typeof value === 'boolean'
                ? value
                  ? 'Sí'
                  : 'No'
                : String(value)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function TaskRows({
  invocations,
  metrics,
  isStreaming,
  quiet,
  progress,
}: {
  invocations: ToolInvocation[];
  metrics: TurnMetrics | null;
  /** Última línea de avance por toolCallId (ver lib/tool-progress.ts). */
  progress?: ReadonlyMap<string, string> | undefined;
  isStreaming?: boolean;
  /** Mientras Cortex piensa y aún no hay prosa, la cabecera Presence cuenta. */
  quiet?: boolean;
}) {
  const durations = useMemo(() => matchDurations(invocations, metrics), [invocations, metrics]);
  const failures = invocations.filter(isErrorResult).length;
  const running = invocations.some((i) => i.state !== 'result');

  // Open while it is happening, and while anything went wrong — a failed step
  // hidden behind a disclosure is a failed step nobody sees. `quiet` is the
  // exception: the header Presence is already the live signal, and a list of
  // tool names next to "Pensando…" is two theatres for one wait.
  // Terminado el turno, los pasos son UNA línea —«cómo lo hice»— que se abre
  // al tocarla. Los fallos no se esconden (arriba, el porqué).
  const shouldCollapse = (quiet && !!isStreaming) || (!isStreaming && !running && failures === 0);
  const [open, setOpen] = useState(!shouldCollapse);
  useEffect(() => {
    if (!shouldCollapse) setOpen(true);
  }, [shouldCollapse]);

  // Al acabar el turno lo que estaba a la vista se recoge solo.
  const wasLive = useRef(!!isStreaming || running);
  useEffect(() => {
    const live = !!isStreaming || running;
    if (wasLive.current && !live && failures === 0) setOpen(false);
    wasLive.current = live;
  }, [isStreaming, running, failures]);

  if (invocations.length === 0) return null;

  const totalLabel = formatDuration(metrics?.toolMs ?? null);
  const currentLabel = running
    ? toolDisplayName(invocations.filter((i) => i.state !== 'result').slice(-1)[0]?.toolName ?? '')
    : null;

  const summary = howSummary(invocations);

  return (
    <div className="mt-3">
      {/*
        A screen reader is told what is happening now, in words, and is NOT read
        the whole list every time a row lands — `aria-live` sits on this one
        line rather than on the list, so twelve tool calls announce twelve short
        sentences instead of twelve growing lists.
      */}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {running && currentLabel
          ? `Cortex está usando: ${currentLabel}.`
          : failures > 0
            ? `Cortex terminó ${invocations.length} pasos, ${failures} con error.`
            : `Cortex terminó ${invocations.length} ${invocations.length === 1 ? 'paso' : 'pasos'}.`}
      </p>

      {shouldCollapse && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="inline-flex max-w-full items-center gap-2 rounded-pill bg-surface-2 px-3 py-1.5 text-left text-xs text-ink-muted transition-colors duration-150 hover:bg-border hover:text-ink motion-reduce:transition-none"
        >
          <Check className="h-3 w-3 shrink-0 text-emerald" aria-hidden />
          <span className="min-w-0 truncate">
            {summary}
            {totalLabel ? ` en ${totalLabel}` : ''} · cómo lo hice
          </span>
          <ChevronDown
            className={clsx(
              'h-3 w-3 shrink-0 text-ink-faint transition-transform duration-150 motion-reduce:transition-none',
              open && 'rotate-180',
            )}
            aria-hidden
          />
        </button>
      )}

      {open && (
        <div
          className={clsx(
            'overflow-hidden rounded-card border border-border bg-surface',
            shouldCollapse && 'mt-2',
          )}
        >
          <ul className="list-none">
            {invocations.map((inv) => (
              <TaskRow
                key={inv.toolCallId}
                invocation={inv}
                durationMs={durations.get(inv.toolCallId)}
                progress={progress?.get(inv.toolCallId)}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
