'use client';

import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Eye,
  Hand,
  KeyRound,
  Loader2,
  Maximize2,
  Minimize2,
  MonitorSmartphone,
  RotateCw,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ResultViewProps } from './registry';

/**
 * LA PESTAÑA DE CORTEX, EN VIVO — EN UN DOCK FIJO, NO EN EL RÍO DEL CHAT.
 *
 * ===========================================================================
 * POR QUÉ UN DOCK Y NO UNA TARJETA INLINE
 * ===========================================================================
 * La primera versión pintaba la pantalla dentro del transcript, y la vida
 * real la desmintió en una tarde: la conversación sigue (cada aprobación y
 * cada «ya terminé» agregan mensajes), la tarjeta se va scroll arriba, y la
 * persona pierde de vista LA COSA QUE ESTÁ PASANDO — una página moviéndose —
 * justo cuando más la necesita (un captcha esperándola). Además el wheel
 * sobre la tarjeta peleaba con el scroll del chat.
 *
 * Ahora la ventana vive en un dock fijo abajo a la derecha (portal a
 * `document.body`), y en el transcript queda solo una línea que dice dónde
 * está. El dock no se mueve con el scroll, se puede plegar a una píldora, y
 * se agranda a pantalla completa. Fixed dentro de un portal, además, porque
 * `position: fixed` bajo un ancestro con transform (el transcript anima) se
 * vuelve relativo a ese ancestro — así se rompió el botón de fullscreen de la
 * primera versión.
 *
 * ===========================================================================
 * LOS FRAMES SE PINTAN EN UN CANVAS, FUERA DE REACT
 * ===========================================================================
 * La primera versión metía cada frame en un estado y lo pintaba como
 * `<img src="data:...">`: un re-render de React y una decodificación en el
 * hilo principal POR FRAME — lag visible, medido con las manos. Ahora el
 * frame va por `createImageBitmap` (decodifica fuera del hilo) directo a un
 * canvas, React no se entera, y el ACK al servicio sale DESPUÉS de dibujar:
 * la contrapresión del screencast mide la capacidad real de esta pantalla.
 *
 * ===========================================================================
 * CONDUCIR SE SIENTE COMO UNA MANO, NO COMO UN ROBOT
 * ===========================================================================
 * Al tomar el control viajan también los MOVIMIENTOS del mouse (throttle
 * ~33ms, con bitmask de botones para que un arrastre sea un arrastre). No es
 * cosmética: un reCAPTCHA puntúa la trayectoria del cursor, y un click que se
 * teletransporta al centro de la casilla es exactamente lo que castiga. La
 * persona resolviendo el captcha ES una persona; el puente no debe hacerla
 * parecer otra cosa.
 *
 * ===========================================================================
 * UNA SESIÓN, UN DOCK — Y EL SECRETO, DICHO EN VOZ ALTA
 * ===========================================================================
 * Varios resultados del turno pueden nombrar la misma sesión (abrirla, pedir
 * ayuda); el reclamo de módulo hace que solo el ÚLTIMO montado tenga el dock.
 * Si hay dos sesiones vivas, cada dock se apila con su desplazamiento. Y la
 * caja del secreto promete debajo lo que cumple arriba: el valor va del
 * teclado a la página, el modelo no lo ve, y solo vuelve cuántos caracteres.
 */

// ---------------------------------------------------------------------------
// El reclamo: la última tarjeta montada de cada sesión es la que vive. Y los
// docks vivos se cuentan para apilarse sin taparse entre sí.
// ---------------------------------------------------------------------------
let claimSeq = 0;
const claims = new Map<string, number>();
const claimWatchers = new Map<string, Set<() => void>>();
const dockOrder: string[] = [];

function claim(sessionId: string): number {
  claimSeq += 1;
  claims.set(sessionId, claimSeq);
  if (!dockOrder.includes(sessionId)) dockOrder.push(sessionId);
  for (const notify of claimWatchers.get(sessionId) ?? []) notify();
  return claimSeq;
}

function dockSlot(sessionId: string): number {
  const i = dockOrder.indexOf(sessionId);
  return i === -1 ? 0 : i;
}

