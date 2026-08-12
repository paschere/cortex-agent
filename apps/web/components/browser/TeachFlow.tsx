'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import {
  ACTION_LABEL,
  EFFECT_LABEL,
  MODULE,
  type Proposal,
  TARGET_LABEL,
  TARGET_WHY,
  alreadyConnected,
  DEFAULT_DELIVERY,
  type FlowDelivery,
  proposeOutput,
} from '@/lib/browser-shape';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { CaptureContract } from '@/components/privacy/CaptureContract';
import {
  AlertTriangle,
  ChevronDown,
  Circle,
  Loader2,
  Pause,
  Play,
  Plug,
  Square,
  Video,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DeliveryFields } from './DeliveryFields';
import {
  type CapturedFrame,
  NotATabError,
  type RecorderHandle,
  canRecordTab,
  startTabRecording,
} from '@/lib/tab-recorder';

/**
 * Enseñar un trámite: grabar la pestaña, revisar lo que Cortex entendió,
 * guardarlo y dejar que se pruebe solo.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES OUTSIDE THE /browser ROUTE
 * ---------------------------------------------------------------------------
 * Because there are two places somebody realises they are doing an errand by
 * hand: the trámites screen, and the middle of a conversation. Both open the
 * same recorder — one component, one privacy contract, one review step. Two
 * copies of a screen-share flow would drift within a month, and the half that
 * drifts is always the one that explains what is being captured.
 *
 * ---------------------------------------------------------------------------
 * THE STRANGE MOMENT
 * ---------------------------------------------------------------------------
 * Being asked to share your screen with a piece of software is not an ordinary
 * interaction, and the honest answer to it is short and specific rather than
 * reassuring. So the contract is three claims in three cells, read in about
 * four seconds, ABOVE the button — after the browser's share prompt has
 * appeared is too late to read anything — and it is repeated every time the
 * panel opens rather than shown once and filed away.
 *
 * The claims are true and worth stating in this order: only the tab you pick;
 * no video is kept, only the frames where the picture changed, and those are
 * dropped as soon as the steps are extracted; typed passwords are never
 * transcribed. The third one is the one with an escape hatch attached, so it
 * names the control that provides it.
 */

const MAX_FRAMES = 20;

/**
 * How many trámites this person has taught, kept locally.
 *
 * It decides one thing only: whether the how-to opens by itself. Somebody on
 * their first recording needs it in front of them; somebody on their fourth has
 * read it three times and would be right to resent it. Local storage is the
 * honest home for that — it is a reading preference, not a fact about the
 * workspace, and it is not worth a column, a request or a migration.
 */
const TAUGHT_KEY = 'cortex.tramites.taught';

function taughtCount(): number {
  try {
    return Number(window.localStorage.getItem(TAUGHT_KEY) ?? '0') || 0;
  } catch {
    return 0;
  }
}

function noteTaught(): void {
  try {
    window.localStorage.setItem(TAUGHT_KEY, String(taughtCount() + 1));
  } catch {
    /* private mode, or storage full. The how-to simply keeps opening. */
  }
}

/** What the caller is told once a recording has become a trámite. */
export interface SavedFlow {
  name: string;
  message: string;
  /** True only when the proving replay finished the whole errand: PROBADO. */
  verified: boolean;
}

type Stage =
  | { name: 'idle' }
  | { name: 'recording'; seconds: number; frames: number; paused: boolean }
  | { name: 'reading' }
  | { name: 'review'; proposal: Proposal; warnings: string[]; frames: number; costUsd: number }
  | { name: 'saving' };

