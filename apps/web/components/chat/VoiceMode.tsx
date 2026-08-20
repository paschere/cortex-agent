'use client';

import { Loader2, Mic, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * MODO VOZ MANOS LIBRES — hablar con Cortex como una llamada.
 *
 * ===========================================================================
 * EL LOOP
 * ===========================================================================
 * Abres el modo, hablas, Cortex nota que terminaste (un silencio corto tras la
 * última palabra), piensa la respuesta con TODO su cerebro y sus herramientas
 * (/api/voice/turn), la dice con su voz (/api/voice/speak, Deepgram Aura-2), y
 * vuelve a escuchar. Sin tocar nada entre medias: es una conversación, no una
 * ráfaga de botones.
 *
 * ===========================================================================
 * LA TRANSCRIPCIÓN ES DEL NAVEGADOR — Y ESO DECIDE DÓNDE VIVE ESTO
 * ===========================================================================
 * Lo que TÚ dices lo transcribe `SpeechRecognition`, que ya vive en el
 * navegador (el mismo que usa el dictado): sin subir tu voz a ningún lado, sin
 * llave, sin factura por escuchar. El precio es Firefox, que no lo trae — ahí
 * el modo no se ofrece. Solo la VOZ DE CORTEX pasa por Deepgram, porque una voz
 * de verdad sí vale la pena pagarla.
 *
 * ===========================================================================
 * NO SE ESCUCHA A SÍ MISMO
 * ===========================================================================
 * Mientras Cortex habla, el reconocedor se DETIENE, y se reanuda cuando el
 * audio termina. Si no, el micrófono oiría a Cortex y le contestaría a Cortex
 * — un bucle que se muerde la cola. Detener y reanudar es la versión simple y
 * correcta; interrumpirlo a media frase (barge-in) es un lujo para después.
 */

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';

interface Turn {
  role: 'you' | 'cortex';
  text: string;
}

interface RecognitionAlternative {
  transcript: string;
}
interface RecognitionResult {
  isFinal: boolean;
  0: RecognitionAlternative;
}
interface RecognitionEvent {
  resultIndex: number;
  results: { length: number; [index: number]: RecognitionResult };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Silencio tras la última palabra que cuenta como «terminé de hablar». */
const END_OF_TURN_MS = 1_100;

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Preparando…',
  listening: 'Te escucho…',
  thinking: 'Pensando…',
  speaking: 'Cortex habla',
  error: 'Algo salió mal',
};

export function VoiceMode({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [supported, setSupported] = useState<boolean | null>(null);
  const [liveText, setLiveText] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [note, setNote] = useState<string | null>(null);

  const recRef = useRef<Recognition | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Lo que queremos que el reconocedor haga: reiniciarlo en su `onend` solo si
  // seguimos en modo escucha (y no porque paramos para hablar o cerrar).
  const wantListenRef = useRef(false);
  const finalRef = useRef('');
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<Turn[]>([]);
  const closedRef = useRef(false);

  const clearSilence = useCallback(() => {
    if (silenceTimer.current) {
      clearTimeout(silenceTimer.current);
      silenceTimer.current = null;
    }
  }, []);

  const startListening = useCallback(() => {
    const rec = recRef.current;
    if (!rec || closedRef.current) return;
    finalRef.current = '';
    setLiveText('');
    wantListenRef.current = true;
    try {
      rec.start();
      setPhase('listening');
    } catch {
      // start() lanza si ya estaba corriendo; el onend lo reencaminará.
    }
  }, []);

  // El turno: paramos de oír, preguntamos al cerebro, hablamos, y volvemos.
  const runTurn = useCallback(
    async (said: string) => {
      const question = said.trim();
      if (!question || closedRef.current) return;
      clearSilence();
      wantListenRef.current = false;
      recRef.current?.stop();

      setLiveText('');
      const withYou = [...historyRef.current, { role: 'you' as const, text: question }];
      historyRef.current = withYou;
      setTurns(withYou);
      setPhase('thinking');
      setNote(null);

      let answer = '';
      try {
        const res = await fetch('/api/voice/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          // Solo la cola reciente, para dar continuidad sin mandar la charla entera.
          body: JSON.stringify({ question, history: withYou.slice(-12) }),
        });
        // El muro premium (402): no es un error de la charla, es que el plan no
        // incluye la voz. Se para el loop y se dice claro.
        if (res.status === 402) {
          wantListenRef.current = false;
          setPhase('error');
          setNote('El modo voz es una función premium. Habla con tu administrador para activarla.');
          return;
        }
        const data = (await res.json().catch(() => ({}))) as { answer?: string; error?: string };
        answer = data.answer ?? data.error ?? 'No pude responder.';
      } catch {
        answer = 'Se me cayó la conexión un momento.';
      }
      if (closedRef.current) return;

      const withCortex = [...historyRef.current, { role: 'cortex' as const, text: answer }];
      historyRef.current = withCortex;
      setTurns(withCortex);

      // Hablar. Si la voz no está configurada (503) o falla, mostramos el texto
      // y volvemos a escuchar igual: el modo no se rompe por quedarse sin voz.
      setPhase('speaking');
      try {
        const speak = await fetch('/api/voice/speak', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: answer }),
        });
        if (!speak.ok) {
          if (speak.status === 503) setNote('La voz no está configurada aquí; te dejo el texto.');
          if (!closedRef.current) startListening();
          return;
        }
        const blob = await speak.blob();
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          URL.revokeObjectURL(url);
          audioRef.current = null;
          if (!closedRef.current) startListening();
        };
        audio.onerror = () => {
          URL.revokeObjectURL(url);
          audioRef.current = null;
          if (!closedRef.current) startListening();
        };
        await audio.play().catch(() => {
          // Si el navegador rechaza reproducir, no dejamos el modo colgado.
          if (!closedRef.current) startListening();
        });
      } catch {
        if (!closedRef.current) startListening();
      }
    },
    [startListening, clearSilence],
  );

  // Montaje: detectar soporte, cablear el reconocedor, arrancar el loop.
  useEffect(() => {
    const Ctor = recognitionCtor();
    if (!Ctor) {
      setSupported(false);
      setPhase('error');
      return;
    }
    setSupported(true);
    const rec = new Ctor();
    rec.lang = 'es-CO';
    rec.continuous = true;
    rec.interimResults = true;

    rec.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (!r) continue;
        const t = r[0]?.transcript ?? '';
        if (r.isFinal) finalRef.current = `${finalRef.current} ${t}`.trim();
        else interim += t;
      }
      setLiveText(`${finalRef.current} ${interim}`.trim());
      // Cada palabra reinicia el reloj del silencio: cuando de verdad callas,
      // se cumple y disparamos el turno con lo acumulado.
      clearSilence();
      if (finalRef.current) {
        silenceTimer.current = setTimeout(() => void runTurn(finalRef.current), END_OF_TURN_MS);
      }
    };
    rec.onerror = (e) => {
      // 'no-speech'/'aborted' son normales; solo el de permiso importa contarlo.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setNote('Necesito permiso del micrófono para el modo voz.');
        setPhase('error');
        wantListenRef.current = false;
      }
    };
    rec.onend = () => {
      // El reconocedor se detiene solo cada tanto; si seguimos queriendo oír,
      // lo reanudamos. Si paramos a propósito (hablar/cerrar), no.
      if (wantListenRef.current && !closedRef.current) {
        try {
          rec.start();
        } catch {
          /* ya arrancando */
        }
      }
    };
    recRef.current = rec;
    startListening();

    return () => {
      closedRef.current = true;
      wantListenRef.current = false;
      clearSilence();
      rec.onresult = null;
      rec.onerror = null;
      rec.onend = null;
      try {
        rec.abort();
      } catch {
        /* ya detenido */
      }
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [runTurn, startListening, clearSilence]);

  const close = useCallback(() => {
    closedRef.current = true;
    onClose();
  }, [onClose]);

  const lastCortex = [...turns].reverse().find((t) => t.role === 'cortex');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-card border border-border bg-surface shadow-card">
        {/* Cabecera */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="font-semibold text-ink">Modo voz</span>
          <span className="ml-auto text-xs text-ink-faint">{PHASE_LABEL[phase]}</span>
          <button
            type="button"
            onClick={close}
            aria-label="Cerrar modo voz"
            className="ml-1 grid h-7 w-7 place-items-center rounded-full text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Cuerpo */}
        <div className="flex flex-col items-center gap-4 px-5 py-7">
          {supported === false ? (
            <p className="text-center text-sm text-ink-muted">
              Tu navegador no trae reconocimiento de voz (Firefox no lo tiene). Prueba en Chrome o
              Safari.
            </p>
          ) : (
            <>
              {/* El anillo que respira según la fase */}
              <div
                className={`grid h-24 w-24 place-items-center rounded-full transition-colors ${
                  phase === 'listening'
                    ? 'bg-primary-soft'
                    : phase === 'speaking'
                      ? 'bg-emerald-soft'
                      : 'bg-surface-2'
                }`}
              >
                <div
                  className={`grid h-16 w-16 place-items-center rounded-full ${
                    phase === 'listening'
                      ? 'animate-pulse bg-primary text-primary-ink'
                      : phase === 'speaking'
                        ? 'bg-emerald text-primary-ink'
                        : 'bg-surface text-ink-muted'
                  }`}
                >
                  {phase === 'thinking' ? (
                    <Loader2 className="h-6 w-6 animate-spin" />
                  ) : (
                    <Mic className="h-6 w-6" />
                  )}
                </div>
              </div>

              {/* Lo que se está oyendo o lo último que Cortex dijo */}
              <div className="min-h-[3.5rem] w-full text-center">
                {phase === 'listening' || phase === 'idle' ? (
                  <p className="text-sm text-ink">
                    {liveText || <span className="text-ink-faint">Di algo… «¿qué tengo hoy?»</span>}
                  </p>
                ) : phase === 'thinking' ? (
                  <p className="text-sm text-ink-faint">Cortex está pensando…</p>
                ) : lastCortex ? (
                  <p className="text-sm font-medium text-ink">{lastCortex.text}</p>
                ) : null}
              </div>

              {note ? <p className="text-center text-xs text-amber">{note}</p> : null}

              <p className="text-center text-xs text-ink-faint">
                Habla natural; cuando hagas una pausa, te respondo. Cierra cuando quieras.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