function releaseDock(sessionId: string): void {
  const i = dockOrder.indexOf(sessionId);
  if (i !== -1) dockOrder.splice(i, 1);
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

interface TabRef {
  sessionId: string;
  checkpointId?: string;
  ask?: string;
  fills?: string | null;
}

/** Los dos resultados que traen pestaña: navegación libre y trámite parado. */
function sessionOf(result: unknown): TabRef | null {
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

function LiveTab({ tab, onSay }: { tab: TabRef; onSay?: (text: string) => void }) {
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

  // Lo que queda EN el transcript es una línea que apunta al dock. La pantalla
  // no compite con el scroll del chat: vive fija, abajo a la derecha.
  return (
    <>
      <div className="mt-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
        <MonitorSmartphone className="mr-1.5 inline h-3.5 w-3.5" />
        {active
          ? 'La pestaña está en vivo abajo a la derecha.'
          : 'Esta pestaña se muestra en su ventana fija, abajo a la derecha.'}
      </div>
      {active ? <LiveDock tab={tab} onSay={onSay} /> : null}
    </>
  );
}

/** Milisegundos entre movimientos de mouse reenviados. ~30fps de trayectoria. */
const MOVE_THROTTLE_MS = 33;

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function LiveDock({ tab, onSay }: { tab: TabRef; onSay?: (text: string) => void }) {
  const { sessionId } = tab;
  const [hasFrame, setHasFrame] = useState(false);
  const [control, setControl] = useState<ControlView | null>(null);
  const [gone, setGone] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [secretValue, setSecretValue] = useState('');
  const [secretDone, setSecretDone] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [resumed, setResumed] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const viewportRef = useRef({ width: 1366, height: 900 });
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const goneRef = useRef(false);
  const liveRef = useRef(false);
  const lastMoveAtRef = useRef(0);
  /** Bitmask CDP de botones apretados (1 = izquierdo), para el arrastre. */
  const buttonsRef = useRef(0);

  const driving = control?.driver === 'human';
  const drivingRef = useRef(false);
  drivingRef.current = driving;

  useEffect(() => () => releaseDock(sessionId), [sessionId]);

  const markGone = useCallback(() => {
    goneRef.current = true;
    setGone(true);
    wsRef.current?.close();
  }, []);

  // Dibuja unos bytes de imagen en el canvas, fuera del ciclo de React.
  const paint = useCallback(async (bytes: Uint8Array, mime: string) => {
    try {
      const bitmap = await createImageBitmap(
        new Blob([bytes.buffer as ArrayBuffer], { type: mime }),
      );
      const canvas = canvasRef.current;
      if (!canvas) return;
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
      bitmap.close();
      setHasFrame(true);
    } catch {
      // Un frame que no decodifica se pierde; el siguiente lo reemplaza.
    }
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
              // El ack sale cuando el frame ya está EN PANTALLA: esa es la
              // contrapresión honesta. Frames que lleguen mientras se dibuja
              // esperan en Chromium, que es donde deben esperar.
              void paint(base64ToBytes(msg.data), 'image/jpeg').finally(() => {
                ws?.send(JSON.stringify({ type: 'ack' }));
              });
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
  }, [sessionId, paint]);

  // -------------------------------------------------------------------------
  // El poleo. Con stream vivo, solo el estado del volante (barato). Sin él,
  // también la foto — y más seguido si hay una persona conduciendo, porque a
  // 1.5s el respaldo se siente como manejar por correo. En 410 la pestaña
  // murió y se dice, no se disimula.
  // -------------------------------------------------------------------------
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

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
            void paint(base64ToBytes(data.view.png), 'image/png');
          }
        }
      } catch {
        // Una pasada perdida no es un evento; la siguiente lo cuenta.
      } finally {
        if (!disposed && !goneRef.current) {
          const delay = liveRef.current ? 2_000 : drivingRef.current ? 600 : 1_200;
          timer = setTimeout(() => void tick(), delay);
        }
      }
    };
    void tick();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, markGone, paint]);

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
      buttonsRef.current = kind === 'mousePressed' ? 1 : 0;
      const { x, y } = toViewport(e.clientX, e.clientY);
      if (
        !sendWs({
          type: 'mouse',
          kind,
          x,
          y,
          button: 'left',
          buttons: buttonsRef.current,
          clickCount: Math.min(e.detail || 1, 3),
        })
      ) {
        // En respaldo, el par pressed/released se colapsa en un click al soltar.
        if (kind === 'mouseReleased') postInput({ kind: 'click', x, y });
      }
    },
    [toViewport, sendWs, postInput],
  );

  const onMove = useCallback(
    (e: React.MouseEvent) => {
      if (!drivingRef.current) return;
      // La trayectoria solo viaja por el socket: por HTTP sería una petición
      // por pixel. En respaldo el cursor se teletransporta y se acepta.
      const now = performance.now();
      if (now - lastMoveAtRef.current < MOVE_THROTTLE_MS) return;
      lastMoveAtRef.current = now;
      const { x, y } = toViewport(e.clientX, e.clientY);
      sendWs({
        type: 'mouse',
        kind: 'mouseMoved',
        x,
        y,
        button: buttonsRef.current ? 'left' : 'none',
        buttons: buttonsRef.current,
      });
    },
    [toViewport, sendWs],
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
      // Fuera del transcript el wheel ya no pelea con el chat: sobre la
      // pantalla siempre scrollea LA PÁGINA, se esté conduciendo o no — mirar
      // hacia abajo en una página larga no debería exigir tomar el volante.
      // Actuar (click, teclas) sí lo exige, como siempre.
      e.preventDefault();
      const { x, y } = toViewport(e.clientX, e.clientY);
      if (!sendWs({ type: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY })) {
        if (drivingRef.current) postInput({ kind: 'scroll', y: e.deltaY });
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

  // Atrás y recargar: los dos botones de navegador que una persona espera.
  // Gestos humanos como los demás — solo con el volante en la mano.
  const nav = useCallback(
    (action: 'back' | 'refresh') => {
      if (!drivingRef.current) return;
      if (!sendWs({ type: 'nav', action })) postInput({ kind: action });
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

  // Escape achica la pantalla grande — salvo mientras se conduce, que es una
  // tecla que la página puede querer.
  useEffect(() => {
    if (!expanded) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !drivingRef.current) setExpanded(false);
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [expanded]);

  if (dismissed) return null;

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
  const slot = dockSlot(sessionId);

  const needsPerson = Boolean(
    !gone && ((control?.help && !driving) || control?.secret || (tab.checkpointId && !resumed)),
  );

  const renderScreen = (fitHeight: boolean) => (
    <div
      ref={surfaceRef}
      className={`relative overflow-hidden rounded-lg border border-border bg-black/90 ${
        fitHeight ? 'mx-auto' : 'w-full'
      } ${driving ? 'cursor-crosshair ring-2 ring-amber-400' : ''}`}
      style={
        fitHeight
          ? {
              aspectRatio: `${width} / ${height}`,
              // Lo más grande que quepa dejando sitio a la barra y al pie —
              // alto-limitado en un monitor ancho, ancho-limitado en uno alto.
              width: `min(100%, calc((100dvh - 11rem) * ${width / height}))`,
            }
          : { aspectRatio: `${width} / ${height}` }
      }
      tabIndex={driving ? 0 : -1}
      role={driving ? 'application' : undefined}
      onMouseDown={(e) => onMouse('mousePressed', e)}
      onMouseUp={(e) => onMouse('mouseReleased', e)}
      onMouseMove={onMove}
      onKeyDown={(e) => onKey('keyDown', e)}
      onKeyUp={(e) => onKey('keyUp', e)}
      onWheel={onWheel}
      onPaste={onPaste}
    >
      <canvas
        ref={canvasRef}
        className={`h-full w-full object-contain ${hasFrame ? '' : 'hidden'}`}
        aria-label={control?.title || 'La pestaña de Cortex'}
      />
      {!hasFrame ? (
        <div className="flex h-full w-full items-center justify-center text-xs text-white/60">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Abriendo la pantalla…
        </div>
      ) : null}
      {gone ? (
        <div className="absolute inset-0 flex items-center justify-center bg-black/70 text-sm text-white">
          Esta pestaña ya se cerró.
        </div>
      ) : null}
    </div>
  );

  const navButtons = (
    <>
      <button
        type="button"
        disabled={!driving}
        title={driving ? 'Atrás' : 'Toma el control para navegar'}
        onClick={() => nav('back')}
        className="rounded p-1.5 hover:bg-muted disabled:opacity-40"
        aria-label="Atrás"
      >
        <ArrowLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        disabled={!driving}
        title={driving ? 'Recargar' : 'Toma el control para navegar'}
        onClick={() => nav('refresh')}
        className="rounded p-1.5 hover:bg-muted disabled:opacity-40"
        aria-label="Recargar"
      >
        <RotateCw className="h-4 w-4" />
      </button>
    </>
  );

  const header = (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <MonitorSmartphone className="h-4 w-4 shrink-0" />
      <span className="truncate font-medium text-foreground">
        {control?.title || 'Pestaña de Cortex'}
      </span>
      {host ? <span className="truncate">· {host}</span> : null}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {gone ? null : live ? (
          <span className="flex items-center gap-1 text-emerald-600">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> en vivo
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Eye className="h-3.5 w-3.5" /> foto/s
          </span>
        )}
        <button
          type="button"
          className="rounded p-1 hover:bg-muted"
          onClick={() => {
            setCollapsed((v) => !v);
            setExpanded(false);
          }}
          aria-label={collapsed ? 'Desplegar' : 'Plegar'}
        >
          {collapsed ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )}
        </button>
        {!collapsed ? (
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
        ) : null}
        {gone ? (
          <button
            type="button"
            className="rounded p-1 hover:bg-muted"
            onClick={() => setDismissed(true)}
            aria-label="Cerrar"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </span>
    </div>
  );

  // La caja del secreto y la del trámite parado, como constantes porque viven
  // en dos sitios: el cuerpo del dock y el pie de la pantalla completa.
  const secretBox =
    !gone && control?.secret ? (
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
    ) : null;

  const checkpointBox =
    !gone && tab.checkpointId && !resumed ? (
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
    ) : null;

  const body = collapsed ? null : (
    <>
      <div className="mt-2">{renderScreen(false)}</div>

      {/* La mano levantada del bot: su razón, tal cual, y el botón que la responde. */}
      {!gone && control?.help && !driving ? (
        <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          <Hand className="mr-1.5 inline h-4 w-4" />
          Cortex necesita tus manos: {control.help.reason}
        </div>
      ) : null}

      {/* El secreto: la caja enmascarada y la promesa, juntas. */}
      {secretBox}
      {checkpointBox}
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
                Estás conduciendo. Nada de esto le llega a Cortex.
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
    </>
  );

  const panel = (
    <div
      className={`pointer-events-auto rounded-xl border bg-card p-3 shadow-lg ${
        needsPerson ? 'border-amber-400' : 'border-border'
      }`}
    >
      {header}
      {body}
    </div>
  );

  if (expanded) {
    // Pantalla completa DE VERDAD: la página ocupa lo que el monitor dé, con
    // una barra de herramientas de navegador arriba (atrás, recargar, el
    // volante) y lo que espera a la persona (captcha, clave, trámite) en un
    // pie que no tapa la página.
    return createPortal(
      <div className="fixed inset-0 z-50 flex flex-col bg-card">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-sm">
          <MonitorSmartphone className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-medium">{control?.title || 'Pestaña de Cortex'}</span>
          {host ? <span className="truncate text-xs text-muted-foreground">· {host}</span> : null}
          {gone ? null : live ? (
            <span className="flex items-center gap-1 text-xs text-emerald-600">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" /> en vivo
            </span>
          ) : (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Eye className="h-3.5 w-3.5" /> foto/s
            </span>
          )}
          <span className="mx-2 h-4 w-px bg-border" />
          {navButtons}
          <span className="ml-auto flex items-center gap-2">
            {!gone ? (
              driving ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void setDriver('release')}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50"
                >
                  <X className="h-3.5 w-3.5" /> Devolver el control
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void setDriver('take')}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border px-3 text-sm font-medium hover:bg-muted disabled:opacity-50"
                >
                  <Hand className="h-3.5 w-3.5" /> Tomar el control
                </button>
              )
            ) : null}
            <button
              type="button"
              className="rounded p-1.5 hover:bg-muted"
              onClick={() => setExpanded(false)}
              aria-label="Salir de pantalla completa"
            >
              <Minimize2 className="h-4 w-4" />
            </button>
          </span>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
          {renderScreen(true)}
        </div>
        {!gone &&
        ((control?.help && !driving) ||
          control?.secret ||
          (tab.checkpointId && !resumed) ||
          driving) ? (
          <div className="max-h-56 shrink-0 overflow-auto border-t border-border px-4 py-2 [&>div]:mt-2 first:[&>div]:mt-0">
            {driving ? (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Estás conduciendo: tu mouse (con sus movimientos), tu teclado y tu scroll van a la
                página. Nada de esto le llega a Cortex.
              </p>
            ) : null}
            {control?.help && !driving ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
                <Hand className="mr-1.5 inline h-4 w-4" />
                Cortex necesita tus manos: {control.help.reason}
              </div>
            ) : null}
            {secretBox}
            {checkpointBox}
          </div>
        ) : null}
      </div>,
      document.body,
    );
  }

  // El dock: fijo abajo a la derecha, fuera del río del chat. Dos sesiones se
  // apilan hacia arriba en vez de taparse.
  return createPortal(
    <div
      className="pointer-events-none fixed right-4 z-40 w-[26rem] max-w-[calc(100vw-2rem)]"
      style={{ bottom: `calc(1rem + ${slot} * 3.25rem)` }}
    >
      {panel}
    </div>,
    document.body,
  );
}
