'use client';

import { Button } from '@/components/ui/button';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * APRENDER DE TU CORREO — el interruptor, con lo que hace escrito al lado.
 *
 * La pantalla dice tres cosas y ninguna es opcional: QUÉ va a leer (tu buzón
 * entero, correo interno incluido), DÓNDE lo guarda (tu espacio privado, que
 * nadie más puede buscar) y QUÉ hará cada mañana (archivar lo nuevo y proponer
 * respuestas que tú apruebas). Un interruptor que lee el correo de alguien sin
 * decirlo con esas palabras es un interruptor que nadie debería poder pulsar
 * sin querer.
 */

export type MailboxWindow = '1m' | '90d' | '6m' | '12m';

const WINDOW_LABEL: Record<MailboxWindow, string> = {
  '1m': 'Último mes',
  '90d': 'Últimos 90 días',
  '6m': 'Últimos 6 meses',
  '12m': 'Último año',
};

export interface MailboxState {
  emailAddress: string | null;
  backfillWindow: MailboxWindow;
  backfillThreads: number;
  backfillDoneAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
  paused: boolean;
}

function fmt(iso: string | null): string {
  if (!iso) return 'todavía no';
  return new Date(iso).toLocaleString('es-CO', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function MailboxLearning({
  state,
  googleConnected,
}: {
  state: MailboxState | null;
  googleConnected: boolean;
}) {
  const router = useRouter();
  const [window, setWindow] = useState<MailboxWindow>(state?.backfillWindow ?? '12m');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const running = Boolean(state) && !state?.paused;

  async function send(action: 'start' | 'stop') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/gmail/learning', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, window }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        setError(
          typeof data.error === 'string'
            ? data.error
            : 'No se pudo cambiar eso. Inténtalo otra vez en un momento.',
        );
        return;
      }
      router.refresh();
    } catch {
      setError('Se cayó la conexión antes de guardar. Inténtalo otra vez.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="text-sm font-medium text-ink">Aprender de tu correo</h2>
        <p className="mt-1 text-sm text-ink-muted">
          Cortex lee tu buzón de Gmail —incluido el correo interno— y lo guarda en tu espacio
          privado del cerebro, donde sólo buscas tú. Después, cada mañana lee lo que llegó desde el
          día anterior, lo archiva y te propone hasta cinco respuestas que tú apruebas o descartas.
          Nunca envía nada solo.
        </p>
      </div>

      {!googleConnected ? (
        <p className="rounded-sm border border-amber/40 bg-amber-soft px-3 py-2 text-sm text-amber">
          Primero conecta tu cuenta de Google, arriba. Sin ese permiso no hay buzón que leer.
        </p>
      ) : null}

      {state ? (
        <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-ink-faint">Buzón</dt>
            <dd className="text-ink">{state.emailAddress ?? '—'}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Conversaciones</dt>
            <dd className="text-ink">{state.backfillThreads.toLocaleString('es-CO')}</dd>
          </div>
          <div>
            <dt className="text-ink-faint">Histórico</dt>
            <dd className="text-ink">
              {state.backfillDoneAt ? 'completo' : 'bajando…'} ·{' '}
              {WINDOW_LABEL[state.backfillWindow]}
            </dd>
          </div>
          <div>
            <dt className="text-ink-faint">Último barrido</dt>
            <dd className="text-ink">{fmt(state.lastSyncedAt)}</dd>
          </div>
        </dl>
      ) : null}

      {state?.lastError ? (
        <p className="rounded-sm border border-amber/40 bg-amber-soft px-3 py-2 text-sm text-amber">
          {state.lastError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-ink-muted" htmlFor="mailbox-window">
          Cuánto histórico
        </label>
        <select
          id="mailbox-window"
          value={window}
          disabled={busy || !googleConnected}
          onChange={(e) => setWindow(e.target.value as MailboxWindow)}
          className="rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink disabled:opacity-50"
        >
          {(Object.keys(WINDOW_LABEL) as MailboxWindow[]).map((w) => (
            <option key={w} value={w}>
              {WINDOW_LABEL[w]}
            </option>
          ))}
        </select>

        <Button onClick={() => send('start')} disabled={busy || !googleConnected}>
          {running ? 'Volver a cargar el histórico' : 'Empezar a aprender'}
        </Button>

        {running ? (
          <Button variant="outline" onClick={() => send('stop')} disabled={busy}>
            Apagar
          </Button>
        ) : null}
      </div>

      {error ? <p className="text-sm text-amber">{error}</p> : null}

      <p className="text-xs text-ink-faint">
        Apagarlo no borra nada de lo aprendido. Los documentos viven en el cerebro y se borran desde
        ahí.
      </p>
    </div>
  );
}
