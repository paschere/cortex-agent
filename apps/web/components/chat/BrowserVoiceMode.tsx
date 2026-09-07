'use client';

import { CortexSignature } from '@/components/ui/cortex-signature';
import { VOICE_SESSION_MS } from '@/lib/voice-realtime';
import * as Dialog from '@radix-ui/react-dialog';
import { Mic, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  abort(): void;
  onresult:
    | ((event: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};
type SpeechWindow = Window & {
  SpeechRecognition?: new () => Recognition;
  webkitSpeechRecognition?: new () => Recognition;
};

/** Browser audio, but the same authorized chat transport and approval cards. */
export function BrowserVoiceMode({
  consult,
  scopeLabel,
  onClose,
}: {
  consult: (question: string, signal: AbortSignal) => Promise<string>;
  scopeLabel?: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<'idle' | 'listening' | 'thinking' | 'speaking' | 'error'>(
    'idle',
  );
  const [supported, setSupported] = useState(false);
  const [heard, setHeard] = useState('');
  const [reply, setReply] = useState('');
  const [note, setNote] = useState('');
  const recognition = useRef<Recognition | null>(null);
  const request = useRef<AbortController | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const transport = useRef(consult);
  transport.current = consult;

  const dispose = useCallback(() => {
    generation.current++;
    recognition.current?.abort();
    recognition.current = null;
    request.current?.abort();
    request.current = null;
    if (utterance.current) {
      utterance.current.onend = null;
      utterance.current.onerror = null;
      utterance.current = null;
    }
    window.speechSynthesis?.cancel();
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => {
    const browser = window as SpeechWindow;
    setSupported(
      Boolean(
        (browser.SpeechRecognition || browser.webkitSpeechRecognition) && window.speechSynthesis,
      ),
    );
    return dispose;
  }, [dispose]);

  function listen(epoch: number) {
    if (epoch !== generation.current) return;
    const browser = window as SpeechWindow;
    const Constructor = browser.SpeechRecognition || browser.webkitSpeechRecognition;
    if (!Constructor) return;
    const rec = new Constructor();
    recognition.current = rec;
    rec.lang = 'es-CO';
    rec.continuous = false;
    rec.interimResults = true;
    let finalText = '';
    setHeard('');
    setPhase('listening');
    rec.onresult = (event) => {
      if (epoch !== generation.current) return;
      const results = Array.from(event.results);
      finalText = results
        .filter((result) => result.isFinal)
        .map((result) => result[0].transcript)
        .join(' ');
      setHeard(results.map((result) => result[0].transcript).join(' '));
    };
    rec.onerror = (event) => {
      if (epoch !== generation.current) return;
      dispose();
      setPhase('error');
      setNote(
        event.error === 'not-allowed'
          ? 'Activa el permiso de micrófono para conversar.'
          : 'No se pudo escuchar. Pulsa Hablar para intentarlo de nuevo.',
      );
    };
    rec.onend = () => {
      if (epoch !== generation.current) return;
      recognition.current = null;
      if (!finalText.trim()) {
        setPhase('idle');
        return;
      }
      void respond(finalText.trim(), epoch);
    };
    try {
      rec.start();
    } catch {
      dispose();
      setPhase('error');
      setNote('No se pudo iniciar el micrófono. Intenta de nuevo.');
    }
  }

  async function respond(question: string, epoch: number) {
    setPhase('thinking');
    const controller = new AbortController();
    request.current = controller;
    try {
      const answer = await transport.current(
        question,
        AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      );
      if (epoch !== generation.current) return;
      request.current = null;
      setReply(answer);
      const spoken = answer
        .replace(/```[\s\S]*?```/g, ' Hay un bloque de código disponible en el chat. ')
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/[#*_`]/g, '')
        .slice(0, 6000)
        .trim();
      if (!spoken) {
        setPhase('idle');
        return;
      }
      const speech = new SpeechSynthesisUtterance(spoken);
      utterance.current = speech;
      speech.lang = 'es-CO';
      const voices = window.speechSynthesis.getVoices();
      const voice =
        voices.find((item) => item.lang === 'es-CO') ??
        voices.find((item) => item.lang.startsWith('es'));
      if (voice) speech.voice = voice;
      speech.onend = () => {
        if (utterance.current === speech) utterance.current = null;
        if (epoch === generation.current) listen(epoch);
      };
      speech.onerror = () => {
        if (epoch !== generation.current) return;
        if (utterance.current === speech) utterance.current = null;
        dispose();
        setPhase('error');
        setNote('La respuesta quedó en el chat, pero no se pudo reproducir.');
      };
      setPhase('speaking');
      window.speechSynthesis.speak(speech);
    } catch (error) {
      if (epoch !== generation.current) return;
      dispose();
      setPhase('error');
      setNote(
        error instanceof Error
          ? error.message
          : 'La consulta no terminó. Revisa el chat antes de repetir una acción.',
      );
    }
  }

  const active = ['listening', 'thinking', 'speaking'].includes(phase);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          dispose();
          onClose();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="voice-backdrop" />
        <Dialog.Content className="voice-room" aria-describedby="browser-voice-description">
          <header className="voice-room__header">
            <span>Cortex / Voz del navegador</span>
            <Dialog.Close className="voice-close" aria-label="Cerrar modo voz">
              <X size={19} />
            </Dialog.Close>
          </header>
          <div className="voice-room__layout">
            <div className="voice-room__stage">
              <div className="voice-orb" data-phase={phase} aria-hidden="true">
                <i />
                <i />
                <i />
                <CortexSignature />
              </div>
              <Dialog.Title>
                {phase === 'listening'
                  ? 'Te escucho.'
                  : phase === 'thinking'
                    ? 'Consultando a Cortex…'
                    : phase === 'speaking'
                      ? 'Cortex está hablando.'
                      : 'Hablemos.'}
              </Dialog.Title>
              <Dialog.Description id="browser-voice-description">
                Tu navegador transcribe y reproduce la voz; puede utilizar servicios de su
                proveedor. El texto se consulta en este mismo chat.
              </Dialog.Description>
              {scopeLabel && <p className="voice-note">Alcance: {scopeLabel}</p>}
              {note && (
                <output className="voice-note mx-auto mt-4 block max-w-sm text-xs leading-relaxed">
                  {note}
                </output>
              )}
              {!supported && (
                <p className="voice-note">
                  Este navegador no admite esta opción. Puedes seguir escribiendo o dictando en el
                  chat.
                </p>
              )}
              <div className="voice-controls">
                {active ? (
                  <button
                    type="button"
                    onClick={() => {
                      dispose();
                      setPhase('idle');
                    }}
                  >
                    <span>
                      <Square size={18} />
                    </span>
                    Pausar
                  </button>
                ) : (
                  <button
                    type="button"
                    className="voice-start"
                    disabled={!supported}
                    onClick={() => {
                      dispose();
                      setNote('');
                      const epoch = generation.current;
                      timer.current = setTimeout(() => {
                        dispose();
                        setPhase('idle');
                        setNote('La sesión terminó. Puedes iniciar otra cuando quieras.');
                      }, VOICE_SESSION_MS);
                      listen(epoch);
                    }}
                  >
                    <Mic size={18} />
                    Hablar
                  </button>
                )}
              </div>
            </div>
            <aside className="voice-transcript">
              <h3>La conversación, a la vista.</h3>
              <p>
                Las consultas y respuestas quedan en el chat. Las acciones requieren su aprobación
                allí.
              </p>
              <div className="max-h-72 space-y-4 overflow-y-auto text-sm leading-relaxed">
                <p>{heard || 'Tus palabras aparecerán aquí.'}</p>
                {reply && <p>{reply}</p>}
              </div>
            </aside>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
