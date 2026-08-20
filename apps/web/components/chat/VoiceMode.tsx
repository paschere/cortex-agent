'use client';

import { Loader2, Mic, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * MODO VOZ MANOS LIBRES — hablar con Cortex como una llamada, con streaming.
 *
 * ===========================================================================
 * EL LOOP
 * ===========================================================================
 * Abres el modo, hablas, Cortex nota que terminaste (un silencio corto tras la
 * última palabra), y responde EN VOZ mientras aún está pensando: el servidor
 * (/api/voice/turn) le manda frase por frase el audio ya sintetizado, y aquí se
 * reproduce en cola, sin cortes, en cuanto llega la primera. Time-to-first-word
 * de ~un segundo en vez de esperar el turno entero. Al terminar, vuelve a
 * escuchar. Sin tocar nada entre medias.
 *
 * ===========================================================================
 * LA TRANSCRIPCIÓN ES DEL NAVEGADOR — Y ESO DECIDE DÓNDE VIVE ESTO
 * ===========================================================================
 * Lo que TÚ dices lo transcribe `SpeechRecognition`, que ya vive en el
 * navegador (el mismo del dictado): sin subir tu voz, sin llave, sin factura por
 * escuchar. El precio es Firefox, que no lo trae — ahí el modo no se ofrece.
 * Solo la VOZ DE CORTEX pasa por Deepgram.
 *
 * ===========================================================================
 * EL AUDIO SE ENCOLA CON WEB AUDIO, NO CON <audio>
 * ===========================================================================
 * Cada frase llega como su propio mp3. Reproducirlas con un `<audio>` tras otro
 * deja un hueco audible entre frases. En su lugar se decodifican a AudioBuffer
 * y se programan una tras otra en un AudioContext (`nextStart`), así suenan
 * pegadas como una sola voz. Mientras Cortex habla, el reconocedor se DETIENE, y
 * se reanuda cuando la cola se vacía — si no, el micrófono lo oiría y le
 * contestaría a Cortex.
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
const END_OF_TURN_MS = 800;

const PHASE_LABEL: Record<Phase, string> = {
  idle: 'Preparando…',
  listening: 'Te escucho…',
  thinking: 'Pensando…',
  speaking: 'Cortex habla',
  error: 'Algo salió mal',
};

function b64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export function VoiceMode({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [supported, setSupported] = useState<boolean | null>(null);
  const [liveText, setLiveText] = useState('');
  const [reply, setReply] = useState('');
  const [note, setNote] = useState<string | null>(null);

  const recRef = useRef<Recognition | null>(null);
  const wantListenRef = useRef(false);
  const finalRef = useRef('');
  const silenceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyRef = useRef<Turn[]>([]);
  const closedRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  // Cola de audio (Web Audio). `pending` cuenta buffers aún sonando; cuando el
  // stream terminó y no queda ninguno, se vuelve a escuchar.
  const ctxRef = useRef<AudioContext | null>(null);
  const nextStartRef = useRef(0);
  const pendingRef = useRef(0);
  const streamDoneRef = useRef(false);

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

  // Cuando el stream acabó y la cola de audio se vació, volvemos a escuchar.
  const maybeResume = useCallback(() => {
    if (closedRef.current) return;
    if (streamDoneRef.current && pendingRef.current <= 0) startListening();
  }, [startListening]);

  const enqueueAudio = useCallback(
    async (b64: string) => {
      if (closedRef.current) return;
      let ctx = ctxRef.current;
      if (!ctx) {
        ctx = new (
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
        )();
        ctxRef.current = ctx;
      }
      if (ctx.state === 'suspended') await ctx.resume();
      let buffer: AudioBuffer;
      try {
        buffer = await ctx.decodeAudioData(b64ToArrayBuffer(b64));
      } catch {
        return;
      }
      if (closedRef.current) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      // Programa cada frase justo tras la anterior; si la cola se vació, arranca
      // ya (con un pelín de margen para no cortar el ataque).
      const at = Math.max(ctx.currentTime + 0.02, nextStartRef.current);
      pendingRef.current += 1;
      src.onended = () => {
        pendingRef.current -= 1;
        maybeResume();
      };
      src.start(at);
      nextStartRef.current = at + buffer.duration;
    },
    [maybeResume],
  );

  // El turno: paramos de oír, pedimos la respuesta en streaming, la hablamos
  // frase por frase, y cuando el audio se acaba volvemos a escuchar.
  const runTurn = useCallback(
    async (said: string) => {
      const question = said.trim();
      if (!question || closedRef.current) return;
      clearSilence();
      wantListenRef.current = false;
      recRef.current?.stop();

      setLiveText('');
      setReply('');
      setNote(null);
      historyRef.current = [...historyRef.current, { role: 'you', text: question }];
      setPhase('thinking');

      // Reinicia la cola de audio para este turno.
      streamDoneRef.current = false;
      pendingRef.current = 0;
      nextStartRef.current = 0;

      const controller = new AbortController();
      abortRef.current = controller;
      let full = '';
      let firstChunk = true;

      try {
        const res = await fetch('/api/voice/turn', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question, history: historyRef.current.slice(-12) }),
          signal: controller.signal,
        });
        if (res.status === 402) {
          wantListenRef.current = false;
          setPhase('error');
          setNote('El modo voz es una función premium. Habla con tu administrador para activarla.');
          return;
        }
        if (!res.ok || !res.body) {
          setPhase('error');
          setNote('No pude responder ahora mismo.');
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let sse = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done || closedRef.current) break;
          sse += decoder.decode(value, { stream: true });
          let sep = sse.indexOf('\n\n');
          while (sep >= 0) {
            const block = sse.slice(0, sep);
            sse = sse.slice(sep + 2);
            sep = sse.indexOf('\n\n');
            const event = /event: (.*)/.exec(block)?.[1]?.trim();
            const dataRaw = /data: (.*)/.exec(block)?.[1];
            if (!event || dataRaw === undefined) continue;
            let data: { text?: string; b64?: string; message?: string } = {};
            try {
              data = JSON.parse(dataRaw);
            } catch {
              continue;
            }
            if (event === 'text' && data.text) {
              if (firstChunk) {
                firstChunk = false;
                setPhase('speaking');
              }
              full = `${full} ${data.text}`.trim();
              setReply(full);
            } else if (event === 'audio' && data.b64) {
              void enqueueAudio(data.b64);
            } else if (event === 'error') {
              setNote(data.message ?? 'Algo se cortó.');
            }
          }
        }
      } catch {
        if (!closedRef.current) {
          setPhase('error');
          setNote('Se me cayó la conexión un momento.');
        }
      } finally {
        abortRef.current = null;
      }

      if (closedRef.current) return;
      if (full) historyRef.current = [...historyRef.current, { role: 'cortex', text: full }];

      // El stream terminó. Si hubo audio, `maybeResume` reanudará la escucha
      // cuando la última frase acabe de sonar; si no hubo (sin voz), reanuda ya.
      streamDoneRef.current = true;
      if (pendingRef.current <= 0) {
        if (!full) setNote((n) => n ?? 'No estoy seguro de eso.');
        startListening();
      }
    },
    [clearSilence, enqueueAudio, startListening],
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
      clearSilence();
      if (finalRef.current) {
        silenceTimer.current = setTimeout(() => void runTurn(finalRef.current), END_OF_TURN_MS);
      }
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        setNote('Necesito permiso del micrófono para el modo voz.');
        setPhase('error');
        wantListenRef.current = false;
      }
    };
    rec.onend = () => {
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
      abortRef.current?.abort();
      void ctxRef.current?.close().catch(() => undefined);
      ctxRef.current = null;
    };
  }, [runTurn, startListening, clearSilence]);

  const close = useCallback(() => {
    closedRef.current = true;
    onClose();
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md overflow-hidden rounded-card border border-border bg-surface shadow-card">
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

        <div className="flex flex-col items-center gap-4 px-5 py-7">
          {supported === false ? (
            <p className="text-center text-sm text-ink-muted">
              Tu navegador no trae reconocimiento de voz (Firefox no lo tiene). Prueba en Chrome o
              Safari.
            </p>
          ) : (
            <>
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

              <div className="min-h-[3.5rem] w-full text-center">
                {phase === 'listening' || phase === 'idle' ? (
                  <p className="text-sm text-ink">
                    {liveText || <span className="text-ink-faint">Di algo… «¿qué tengo hoy?»</span>}
                  </p>
                ) : phase === 'thinking' ? (
                  <p className="text-sm text-ink-faint">Cortex está pensando…</p>
                ) : reply ? (
                  <p className="text-sm font-medium text-ink">{reply}</p>
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