export function TeachFlow({
  first = false,
  onSaved,
  onCancel,
}: {
  /** True on a workspace with nothing learned yet: this panel is the screen. */
  first?: boolean;
  onSaved: (result: SavedFlow) => void;
  onCancel?: () => void;
}) {
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [hint, setHint] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState<Record<string, string>>({});
  const [delivery, setDelivery] = useState<FlowDelivery>(DEFAULT_DELIVERY);
  const recorder = useRef<RecorderHandle | null>(null);

  const finish = useCallback(
    async (frames: CapturedFrame[]) => {
      if (frames.length === 0) {
        setStage({ name: 'idle' });
        setError('No se capturó nada. ¿La pestaña quedó en segundo plano todo el tiempo?');
        return;
      }
      setStage({ name: 'reading' });
      const response = await fetch('/api/browser/extract', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          frames: frames.map((f) => ({ base64: f.base64, mimeType: f.mimeType, atMs: f.atMs })),
          hint,
        }),
      });
      const payload = (await response.json()) as {
        proposal?: Proposal;
        warnings?: string[];
        frames?: number;
        costUsd?: number;
        error?: string;
      };
      if (!response.ok || !payload.proposal) {
        setStage({ name: 'idle' });
        setError(payload.error ?? 'No pude leer la grabación.');
        return;
      }
      const seeded: Record<string, string> = {};
      for (const v of payload.proposal.variables) seeded[v.name] = v.example;
      setSample(seeded);
      // Filled in from what the recording actually did — a download step means
      // a document, an extract step means a datum — so the question on the
      // review screen is "is this right?" and not "what does your errand
      // produce?", which nobody answers well in the abstract.
      setDelivery({ ...DEFAULT_DELIVERY, ...proposeOutput(payload.proposal.steps) });
      setStage({
        name: 'review',
        proposal: payload.proposal,
        warnings: payload.warnings ?? [],
        frames: payload.frames ?? frames.length,
        costUsd: payload.costUsd ?? 0,
      });
    },
    [hint],
  );

  const start = useCallback(async () => {
    setError(null);
    try {
      recorder.current = await startTabRecording({
        maxFrames: MAX_FRAMES,
        onTick: (state) => setStage({ name: 'recording', ...state }),
        onEnded: () => {
          void recorder.current?.stop().then(finish);
        },
      });
      setStage({ name: 'recording', seconds: 0, frames: 0, paused: false });
    } catch (err) {
      if (err instanceof NotATabError) setError(err.message);
      else if ((err as Error).name === 'NotAllowedError') setError(null);
      else setError((err as Error).message);
      setStage({ name: 'idle' });
    }
  }, [finish]);

  const save = useCallback(async () => {
    if (stage.name !== 'review') return;
    setStage({ name: 'saving' });
    const response = await fetch('/api/browser/flows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proposal: stage.proposal,
        sample,
        frames: stage.frames,
        costUsd: stage.costUsd,
        delivery,
      }),
    });
    const payload = (await response.json()) as {
      message?: string;
      verified?: boolean;
      error?: string;
    };
    if (!response.ok) {
      setError(payload.error ?? 'No pude guardarlo.');
      // Back to the review, with the edits intact — losing somebody's
      // corrections because the save failed would make them re-teach it.
      setStage(stage);
      return;
    }
    setStage({ name: 'idle' });
    setHint('');
    setDelivery(DEFAULT_DELIVERY);
    noteTaught();
    onSaved({
      name: stage.proposal.name,
      message: payload.message ?? 'Guardado.',
      verified: payload.verified ?? false,
    });
  }, [stage, sample, delivery, onSaved]);

  if (!canRecordTab()) {
    return (
      <Panel className="p-5">
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Este navegador no permite compartir una pestaña, así que no se puede enseñar un{' '}
          {MODULE.one} desde aquí. Funciona en Chrome, Edge y Firefox de escritorio.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="overflow-hidden">
      {error && (
        <div className="flex items-start gap-2 border-b border-rose/20 bg-rose-soft px-5 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose" aria-hidden="true" />
          <p className="text-[13px] leading-relaxed text-rose">{error}</p>
        </div>
      )}

      {stage.name === 'idle' && (
        <div className="p-5 sm:p-6">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-ink">
            {first ? `Enséñame el primer ${MODULE.one}` : `Enséñame un ${MODULE.one}`}
          </h2>
          <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-ink-muted">
            {first ? (
              <>
                Un {MODULE.one} es una vuelta que hoy alguien hace a mano en un portal: sacar un
                certificado en la Cámara de Comercio, consultar una placa en el RUNT, radicar una
                solicitud. Hazlo <strong className="font-semibold text-ink">una vez</strong>{' '}
                compartiendo la pestaña y, de ahí en adelante, lo repito yo en segundos.
              </>
            ) : (
              <>
                Comparte <strong className="font-semibold text-ink">la pestaña</strong> del portal,
                haz la vuelta como siempre, y al terminar leo la grabación y te propongo los pasos.
              </>
            )}
          </p>

          <CaptureContract kind="teach" />
          <HowToRecord />

          <div className="mt-5 max-w-xl">
            <label className="field-label" htmlFor="teach-hint">
              ¿Qué vas a hacer? (opcional, me ayuda a entenderlo)
            </label>
            <Input
              id="teach-hint"
              className="mt-1.5"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="Consultar el estado de un vehículo por placa en el RUNT"
            />
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button onClick={() => void start()}>
              <Video className="h-4 w-4" aria-hidden="true" />
              Enséñame
            </Button>
            {onCancel && (
              <Button variant="ghost" onClick={onCancel}>
                Ahora no
              </Button>
            )}
          </div>
        </div>
      )}

      {stage.name === 'recording' && (
        <div className="p-5 sm:p-6">
          <div className="flex flex-wrap items-center gap-3">
            <span className={chipClass(stage.paused ? 'neutral' : 'rose')}>
              <Circle
                className={clsx(
                  'h-2 w-2 fill-current',
                  !stage.paused && 'animate-pulse motion-reduce:animate-none',
                )}
                aria-hidden="true"
              />
              {stage.paused ? 'En pausa' : 'Grabando'}
            </span>
            <span className="tabular text-[15px] font-semibold text-ink">
              {String(Math.floor(stage.seconds / 60)).padStart(2, '0')}:
              {String(stage.seconds % 60).padStart(2, '0')}
            </span>
            <span className="text-[12px] text-ink-faint">
              <span className="tabular">{stage.frames}</span> de{' '}
              <span className="tabular">{MAX_FRAMES}</span> momentos capturados · sin video, y se
              borran al terminar
            </span>
          </div>

          <p className="mt-3 max-w-2xl text-[13.5px] leading-relaxed text-ink-muted">
            Haz la vuelta en la otra pestaña. Vuelve aquí y pulsa Terminar cuando la hayas
            completado —{' '}
            <strong className="font-semibold text-ink">
              incluida la pantalla con el resultado
            </strong>
            , que es la que me dice qué produce.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {stage.paused ? (
              <Button
                variant="outline"
                onClick={() => {
                  recorder.current?.resume();
                }}
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                Seguir grabando
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  recorder.current?.pause();
                }}
              >
                <Pause className="h-4 w-4" aria-hidden="true" />
                Pausar
              </Button>
            )}
            <Button
              onClick={() => {
                void recorder.current?.stop().then(finish);
              }}
            >
              <Square className="h-4 w-4" aria-hidden="true" />
              Terminar
            </Button>
            <p className="self-center text-[12px] text-ink-faint">
              Pausa si vas a escribir algo que no debería quedar.
            </p>
          </div>
        </div>
      )}

      {(stage.name === 'reading' || stage.name === 'saving') && (
        <div className="flex items-center gap-3 p-6">
          <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden="true" />
          <p className="text-[13px] text-ink-muted">
            {stage.name === 'reading'
              ? 'Leyendo la grabación y armando los pasos…'
              : 'Guardando y probándolo contra el sitio real. Esto se demora lo que se demore el portal.'}
          </p>
        </div>
      )}

      {stage.name === 'review' && (
        <Review
          proposal={stage.proposal}
          warnings={stage.warnings}
          frames={stage.frames}
          costUsd={stage.costUsd}
          sample={sample}
          onSample={setSample}
          delivery={delivery}
          onDelivery={setDelivery}
          onChange={(proposal) => setStage({ ...stage, proposal })}
          onDiscard={() => setStage({ name: 'idle' })}
          onSave={() => void save()}
        />
      )}
    </Panel>
  );
}

