'use client';

import {
  Eye,
  Hand,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  MonitorSmartphone,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ResultViewProps } from './registry';

/**
 * LA PESTAÑA DE CORTEX, EN VIVO, DENTRO DEL CHAT.
 *
 * ===========================================================================
 * QUÉ ES ESTA TARJETA
 * ===========================================================================
 * Cuando Cortex abre una página con `browser.open_page`, esta tarjeta es la
 * ventana: la persona VE la pestaña mientras el bot navega, puede agrandarla,
 * puede TOMAR EL CONTROL y conducir con su mouse y su teclado, y puede
 * escribir un secreto en una caja enmascarada que va directo a la página.
 * También es la ventana de un trámite que se paró en un captcha: la misma
 * pestaña, el mismo volante, sin salir de la conversación.
 *
 * ===========================================================================
 * DOS TRANSPORTES, UNO DE ELLOS UN REGALO
 * ===========================================================================
 * El camino bueno es un WebSocket directo al servicio de navegador (frames
 * CDP cuando algo cambia, input de vuelta). Vercel no termina WebSockets, así
 * que el navegador de la persona se conecta directo a Railway con un boleto
 * de un minuto que pide `/api/browser/live/[id]/stream`. Si ese socket no
 * conecta —red corporativa, servicio sin URL pública— la tarjeta cae SOLA a
 * fotos por segundo vía el proxy HTTP, con clicks por coordenadas. Peor, pero
 * completo: todo lo que se puede hacer en vivo se puede hacer en el respaldo.
 *
 * ===========================================================================
 * UNA SESIÓN, UNA VENTANA
 * ===========================================================================
 * Un turno puede dejar varias tarjetas de la misma pestaña (la de abrirla, la
 * de pedir ayuda). Dos ventanas sobre la misma sesión serían dos streams
 * compitiendo — el servicio además reemplaza al espectador anterior, así que
 * la de arriba se quedaría congelada fingiendo estar viva. El reclamo de
 * módulo de abajo hace que SOLO LA ÚLTIMA tarjeta montada de cada sesión
 * pinte la ventana; las anteriores lo dicen en una línea y no fingen.
 *
 * ===========================================================================
 * EL SECRETO, Y LO QUE ESTA TARJETA PROMETE EN VOZ ALTA
 * ===========================================================================
 * La caja enmascarada manda el valor por el proxy al servicio, que lo escribe
 * en el campo y devuelve SOLO cuántos caracteres eran. No pasa por el modelo,
 * no queda en el transcript, no se loguea. La tarjeta lo dice debajo de la
 * caja porque una promesa de privacidad que no se enseña no tranquiliza a
 * nadie.
 */

// ---------------------------------------------------------------------------
// El reclamo: la última tarjeta montada de cada sesión es la que vive.
// ---------------------------------------------------------------------------
let claimSeq = 0;
const claims = new Map<string, number>();
const claimWatchers = new Map<string, Set<() => void>>();

function claim(sessionId: string): number {
  claimSeq += 1;
  claims.set(sessionId, claimSeq);
  for (const notify of claimWatchers.get(sessionId) ?? []) notify();
  return claimSeq;
}

function watchClaim(sessionId: string, notify: () => void): () => void {
  const set = claimWatchers.get(sessionId) ?? new Set();
  set.add(notify);
  claimWatchers.set(sessionId, set);
  return () => {
    set.delete(notify);
  };
}

interface ControlView {
  driver: 'bot' | 'human';
  help: { reason: string } | null;
  secret: { label: string } | null;
  url: string;
  title: string;
}

/** Los dos resultados que traen pestaña: los de navegación libre y los de un trámite parado. */
function sessionOf(
  result: unknown,
): { sessionId: string; checkpointId?: string; ask?: string; fills?: string | null } | null {
  if (!result || typeof result !== 'object') return null;
  const r = result as {
    sessionId?: unknown;
    handoff?: { sessionId?: unknown; ask?: unknown; fills?: unknown };
    checkpoint?: { id?: unknown };
  };
  if (typeof r.sessionId === 'string' && r.sessionId) return { sessionId: r.sessionId };
  if (r.handoff && typeof r.handoff.sessionId === 'string') {
    return {
      sessionId: r.handoff.sessionId,
      checkpointId: typeof r.checkpoint?.id === 'string' ? r.checkpoint.id : undefined,
      ask: typeof r.handoff.ask === 'string' ? r.handoff.ask : undefined,
      fills: (r.handoff.fills as string | null | undefined) ?? null,
    };
  }
  return null;
}

