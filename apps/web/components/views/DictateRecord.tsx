'use client';

import { clsx } from 'clsx';
import { Loader2, Mic, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SubmitTarget } from './ViewCanvas';

/**
 * «DICTAR REGISTRO»: el botón grande del formulario de una vista.
 *
 * El operario aprieta, dice el registro completo («guía siete veintinueve, uno
 * dos tres cuatro cinco seis siete cinco, vuelo AV204, cuatro piezas, llegó
 * hoy») y aprieta otra vez. Lo que se oyó va a /dictate, que devuelve valores
 * por campo; el formulario se llena y la persona revisa antes de Enviar. Igual
 * que el dictado del chat, nunca envía solo: un dígito mal oído en una guía es
 * justo el error que esta pantalla existe para atajar.
 *
 * Dos caminos según el navegador:
 *   - Con SpeechRecognition (Chrome, Safari, Edge): el navegador transcribe y
 *     se ve el texto mientras se habla; se manda TEXTO.
 *   - Sin él (Firefox, algunos Android viejos): se graba con MediaRecorder y
 *     se manda AUDIO; el servidor lo transcribe.
 * Si no hay ni lo uno ni lo otro, el botón no aparece: el formulario sigue
 * siendo un formulario.
 */

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((e: {
        resultIndex: number;
        results: { length: number; [i: number]: RecognitionResult };
      }) => void)
    | null;
  onerror: ((e: { error: string }) => void) | null;
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

function canRecord(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    !!navigator.mediaDevices?.getUserMedia
  );
}

/** Una grabación de más de esto ya no es un registro. */
const MAX_RECORD_MS = 45_000;

type Mode = 'speech' | 'record' | null;
type Phase = 'idle' | 'listening' | 'thinking';

export interface Dictated {
  values: Record<string, string>;
  missing: string[];
  heard: string;
}

export function DictateRecord({
  target,
  blockId,
  onDictated,
  className,
}: {
  target: SubmitTarget;
  blockId: string;
  onDictated: (d: Dictated) => void;
  className?: string;
}) {
  const [mode, setMode] = useState<Mode>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [live, setLive] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const textRef = useRef('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setMode(recognitionCtor() ? 'speech' : canRecord() ? 'record' : null);
    return () => {
      recognitionRef.current?.abort();
      for (const t of recorderRef.current?.stream.getTracks() ?? []) t.stop();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const endpoint =
    target.kind === 'app'
      ? `/api/views/${target.viewId}/dictate`
      : target.kind === 'public'
        ? '/api/views/public/dictate'
        : null;
  if (!endpoint || !mode) return null;

  async function send(payload: { text: string } | { audio: Blob }) {
    if (!endpoint) return;
    setPhase('thinking');
    const form = new FormData();
    form.set('blockId', blockId);
    if (target.kind === 'public') form.set('token', target.token);
    if ('text' in payload) form.set('text', payload.text);
    else form.set('audio', payload.audio, 'dictado.webm');
    try {
      const res = await fetch(endpoint, { method: 'POST', body: form });
      const body = (await res.json().catch(() => null)) as (Dictated & { error?: string }) | null;
      if (!res.ok || !body?.values) {
        setProblem(body?.error ?? 'No pude entender el dictado. Llena los campos a mano.');
      } else if (!Object.keys(body.values).length) {
        setProblem(`Oí «${body.heard}», pero no reconocí ningún campo. Intenta otra vez.`);
      } else {
        onDictated(body);
      }
    } catch {
      setProblem('Sin conexión. Inténtalo otra vez.');
    } finally {
      setPhase('idle');
      setLive('');
    }
  }

  function startSpeech() {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = 'es-CO';
    r.continuous = true;
    r.interimResults = true;
    textRef.current = '';
    r.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        const res = e.results[i];
        if (!res) continue;
        if (res.isFinal) textRef.current += ` ${res[0].transcript}`;
        else interim += res[0].transcript;
      }
      setLive(`${textRef.current} ${interim}`.trim());
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      setProblem(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'El navegador no dio permiso para el micrófono. Actívalo en el candado de la barra de direcciones.'
          : 'No se pudo dictar. Inténtalo otra vez.',
      );
    };
    r.onend = () => {
      if (recognitionRef.current !== r) return;
      recognitionRef.current = null;
      const said = textRef.current.trim();
      if (said) void send({ text: said });
      else setPhase('idle');
    };
    recognitionRef.current = r;
    try {
      r.start();
      setPhase('listening');
    } catch {
      setProblem('No se pudo abrir el micrófono.');
    }
  }

  async function startRecording() {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setProblem('El navegador no dio permiso para el micrófono.');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      for (const t of stream.getTracks()) t.stop();
      if (timerRef.current) clearTimeout(timerRef.current);
      recorderRef.current = null;
      const audio = new Blob(chunks, { type: (rec.mimeType || 'audio/webm').split(';')[0] });
      if (audio.size) void send({ audio });
      else setPhase('idle');
    };
    recorderRef.current = rec;
    rec.start();
    setPhase('listening');
    setLive('Grabando… di el registro completo y aprieta otra vez.');
    timerRef.current = setTimeout(() => rec.state === 'recording' && rec.stop(), MAX_RECORD_MS);
  }

  function toggle() {
    setProblem(null);
    if (phase === 'listening') {
      if (recognitionRef.current) recognitionRef.current.stop();
      else if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      return;
    }
    if (mode === 'speech') startSpeech();
    else void startRecording();
  }

  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      <button
        type="button"
        onClick={toggle}
        disabled={phase === 'thinking'}
        aria-pressed={phase === 'listening'}
        className={clsx(
          'inline-flex min-h-14 w-full items-center justify-center gap-3 rounded-xl border-2 px-5 text-base font-bold transition-colors duration-150 disabled:opacity-60',
          phase === 'listening'
            ? 'border-rose bg-rose-soft text-rose'
            : 'border-primary/40 bg-primary/5 text-primary hover:bg-primary/10',
        )}
      >
        {phase === 'thinking' ? (
          <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        ) : phase === 'listening' ? (
          <Square className="h-5 w-5 fill-current" aria-hidden />
        ) : (
          <Mic className="h-5 w-5" aria-hidden />
        )}
        {phase === 'thinking'
          ? 'Llenando el formulario…'
          : phase === 'listening'
            ? 'Terminar y llenar'
            : 'Dictar registro'}
      </button>
      <output aria-live="polite" className="min-h-0 text-xs leading-relaxed text-ink-muted">
        {phase === 'listening' && (live || 'Escuchando… di todos los datos de una vez.')}
      </output>
      {problem && (
        <p role="alert" className="text-xs text-rose">
          {problem}
        </p>
      )}
    </div>
  );
}
