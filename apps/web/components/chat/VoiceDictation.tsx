'use client';

import { clsx } from 'clsx';
import { Mic, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * DICTAR EN VEZ DE ESCRIBIR.
 *
 * ===========================================================================
 * WHY THIS EARNS A BUTTON WHEN ALMOST NOTHING ELSE DOES
 * ===========================================================================
 * The person this product is for is standing in a bodega with a clipboard in
 * one hand and a phone in the other. Typing "¿a qué vehículos se les vencen
 * papeles este mes?" on a phone keyboard while holding something is not a
 * slower path to the answer, it is no path at all — the question just does not
 * get asked. That is the bar a control has to clear to sit in the composer, and
 * this is the only candidate left that clears it.
 *
 * ===========================================================================
 * THE BROWSER'S OWN, AND NOTHING ELSE
 * ===========================================================================
 * `SpeechRecognition` ships in the browser. The alternative — recording audio
 * and posting it to a transcription service — means a new key, a new bill, a
 * new upload path for someone's voice, and a new place where a private question
 * is stored. For a typing aid. So: no network call, no recording kept, nothing
 * to configure, and the audio never touches Cortex.
 *
 * The price is that Firefox has no implementation. The button therefore does
 * not render there AT ALL — a mic that greys out or throws "no compatible" is a
 * broken promise on every visit, while a composer without one is simply a
 * composer. That feature detection is also the off switch: nothing else in the
 * chat knows this exists.
 *
 * ===========================================================================
 * IT WRITES INTO THE BOX, IT DOES NOT SEND
 * ===========================================================================
 * Dictation lands in the textarea and stops there. Speech recognition mishears
 * plates and NITs — the two things in this product that must be exactly right —
 * so the person reads it before it goes. Sending on silence would turn every
 * misheard digit into a question Cortex answered confidently about the wrong
 * truck.
 */

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

export function VoiceDictation({
  disabled,
  getBaseText,
  onText,
}: {
  disabled?: boolean;
  /** The composer's current text, read at the moment dictation starts. */
  getBaseText: () => string;
  onText: (next: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  const baseRef = useRef('');
  const finalRef = useRef('');

  // Detected after mount so the server and the first client render agree.
  useEffect(() => {
    setSupported(recognitionCtor() !== null);
  }, []);

  const stop = useCallback(() => {
    recognitionRef.current?.stop();
    setListening(false);
  }, []);

  // A recogniser left running when the composer unmounts keeps the microphone
  // indicator on in the browser chrome, which reads as the app listening to you
  // after you left the page.
  useEffect(() => {
    return () => recognitionRef.current?.abort();
  }, []);

  useEffect(() => {
    if (disabled && listening) stop();
  }, [disabled, listening, stop]);

  // The message says what to do about it once; a line that stays forever next
  // to the send button becomes part of the furniture and stops being read.
  useEffect(() => {
    if (!problem) return;
    const timer = setTimeout(() => setProblem(null), 8000);
    return () => clearTimeout(timer);
  }, [problem]);

  function start() {
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    setProblem(null);

    const recognition = new Ctor();
    recognition.lang = 'es-CO';
    recognition.continuous = true;
    recognition.interimResults = true;

    const base = getBaseText();
    baseRef.current = base && !base.endsWith(' ') ? `${base} ` : base;
    finalRef.current = '';

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (!result) continue;
        const said = result[0].transcript;
        if (result.isFinal) finalRef.current += said;
        else interim += said;
      }
      onText(`${baseRef.current}${finalRef.current}${interim}`);
    };

    recognition.onerror = (event) => {
      // Silence is not a failure — Chrome fires `no-speech` whenever somebody
      // pauses to think, and a red line for that would train people to ignore
      // the line that matters.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      setProblem(
        event.error === 'not-allowed' || event.error === 'service-not-allowed'
          ? 'El navegador no dio permiso para el micrófono. Actívalo en el candado de la barra de direcciones.'
          : 'No se pudo dictar. Vuelve a intentarlo o escribe la pregunta.',
      );
      setListening(false);
    };

    recognition.onend = () => setListening(false);

    recognitionRef.current = recognition;
    try {
      recognition.start();
      setListening(true);
    } catch {
      setProblem('No se pudo abrir el micrófono.');
    }
  }

  if (!supported) return null;

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => (listening ? stop() : start())}
        aria-pressed={listening}
        aria-label={listening ? 'Dejar de dictar' : 'Dictar la pregunta'}
        title={listening ? 'Dejar de dictar' : 'Dictar la pregunta'}
        className={clsx(
          'grid h-8 w-8 place-items-center rounded-full transition-colors duration-150 disabled:opacity-40 motion-reduce:transition-none',
          listening
            ? 'bg-rose-soft text-rose ring-1 ring-inset ring-rose/30'
            : 'text-ink-faint hover:bg-surface-2 hover:text-ink',
        )}
      >
        {listening ? (
          <Square className="h-3.5 w-3.5 fill-current" aria-hidden />
        ) : (
          <Mic className="h-4 w-4" aria-hidden />
        )}
      </button>

      {/*
        One live region for both states. It is `sr-only` because the button
        already turns red and the words are already appearing in the box — this
        exists so that somebody who sees neither is told the microphone is on.
      */}
      <span role="status" aria-live="polite" className="sr-only">
        {problem ?? (listening ? 'Micrófono abierto. Dicta tu pregunta.' : '')}
      </span>

      {problem && (
        <span className="max-w-[16rem] truncate text-[11px] text-rose" title={problem}>
          {problem}
        </span>
      )}
    </>
  );
}
