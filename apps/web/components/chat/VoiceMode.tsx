'use client';

import { CortexSignature } from '@/components/ui/cortex-signature';
import { VOICE_SESSION_MS, readVoiceText } from '@/lib/voice-realtime';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowUpRight, Mic, MicOff, PhoneOff, Square, Volume2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LegacyVoiceMode } from './LegacyVoiceMode';

type RealtimeEvent = {
  type: string;
  transcript?: string;
  item_id?: string;
  delta?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  item?: { type?: string; name?: string; call_id?: string; arguments?: string };
  error?: { code?: string };
};

type Turn = { role: 'you' | 'cortex'; text: string; id?: string };
type Phase = 'idle' | 'connecting' | 'listening' | 'thinking' | 'consulting' | 'speaking' | 'error';
const labels: Record<Phase, string> = {
  idle: 'Conversemos.',
  connecting: 'Conectando tu voz…',
  listening: 'Te escucho.',
  thinking: 'Un momento…',
  consulting: 'Consultando a Cortex…',
  speaking: 'Cortex está hablando.',
  error: 'Retomemos la conexión.',
};

export function VoiceMode({
  onClose,
  history = [],
  spaceIds = [],
  onCompose,
}: {
  onClose: () => void;
  history?: Turn[];
  spaceIds?: string[];
  onCompose?: (text: string) => void;
}) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [muted, setMuted] = useState(false);
  const [note, setNote] = useState('');
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [transcript, setTranscript] = useState<Turn[]>([]);
  const [legacy, setLegacy] = useState(false);
  const peer = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const aborts = useRef(new Set<AbortController>());
  const sequence = useRef(0);
  const speakingEpoch = useRef(0);
  const connectionDeadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | null>(null);
  const animation = useRef(0);
  const orb = useRef<HTMLDivElement>(null);
  const turns = useRef<Turn[]>(history.slice(-10));

  const dispose = useCallback(() => {
    sequence.current++;
    if (deadline.current) clearTimeout(deadline.current);
    if (connectionDeadline.current) clearTimeout(connectionDeadline.current);
    cancelAnimationFrame(animation.current);
    for (const controller of aborts.current) controller.abort();
    aborts.current.clear();
    channel.current?.close();
    channel.current = null;
    peer.current?.close();
    peer.current = null;
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    if (audio.current) {
      audio.current.pause();
      audio.current.srcObject = null;
    }
    if (audioContext.current) void audioContext.current.close().catch(() => {});
    audioContext.current = null;
    orb.current?.style.setProperty('--voice-level', '0');
  }, []);
  useEffect(() => dispose, [dispose]);

  const connect = async () => {
    dispose();
    const generation = sequence.current;
    setPhase('connecting');
    setNote('');
    setMuted(false);
    setAudioBlocked(false);
    const alive = () => generation === sequence.current;
    const controller = new AbortController();
    aborts.current.add(controller);
    let connectingTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection)
        throw new Error(
          'Este navegador no permite llamadas de voz. Prueba con un navegador actualizado.',
        );
      const context = new AudioContext();
      audioContext.current = context;
      await context.resume();
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (!alive()) {
        for (const track of mic.getTracks()) track.stop();
        return;
      }
      stream.current = mic;
      const pc = new RTCPeerConnection();
      peer.current = pc;
      const input = context.createAnalyser();
      input.fftSize = 256;
      context.createMediaStreamSource(mic).connect(input);
      const output = context.createAnalyser();
      output.fftSize = 256;
      const samples = new Uint8Array(256);
      const level = (analyser: AnalyserNode) => {
        analyser.getByteTimeDomainData(samples);
        return Math.sqrt(
          samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length,
        );
      };
      const animate = () => {
        if (!alive()) return;
        if (!document.hidden)
          orb.current?.style.setProperty(
            '--voice-level',
            String(Math.min(1, Math.max(level(input), level(output)) * 5)),
          );
        animation.current = requestAnimationFrame(animate);
      };
      animate();
      pc.ontrack = (event) => {
        if (!alive()) return;
        const remote = event.streams[0] ?? new MediaStream([event.track]);
        context.createMediaStreamSource(remote).connect(output);
        if (audio.current) {
          audio.current.srcObject = remote;
          void audio.current.play().catch(() => {
            if (alive()) setAudioBlocked(true);
          });
        }
      };
      const fail = (message: string) => {
        if (!alive()) return;
        dispose();
        setNote(message);
        setPhase('error');
      };
      pc.onconnectionstatechange = () => {
        if (!alive()) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected')
          fail('Se perdió la conexión. Tu micrófono se ha cerrado; puedes volver a conectar.');
      };
      for (const track of mic.getAudioTracks()) pc.addTrack(track, mic);
      const dc = pc.createDataChannel('oai-events');
      channel.current = dc;
      const send = (event: unknown) => {
        if (alive() && dc.readyState === 'open') dc.send(JSON.stringify(event));
      };

      const calls = new Set<string>();
      const addTurn = (turn: Turn) => {
        turns.current = [...turns.current, turn].slice(-12);
        setTranscript((previous) =>
          [...previous.filter((item) => !turn.id || item.id !== turn.id), turn].slice(-20),
        );
      };
      dc.onopen = () => {
        if (!alive()) return;
        clearTimeout(connectingTimer);
        setPhase('listening');
        deadline.current = setTimeout(
          () => fail('Terminó esta sesión de 15 minutos. Puedes abrir otra cuando quieras.'),
          VOICE_SESSION_MS,
        );
      };
      dc.onclose = () => {
        if (alive()) fail('La llamada terminó. Puedes volver a conectar.');
      };
      dc.onmessage = async (message) => {
        if (!alive()) return;
        let event: RealtimeEvent;
        try {
          event = JSON.parse(message.data);
        } catch {
          return;
        }
        if (!event || typeof event.type !== 'string') return;
        if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
          event = { ...event.item, type: 'response.function_call_arguments.done' };
        }
        switch (event.type) {
          case 'input_audio_buffer.speech_started':
            speakingEpoch.current++;
            setPhase('listening');
            break;
          case 'response.created':
            setPhase('thinking');
            break;
          case 'output_audio_buffer.started':
            setPhase('speaking');
            break;
          case 'output_audio_buffer.stopped':
            setPhase('listening');
            break;
          case 'conversation.item.input_audio_transcription.completed':
            if (event.transcript)
              addTurn({ role: 'you', text: event.transcript, id: event.item_id });
            break;
          case 'response.output_audio_transcript.delta':
            setTranscript((previous) => {
              const found = previous.find((item) => item.id === event.item_id);
              return [
                ...previous.filter((item) => item.id !== event.item_id),
                {
                  role: 'cortex' as const,
                  id: event.item_id,
                  text: (found?.text ?? '') + (event.delta ?? ''),
                },
              ].slice(-20);
            });
            break;
          case 'response.output_audio_transcript.done':
            if (event.transcript)
              addTurn({ role: 'cortex', text: event.transcript, id: event.item_id });
            break;
          case 'response.function_call_arguments.done': {
            if (
              event.name !== 'consult_cortex' ||
              !event.call_id ||
              !event.arguments ||
              calls.has(event.call_id)
            )
              return;
            calls.add(event.call_id);
            setPhase('consulting');
            const epoch = speakingEpoch.current;
            const task = new AbortController();
            aborts.current.add(task);
            let result: string;
            try {
              const args = JSON.parse(event.arguments);
              if (
                typeof args.question !== 'string' ||
                !args.question.trim() ||
                args.question.length > 1000
              )
                throw new Error('La consulta necesita una pregunta de hasta 1.000 caracteres.');
              const response = await fetch('/api/voice/turn', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  question: args.question,
                  history: turns.current.map(({ role, text }) => ({
                    role,
                    text: text.slice(0, 2000),
                  })),
                  textOnly: true,
                  spaceIds,
                }),
                signal: AbortSignal.any([task.signal, AbortSignal.timeout(60_000)]),
              });
              result = await readVoiceText(response);
            } catch (error) {
              result = `No se completó la consulta: ${(error as Error).message}. No confirmes ninguna acción.`;
            } finally {
              aborts.current.delete(task);
            }
            if (!alive()) return;
            send({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: event.call_id,
                output: result.slice(0, 16000),
              },
            });
            if (epoch === speakingEpoch.current) send({ type: 'response.create' });
            break;
          }
          case 'error':
            if (event.error?.code === 'response_cancel_not_active') break;
            setNote('La voz encontró un problema. Puedes interrumpir o volver a conectar.');
            break;
        }
      };
      connectingTimer = setTimeout(
        () => fail('La conexión tardó demasiado. Intenta de nuevo.'),
        25_000,
      );
      connectionDeadline.current = connectingTimer;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      const response = await fetch('/api/voice/realtime', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sdp: offer.sdp,
          history: turns.current.map(({ role, text }) => ({ role, text: text.slice(0, 2000) })),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'No se pudo conectar.');
      }
      const sdp = await response.text();
      if (alive()) await pc.setRemoteDescription({ type: 'answer', sdp });
    } catch (error) {
      if (!alive()) return;
      clearTimeout(connectingTimer);
      dispose();
      setPhase('error');
      setNote(
        (error as Error).name === 'NotAllowedError'
          ? 'Activa el permiso de micrófono en tu navegador para conversar.'
          : (error as Error).message,
      );
    } finally {
      aborts.current.delete(controller);
    }
  };
  const connected = !['idle', 'connecting', 'error'].includes(phase);
  const interrupt = () => {
    speakingEpoch.current++;
    for (const task of aborts.current) task.abort();
    if (channel.current?.readyState !== 'open') return;
    channel.current.send(JSON.stringify({ type: 'response.cancel' }));
    channel.current.send(JSON.stringify({ type: 'output_audio_buffer.clear' }));
    setPhase('listening');
  };
  if (legacy) return <LegacyVoiceMode onClose={onClose} />;
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
        <Dialog.Overlay className="voice-veil" />
        <Dialog.Content className="voice-room" aria-describedby="voice-description">
          <header className="voice-room__header">
            <span>Cortex / Conversación de voz</span>
            <Dialog.Close asChild>
              <button type="button" aria-label="Cerrar modo voz">
                <X size={20} />
              </button>
            </Dialog.Close>
          </header>
          <div className="voice-room__layout">
            <div className="voice-room__stage">
              <div
                ref={orb}
                className="voice-orb"
                data-phase={phase}
                data-muted={muted}
                aria-hidden="true"
              >
                <i />
                <i />
                <i />
                <CortexSignature />
              </div>
              <Dialog.Title>
                {muted && connected ? 'Micrófono en silencio.' : labels[phase]}
              </Dialog.Title>
              <Dialog.Description id="voice-description">
                {connected
                  ? 'Habla con naturalidad. Puedes interrumpir a Cortex cuando lo necesites.'
                  : 'Una conversación con voz de IA. Al conectar, tu audio se transmite a OpenAI para responder en tiempo real.'}
              </Dialog.Description>
              {note && (
                <p className="voice-note" role="alert">
                  {note}
                </p>
              )}
              {audioBlocked && (
                <button
                  type="button"
                  className="voice-start"
                  onClick={() =>
                    void audio.current
                      ?.play()
                      .then(() => setAudioBlocked(false))
                      .catch(() =>
                        setNote('El navegador no permitió reproducir audio. Revisa sus permisos.'),
                      )
                  }
                >
                  <Volume2 size={17} /> Activar audio
                </button>
              )}
              <div className="voice-controls">
                {connected ? (
                  <>
                    <button
                      type="button"
                      aria-pressed={muted}
                      aria-label={muted ? 'Activar micrófono' : 'Silenciar micrófono'}
                      onClick={() => {
                        for (const track of stream.current?.getAudioTracks() ?? [])
                          track.enabled = muted;
                        setMuted(!muted);
                      }}
                    >
                      <span>{muted ? <MicOff /> : <Mic />}</span>
                      {muted ? 'Activar' : 'Silenciar'}
                    </button>
                    <button type="button" onClick={interrupt}>
                      <span>
                        <Square size={19} />
                      </span>
                      Interrumpir
                    </button>
                    <button
                      type="button"
                      className="voice-end"
                      onClick={() => {
                        dispose();
                        setPhase('idle');
                      }}
                    >
                      <span>
                        <PhoneOff />
                      </span>
                      Terminar
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="voice-start"
                    disabled={phase === 'connecting'}
                    onClick={() => void connect()}
                  >
                    <Mic size={19} />
                    {phase === 'connecting' ? 'Conectando…' : 'Conectar mi voz'}
                  </button>
                )}
              </div>
              {!connected && phase !== 'connecting' && (
                <button
                  type="button"
                  className="voice-compatible"
                  onClick={() => {
                    dispose();
                    setLegacy(true);
                  }}
                >
                  Usar modo compatible
                </button>
              )}
            </div>
            <aside className="voice-transcript">
              <h3>La conversación, a la vista.</h3>
              <p className="voice-transcript__hint">
                Transcripción de esta sesión. Revísala antes de llevarla al chat.
              </p>
              <div className="voice-transcript__turns">
                {transcript.length ? (
                  transcript.map((turn, i) => (
                    <div key={turn.id ?? i} data-role={turn.role}>
                      <span>{turn.role === 'you' ? 'Tú' : 'Cortex'}</span>
                      <p>{turn.text}</p>
                    </div>
                  ))
                ) : (
                  <p className="voice-transcript__empty">
                    Tus palabras y las respuestas aparecerán aquí.
                  </p>
                )}
              </div>
              {onCompose && transcript.length > 0 && (
                <button
                  type="button"
                  className="voice-to-chat"
                  onClick={() => {
                    onCompose(
                      `Retomemos esta conversación de voz:\n\n${transcript.map((turn) => `${turn.role === 'you' ? 'Yo' : 'Cortex'}: ${turn.text}`).join('\n\n')}`,
                    );
                    dispose();
                    onClose();
                  }}
                >
                  Llevar al borrador del chat <ArrowUpRight size={15} />
                </button>
              )}
            </aside>
          </div>
          {/* WebRTC audio is played directly; the analyser never feeds the microphone to speakers. */}
          {/* biome-ignore lint/a11y/useMediaCaption: Live captions are rendered in the adjacent transcript; WebRTC has no caption file. */}
          <audio ref={audio} autoPlay />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