export function BrowserLive({ result, onSay }: ResultViewProps) {
  const tab = sessionOf(result);
  if (!tab) {
    // Un resultado sin pestaña (un run_flow que terminó sin pausa, un
    // ask_person que falló) no tiene ventana que pintar. La frase del
    // resultado ya la dijo el texto del turno; aquí no se duplica.
    return null;
  }
  return <LiveTab key={tab.sessionId} tab={tab} onSay={onSay} />;
}

function LiveTab({
  tab,
  onSay,
}: {
  tab: { sessionId: string; checkpointId?: string; ask?: string; fills?: string | null };
  onSay?: (text: string) => void;
}) {
  const { sessionId } = tab;
  const [active, setActive] = useState(false);
  const ticketRef = useRef(0);

  // Reclamar al montar; ceder cuando otra tarjeta de la misma sesión reclame.
  useEffect(() => {
    ticketRef.current = claim(sessionId);
    setActive(true);
    return watchClaim(sessionId, () => {
      if (claims.get(sessionId) !== ticketRef.current) setActive(false);
    });
  }, [sessionId]);

  if (!active) {
    return (
      <div className="mt-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <MonitorSmartphone className="mr-1.5 inline h-3.5 w-3.5" />
        Esta pestaña se está mostrando en una tarjeta más reciente, más abajo.
      </div>
    );
  }
  return <LiveWindow tab={tab} onSay={onSay} />;
}