/**
 * Cómo hacerlo para que la grabación sirva.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The capture contract above answers "what are you taking from me". This
 * answers the other half, and it is the half that decides whether anybody ever
 * teaches a SECOND trámite: a first recording is ruined by things nobody would
 * guess — half the errand, a detour to another tab to look up a number, hitting
 * record before the portal is even open — and the person does not conclude "I
 * did it wrong", they conclude "this does not work". A tutorial is cheaper than
 * losing somebody on their first attempt.
 *
 * FOUR, NOT TEN. Each one is here because it is a way a recording actually
 * fails, and each carries its reason: people follow an instruction they
 * understand and skip one they were merely given.
 *
 * THE WARNING IS THE MOST VALUABLE PART. Some errands cannot be learned from
 * pixels at all (docs/operations/browser.md § 6), and finding that out AFTER
 * five minutes of recording is the worst experience this module can produce.
 * The blockers that waste the whole attempt are separated from the one that has
 * a workaround, because telling somebody to abandon a recording and telling
 * them to click instead of hover are different instructions.
 */
function HowToRecord() {
  const [open, setOpen] = useState(false);

  // Read after mount: this component is server-rendered too, and reading local
  // storage while rendering would mismatch the hydration.
  useEffect(() => {
    if (taughtCount() === 0) setOpen(true);
  }, []);

  const steps = [
    {
      title: 'Abre el portal y entra antes de darle a Enséñame',
      why: 'Grabar el login no sirve de nada: la clave no se aprende, y arrancar buscando el sitio llena la grabación de pasos que no son el trámite.',
    },
    {
      title: 'Hazlo entero, hasta la pantalla del resultado',
      why: 'Media grabación es medio trámite. La pantalla final es la que me dice qué produce esto, así que no cierres antes de verla.',
    },
    {
      title: 'Todo en la misma pestaña',
      why: 'Sólo se comparte la que elegiste. Si te vas a otra a buscar un dato, ahí queda un hueco que no puedo llenar.',
    },
    {
      title: 'Con datos de verdad y sin atajos',
      why: 'La placa o el NIT que escribas son justo lo que después se vuelve el dato que cambia en cada ejecución. Y hazlo como lo haces siempre: si pegas la URL final o te saltas un paso «porque ya sé lo que hace», aprendo un camino que mañana no existe.',
    },
  ];

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[12.5px] font-semibold text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transition-none"
      >
        <ChevronDown
          className={clsx(
            'h-3.5 w-3.5 transition-transform duration-150 motion-reduce:transition-none',
            open ? 'rotate-0' : '-rotate-90',
          )}
          aria-hidden="true"
        />
        {open ? 'Ocultar cómo se hace' : 'Cómo se hace, en cuatro puntos'}
      </button>

      {open && (
        <div className="mt-2 rounded-card border border-border bg-surface-2/60 p-4">
          <ol className="space-y-2.5">
            {steps.map((step) => (
              <li key={step.title} className="flex gap-2.5">
                <span
                  className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                  aria-hidden="true"
                />
                <p className="text-[12.5px] leading-snug text-ink-muted">
                  <strong className="font-semibold text-ink">{step.title}.</strong> {step.why}
                </p>
              </li>
            ))}
          </ol>

          <div className="mt-3.5 flex gap-2 border-t border-border pt-3">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber" aria-hidden="true" />
            <div>
              <p className="text-[12.5px] leading-snug text-ink">
                <strong className="font-semibold">
                  Hay cosas que todavía no puedo aprender viendo.
                </strong>{' '}
                Si el trámite pide un código que llega al celular o al correo, un captcha, o subir
                un archivo desde tu computador, no gastes la grabación: por ahora ese hay que
                seguirlo haciendo a mano.
              </p>
              <p className="mt-1 text-[12px] leading-snug text-ink-muted">
                Y si hay un menú que sólo se abre al pasar el ratón, hazle clic si el portal deja —
                un menú que aparece solo no queda en ningún fotograma. Arrastrar y soltar tampoco
                lo aprendo.
              </p>
            </div>
          </div>

          <p className="mt-3 border-t border-border pt-3 text-[12px] leading-snug text-ink-faint">
            Grabar no es el final: al terminar te muestro los pasos que entendí para que los
            corrijas, y lo corro una vez contra el sitio real. Sólo si reproduce completo queda{' '}
            <strong className="font-semibold text-ink">probado</strong>.
          </p>
        </div>
      )}
    </div>
  );
}