function LiveWindow({
  tab,
  onSay,
}: {
  tab: { sessionId: string; checkpointId?: string; ask?: string; fills?: string | null };
  onSay?: (text: string) => void;
}) {
  const { sessionId } = tab;
  const [frame, setFrame] = useState<string | null>(null);
  const [control, setControl] = useState<ControlView | null>(null);
  const [gone, setGone] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secretValue, setSecretValue] = useState('');
  const [secretDone, setSecretDone] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [resumed, setResumed] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const viewportRef = useRef({ width: 1366, height: 900 });
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const goneRef = useRef(false);
  const liveRef = useRef(false);

  const driving = control?.driver === 'human';
  const drivingRef = useRef(false);
  drivingRef.current = driving;

  const markGone = useCallback(() => {
    goneRef.current = true;
    setGone(true);
    wsRef.current?.close();
  }, []);

  // -------------------------------------------------------------------------
  // El stream, y su caída limpia al respaldo de fotos.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | null = null;

    (async () => {
      try {
        const res = await fetch(`/api/browser/live/${encodeURIComponent(sessionId)}/stream`, {
          method: 'POST',
        });
        if (!res.ok || disposed) return;
        const { wsUrl } = (await res.json()) as { wsUrl: string };
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;
        ws.onopen = () => {
          if (!disposed) {
            liveRef.current = true;
            setLive(true);
          }
        };
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(String(event.data)) as {
              type: string;
              data?: string;
              width?: number;
              height?: number;
            };
            if (msg.type === 'frame' && msg.data) {
              if (msg.width && msg.height)
                viewportRef.current = { width: msg.width, height: msg.height };
              setFrame(`data:image/jpeg;base64,${msg.data}`);
              ws?.send(JSON.stringify({ type: 'ack' }));
            }
          } catch {
            // Un mensaje raro no tumba la ventana.
          }
        };
        const fallback = () => {
          liveRef.current = false;
          if (!disposed) setLive(false);
        };
        ws.onerror = fallback;
        ws.onclose = fallback;
      } catch {
        // Sin boleto no hay stream; el poleo de abajo se encarga.
      }
    })();

    return () => {
      disposed = true;
      ws?.close();
      wsRef.current = null;
    };
  }, [sessionId]);

  // -------------------------------------------------------------------------
  // El poleo. Con stream vivo, solo el estado del volante (barato). Sin él,
  // también la foto. En 410 la pestaña murió y se dice, no se disimula.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    const tick = async () => {
      if (disposed || goneRef.current) return;
      try {
        const wantState = liveRef.current ? '?state=1' : '';
        const res = await fetch(`/api/browser/live/${encodeURIComponent(sessionId)}${wantState}`);
        if (res.status === 410) {
          markGone();
          return;
        }
        if (res.ok) {
          const data = (await res.json()) as {
            control?: ControlView;
            view?: { png: string; width: number; height: number };
          };
          if (disposed) return;
          if (data.control) setControl(data.control);
          if (data.view?.png && !liveRef.current) {
            viewportRef.current = { width: data.view.width, height: data.view.height };
            setFrame(`data:image/png;base64,${data.view.png}`);
          }
        }
      } catch {
        // Una pasada perdida no es un evento; la siguiente lo cuenta.
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), 1_500);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [sessionId, markGone]);

  // -------------------------------------------------------------------------
  // Conducir. Coordenadas del contenedor → viewport real; por el socket si
  // está vivo, por el proxy HTTP si no. Solo con el volante en la mano.
  // -------------------------------------------------------------------------
  const toViewport = useCallback((clientX: number, clientY: number) => {
    const el = surfaceRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    const { width, height } = viewportRef.current;
    return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * height,
    };
  }, []);

  const sendWs = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  const postInput = useCallback(
    (body: Record<string, unknown>) => {
      void fetch(`/api/browser/live/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'input', ...body }),
      });
    },
    [sessionId],
  );

  const onMouse = useCallback(
    (kind: 'mousePressed' | 'mouseReleased', e: React.MouseEvent) => {
      if (!drivingRef.current) return;
      e.preventDefault();
      const { x, y } = toViewport(e.clientX, e.clientY);
      if (!sendWs({ type: 'mouse', kind, x, y, button: 'left', clickCount: 1 })) {
        // En respaldo, el par pressed/released se colapsa en un click al soltar.
        if (kind === 'mouseReleased') postInput({ kind: 'click', x, y });
      }
    },
    [toViewport, sendWs, postInput],
  );

  const onKey = useCallback(
    (kind: 'keyDown' | 'keyUp', e: React.KeyboardEvent) => {
      if (!drivingRef.current) return;
      e.preventDefault();
      const printable = e.key.length === 1;
      if (
        !sendWs({
          type: 'key',
          kind,
          key: e.key,
          code: e.code,
          text: kind === 'keyDown' && printable ? e.key : undefined,
          // Deprecado y perfecto para esto: es el código que CDP necesita para
          // que Enter y Backspace existan del otro lado.
          windowsVirtualKeyCode: e.keyCode,
        }) &&
        kind === 'keyDown'
      ) {
        if (printable) postInput({ kind: 'type', text: e.key });
        else if (['Enter', 'Backspace', 'Tab', 'Escape'].includes(e.key))
          postInput({ kind: 'key', text: e.key });
      }
    },
    [sendWs, postInput],
  );

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!drivingRef.current) return;
      const { x, y } = toViewport(e.clientX, e.clientY);
      if (!sendWs({ type: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY })) {
        postInput({ kind: 'scroll', y: e.deltaY });
      }
    },
    [toViewport, sendWs, postInput],
  );

  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!drivingRef.current) return;
      e.preventDefault();
      const text = e.clipboardData.getData('text');
      if (text && !sendWs({ type: 'text', text }))
        postInput({ kind: 'type', text: text.slice(0, 200) });
    },
    [sendWs, postInput],
  );

  // -------------------------------------------------------------------------
  // El volante y el secreto, contra el proxy.
  // -------------------------------------------------------------------------
  const setDriver = useCallback(
    async (op: 'take' | 'release') => {
      setBusy(true);
      try {
        const res = await fetch(`/api/browser/live/${encodeURIComponent(sessionId)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ op }),
        });
        if (res.ok) {
          const data = (await res.json()) as { control?: ControlView };
          if (data.control) setControl(data.control);
          if (op === 'release') {
            // El aviso que el bot está esperando. Sale como mensaje de la
            // persona porque ES de la persona: es ella quien terminó.
            onSay?.('Ya terminé en la página y te devolví el control. Mira cómo quedó y continúa.');
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [sessionId, onSay],
  );

  const submitSecret = useCallback(async () => {
    if (!secretValue) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/browser/live/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ op: 'secret', value: secretValue }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        length?: number;
        error?: string;
      };
      if (res.ok && data.ok) {
        const label = control?.secret?.label ?? 'el dato';
        setSecretDone(`Listo: ${data.length ?? '•'} caracteres escritos directo en la página.`);
        setSecretValue('');
        onSay?.(`Ya escribí «${label}» directamente en la página (tú nunca lo viste). Continúa.`);
      } else {
        setSecretDone(data.error ?? 'No se pudo escribir. Intenta de nuevo.');
      }
    } finally {
      setBusy(false);
    }
  }, [sessionId, secretValue, control, onSay]);

  // Un trámite parado se retoma por su checkpoint, que cierra, teclea y
  // entrega — la ruta de checkpoints lleva el porqué de cada una.
  const resumeCheckpoint = useCallback(async () => {
    if (!tab.checkpointId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/browser/checkpoints/${encodeURIComponent(tab.checkpointId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answer }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
      };
      setResumed(
        data.message ??
          data.error ??
          (res.ok ? 'El trámite continuó.' : 'No se pudo retomar el trámite.'),
      );
      if (res.ok) markGone();
    } finally {
      setBusy(false);
    }
  }, [tab.checkpointId, answer, markGone]);

  // -------------------------------------------------------------------------
  // Pintar.
  // -------------------------------------------------------------------------
  const { width, height } = viewportRef.current;
  const host = (() => {
    try {
      return control?.url ? new URL(control.url).host : '';
    } catch {
      return '';
    }
  })();

  const screen = (
    <div
      ref={surfaceRef}
      className={`relative w-full overflow-hidden rounded-lg border border-border bg-black/90 ${
        driving ? 'cursor-crosshair ring-2 ring-amber-400' : ''
      }`}
      style={{ aspectRatio: `${width} / ${height}` }}
      tabIndex={driving ? 0 : -1}
      role={driving ? 'application' : undefined}
      onMouseDown={(e) => onMouse('mousePressed', e)}
      onMouseUp={(e) => onMouse('mouseReleased', e)}
      onKeyDown={(e) => onKey('keyDown', e)}
      onKeyUp={(e) => onKey('keyUp', e)}
      onWheel={onWheel}
      onPaste={onPaste}
    >
      {frame ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={frame}
          alt={control?.title || 'La pestaña de Cortex'}
          className="h-full w-full object-contain"
          draggable={false}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-xs text-white/60">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Abriendo la pantalla…
        </div>
      )}
      {gone ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm text-white">
          Esta pestaña ya se cerró.
        </div>
      ) : null}
    </div>
  );

  const card = (
    <div className="mt-2 w-full max-w-2xl rounded-xl border border-border bg-card p-3 shadow-sm">
      {/* Barra: dónde está la pestaña y en qué calidad se ve. */}
      <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
        <MonitorSmartphone className="h-4 w-4 shrink-0" />
        <span className="truncate font-medium text-foreground">
          {control?.title || 'Pestaña de Cortex'}
        </span>
        {host ? <span className="truncate">· {host}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          {gone ? null : live ? (
            <span className="flex items-center gap-1 text-emerald-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> en vivo
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <Eye className="h-3.5 w-3.5" /> foto por segundo
            </span>
          )}
          <button
            type="button"
            className="rounded p-1 hover:bg-muted"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expanded ? 'Achicar' : 'Ver en grande'}
          >
            {expanded ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>
        </span>
      </div>

      {screen}

      {/* La mano levantada del bot: su razón, tal cual, y el botón que la responde. */}
      {!gone && control?.help && !driving ? (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <Hand className="mr-1.5 inline h-4 w-4" />
          Cortex necesita tus manos: {control.help.reason}
        </div>
      ) : null}

      {/* El secreto: la caja enmascarada y la promesa, juntas. */}
      {!gone && control?.secret ? (
        <div className="mt-2 rounded-lg border border-border bg-muted/40 p-3">
          <div className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
            <KeyRound className="h-4 w-4" /> {control.secret.label}
          </div>
          <div className="flex gap-2">
            <input
              type="password"
              autoComplete="off"
              value={secretValue}
              onChange={(e) => setSecretValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitSecret();
              }}
              placeholder="Se escribe directo en la página"
              className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
            />
            <button
              type="button"
              disabled={busy || !secretValue}
              onClick={() => void submitSecret()}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              Escribir
            </button>
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Va del teclado a la página. Cortex nunca ve el valor y no queda en la conversación.
          </p>
          {secretDone ? <p className="mt-1 text-xs text-foreground">{secretDone}</p> : null}
        </div>
      ) : null}

      {/* Un trámite parado: la pregunta del portal y el botón de seguir. */}
      {!gone && tab.checkpointId && !resumed ? (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
          <p className="mb-2 text-amber-900 dark:text-amber-200">
            {tab.ask ||
              'El trámite necesita algo tuyo aquí (un captcha, una casilla). Resuélvelo en la pantalla y sigue.'}
          </p>
          <div className="flex gap-2">
            {tab.fills ? (
              <input
                value={answer}
                onChange={(e) => setAnswer(e.target.value)}
                placeholder="La respuesta (el código, el dato)"
                className="h-9 flex-1 rounded-md border border-input bg-background px-3 text-sm"
              />
            ) : null}
            <button
              type="button"
              disabled={busy || (Boolean(tab.fills) && !answer.trim())}
              onClick={() => void resumeCheckpoint()}
              className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Continuar el trámite'}
            </button>
          </div>
        </div>
      ) : null}
      {resumed ? <p className="mt-2 text-sm text-muted-foreground">{resumed}</p> : null}

      {/* El volante. */}
      {!gone ? (
        <div className="mt-2 flex items-center gap-2">
          {driving ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void setDriver('release')}
                className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" /> Devolver el control
              </button>
              <span className="text-xs text-amber-600 dark:text-amber-400">
                Estás conduciendo: tu mouse y tu teclado van a la página. Nada de esto le llega a
                Cortex.
              </span>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => void setDriver('take')}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              <Hand className="h-3.5 w-3.5" /> Tomar el control
            </button>
          )}
        </div>
      ) : null}
    </div>
  );

  if (!expanded) return card;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-h-full w-full max-w-5xl overflow-auto">{card}</div>
    </div>
  );
}