function Review({
  proposal,
  warnings,
  frames,
  costUsd,
  sample,
  onSample,
  delivery,
  onDelivery,
  onChange,
  onDiscard,
  onSave,
}: {
  proposal: Proposal;
  warnings: string[];
  frames: number;
  costUsd: number;
  sample: Record<string, string>;
  onSample: (next: Record<string, string>) => void;
  delivery: FlowDelivery;
  onDelivery: (next: FlowDelivery) => void;
  onChange: (next: Proposal) => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
  // Recomputed as the URL is edited: correcting a mistyped host should change
  // the advice, not leave a stale banner arguing about the old one.
  const connected = alreadyConnected(proposal.startUrl);

  return (
    <div className="divide-y divide-border">
      <div className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-ink">Esto es lo que entendí</h2>
            <p className="mt-1 text-[12.5px] text-ink-faint">
              Leí <span className="tabular">{frames}</span> momentos de la grabación
              {costUsd > 0 && (
                <>
                  {' '}
                  por <span className="tabular">US${costUsd.toFixed(3)}</span>
                </>
              )}
              . Las imágenes ya se borraron.
            </p>
          </div>
          <span className={chipClass(proposal.effect === 'write' ? 'amber' : 'primary')}>
            {EFFECT_LABEL[proposal.effect]}
          </span>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <label className="field-label" htmlFor="p-name">
              Nombre
            </label>
            <Input
              id="p-name"
              className="mt-1.5"
              value={proposal.name}
              onChange={(e) => onChange({ ...proposal, name: e.target.value })}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="p-url">
              Empieza en
            </label>
            <Input
              id="p-url"
              className="mt-1.5 font-mono text-[12px]"
              value={proposal.startUrl}
              onChange={(e) => onChange({ ...proposal, startUrl: e.target.value })}
            />
          </div>
        </div>

        {connected && (
          <div className="mt-4 rounded-sm border border-primary/20 bg-primary-soft px-3.5 py-3">
            <p className="flex items-center gap-1.5 text-[13px] font-semibold text-primary-ink">
              <Plug className="h-3.5 w-3.5" aria-hidden="true" />
              Esto ya lo puedo hacer sin navegador
            </p>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
              Grabaste algo en {connected.service}, y a {connected.service} ya me conecto por su
              propia puerta: leo {connected.where} con un permiso que tú autorizas y que se renueva
              solo. Aprender esto como {MODULE.one} sería más lento, se rompería cada vez que
              cambien la página, y me obligaría a guardar una contraseña que hoy no hace falta
              guardar.
            </p>
            <Link
              href="/integrations"
              className="mt-2.5 inline-flex items-center rounded-pill bg-primary px-3.5 py-1.5 text-[12.5px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 motion-reduce:transform-none motion-reduce:transition-none"
            >
              Conectar {connected.service} en Integraciones
            </Link>
          </div>
        )}

        {proposal.effect === 'write' && (
          <p className="mt-3 rounded-sm bg-amber-soft px-3 py-2 text-[12.5px] leading-relaxed text-amber">
            Marqué este {MODULE.one} como que <strong>escribe</strong> en el sitio del tercero.
            Cuando lo pida el agente desde el chat, va a pedir aprobación de una persona antes de
            correr.
          </p>
        )}
      </div>

      {/* The variables are the reason a recording becomes a procedure, so they
          get their own block at the top rather than living inside the steps. */}
      <div className="p-5">
        <h3 className="text-[13.5px] font-semibold text-ink">Lo que cambia cada vez</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
          Sin esto, el {MODULE.one} sólo sabría repetir exactamente la misma consulta. Corrige lo
          que haya quedado mal: un dato marcado como fijo que en realidad cambia es lo que obliga a
          volver a enseñarlo.
        </p>
        {proposal.variables.length === 0 ? (
          <p className="mt-3 rounded-sm bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
            No detecté ningún dato variable. Revisa los pasos de abajo: si alguno escribe algo que
            va a cambiar, este {MODULE.one} todavía no sirve para repetirse.
          </p>
        ) : (
          <ul className="mt-3 space-y-2">
            {proposal.variables.map((variable) => (
              <li key={variable.name} className="flex flex-wrap items-center gap-2">
                <code className="rounded-sm bg-surface-2 px-2 py-1 font-mono text-[12px] text-primary">
                  {`{{${variable.name}}}`}
                </code>
                <span className="text-[13px] text-ink">{variable.label}</span>
                <Input
                  className="ml-auto max-w-[220px]"
                  value={sample[variable.name] ?? ''}
                  onChange={(e) => onSample({ ...sample, [variable.name]: e.target.value })}
                  placeholder={variable.example || 'valor para la prueba'}
                  aria-label={`Valor de prueba para ${variable.label}`}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="p-5">
        <h3 className="text-[13.5px] font-semibold text-ink">Qué produce y dónde te llega</h3>
        <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
          Lo pregunto ahora, mientras te acuerdas de a qué fuiste. Un {MODULE.one} que corre solo
          de madrugada y deja el resultado en una pantalla que nadie abre no le sirve a nadie.
        </p>
        <div className="mt-3.5">
          <DeliveryFields value={delivery} onChange={onDelivery} />
        </div>
      </div>

      <div className="p-5">
        <h3 className="text-[13.5px] font-semibold text-ink">Los pasos</h3>
        <ol className="mt-3 space-y-2">
          {proposal.steps.map((s, index) => (
            <li
              key={`${s.label}-${index}`}
              className="rounded-sm border border-border bg-surface-2/50 px-3 py-2.5"
            >
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="tabular text-[11px] font-semibold text-ink-faint">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span className="text-[13px] text-ink">
                  <span className="text-ink-muted">{ACTION_LABEL[s.action]}</span> {s.label}
                </span>
                {s.value?.kind === 'secret' && (
                  <span className={chipClass('amber')}>credencial</span>
                )}
                {s.value?.kind === 'template' && (
                  <code className="font-mono text-[11.5px] text-primary">{s.value.text}</code>
                )}
                {s.value?.kind === 'literal' && (
                  <span className="font-mono text-[11.5px] text-ink-faint">«{s.value.text}»</span>
                )}
              </div>
              {s.targets.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {s.targets.map((t, i) => (
                    <span
                      key={`${t.kind}-${t.value}-${i}`}
                      title={TARGET_WHY[t.kind]}
                      className={clsx(
                        'rounded-pill border px-2 py-[2px] font-mono text-[10.5px]',
                        i === 0
                          ? 'border-primary/20 bg-primary-soft text-primary-ink'
                          : 'border-border bg-surface text-ink-faint',
                      )}
                    >
                      {TARGET_LABEL[t.kind]}: {t.name ?? t.value}
                    </span>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      </div>

      {warnings.length > 0 && (
        <div className="bg-amber-soft/40 p-5">
          <h3 className="text-[13px] font-semibold text-amber">Mira esto antes de guardar</h3>
          <ul className="mt-2 space-y-1.5">
            {warnings.map((warning) => (
              <li key={warning} className="text-[12.5px] leading-relaxed text-ink-muted">
                · {warning}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 p-5">
        <Button variant={connected ? 'outline' : 'default'} onClick={onSave}>
          {connected ? 'Guardarlo de todos modos' : 'Guardar y probar'}
        </Button>
        <Button variant="ghost" onClick={onDiscard}>
          Descartar
        </Button>
        <p className="max-w-md text-[12px] leading-snug text-ink-faint">
          Al guardar lo corro una vez contra el sitio real. Si funciona completo queda{' '}
          <strong className="font-semibold text-ink">probado</strong>; si no, queda{' '}
          <strong className="font-semibold text-ink">propuesto</strong> y te digo en qué paso se
          quedó.
        </p>
      </div>
    </div>
  );
}
