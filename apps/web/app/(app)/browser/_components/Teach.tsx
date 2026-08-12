'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Panel } from '@/components/ui/panel';
import {
  ACTION_LABEL,
  EFFECT_LABEL,
  type Proposal,
  TARGET_LABEL,
  TARGET_WHY,
} from '@/lib/browser-shape';
import { chipClass } from '@/lib/status-chip';
import { clsx } from 'clsx';
import { AlertTriangle, Circle, Eye, Loader2, Pause, Play, Square, Video } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import {
  type CapturedFrame,
  NotATabError,
  type RecorderHandle,
  canRecordTab,
  startTabRecording,
} from '../_lib/recorder';

/**
 * Enseñar un trámite: grabar la pestaña, revisar lo que Cortex entendió,
 * guardarlo y dejar que se pruebe solo.
 *
 * The screen is three states and says which one it is in at all times, because
 * the person is being asked to share their screen and deserves to know exactly
 * what is being kept at every moment. The privacy copy is above the button, not
 * behind a link: after the recording has happened is too late to read it.
 */

const MAX_FRAMES = 20;

type Stage =
  | { name: 'idle' }
  | { name: 'recording'; seconds: number; frames: number; paused: boolean }
  | { name: 'reading' }
  | { name: 'review'; proposal: Proposal; warnings: string[]; frames: number; costUsd: number }
  | { name: 'saving' };

export function Teach({ onSaved }: { onSaved: (message: string) => void }) {
  const [stage, setStage] = useState<Stage>({ name: 'idle' });
  const [hint, setHint] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sample, setSample] = useState<Record<string, string>>({});
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
      }),
    });
    const payload = (await response.json()) as { message?: string; error?: string };
    if (!response.ok) {
      setError(payload.error ?? 'No pude guardarlo.');
      // Back to the review, with the edits intact — losing somebody's
      // corrections because the save failed would make them re-teach it.
      setStage(stage);
      return;
    }
    setStage({ name: 'idle' });
    setHint('');
    onSaved(payload.message ?? 'Guardado.');
  }, [stage, sample, onSaved]);

  if (!canRecordTab()) {
    return (
      <Panel className="p-5">
        <p className="text-[13px] leading-relaxed text-ink-muted">
          Este navegador no permite compartir una pestaña, así que no se puede enseñar un trámite
          desde aquí. Funciona en Chrome, Edge y Firefox de escritorio.
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="overflow-hidden">
      {error && (
        <div className="flex items-start gap-2 border-b border-rose/20 bg-rose-soft px-5 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose" />
          <p className="text-[13px] leading-relaxed text-rose">{error}</p>
        </div>
      )}

      {stage.name === 'idle' && (
        <div className="p-5">
          <h2 className="text-[15px] font-semibold text-ink">Enséñame un trámite</h2>
          <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
            Comparte <strong className="font-semibold text-ink">la pestaña</strong> del portal, haz
            el trámite como siempre, y al terminar leo la grabación y te propongo los pasos. De ahí
            en adelante lo repito solo, en segundos y sin costo.
          </p>

          {/* The privacy note is here, before the button, and not behind a
              link. After the recording has happened is too late to read it. */}
          <ul className="mt-4 space-y-1.5 text-[12.5px] leading-relaxed text-ink-muted">
            <li className="flex gap-2">
              <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
              Sólo se graba la pestaña que elijas. Nada de lo que tengas en otras ventanas.
            </li>
            <li className="flex gap-2">
              <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
              No se guarda ningún video. Tomo unas pocas imágenes de los momentos en que la página
              cambia, las leo una vez, y{' '}
              <strong className="font-semibold text-ink">se borran</strong>: no quedan en la base de
              datos ni en ningún archivo.
            </li>
            <li className="flex gap-2">
              <Eye className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
              Las contraseñas se ven como puntos y no las transcribo. Si vas a escribir algo que no
              debería quedar, usa <strong className="font-semibold text-ink">Pausar</strong>.
            </li>
          </ul>

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

          <Button className="mt-4" onClick={() => void start()}>
            <Video className="h-4 w-4" />
            Enséñame
          </Button>
        </div>
      )}

      {stage.name === 'recording' && (
        <div className="p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span className={chipClass(stage.paused ? 'neutral' : 'rose')}>
              <Circle
                className={clsx('h-2 w-2 fill-current', !stage.paused && 'animate-pulse')}
                aria-hidden="true"
              />
              {stage.paused ? 'En pausa' : 'Grabando'}
            </span>
            <span className="tabular text-[13px] text-ink-muted">
              {String(Math.floor(stage.seconds / 60)).padStart(2, '0')}:
              {String(stage.seconds % 60).padStart(2, '0')}
            </span>
            <span className="tabular text-[12px] text-ink-faint">
              {stage.frames} momento{stage.frames === 1 ? '' : 's'} capturado
              {stage.frames === 1 ? '' : 's'}
            </span>
          </div>

          <p className="mt-3 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
            Haz el trámite en la otra pestaña. Vuelve aquí y pulsa Terminar cuando lo hayas
            completado — incluida la pantalla con el resultado, que es la que me dice qué produce.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {stage.paused ? (
              <Button
                variant="outline"
                onClick={() => {
                  recorder.current?.resume();
                }}
              >
                <Play className="h-4 w-4" />
                Seguir grabando
              </Button>
            ) : (
              <Button
                variant="outline"
                onClick={() => {
                  recorder.current?.pause();
                }}
              >
                <Pause className="h-4 w-4" />
                Pausar
              </Button>
            )}
            <Button
              onClick={() => {
                void recorder.current?.stop().then(finish);
              }}
            >
              <Square className="h-4 w-4" />
              Terminar
            </Button>
          </div>
        </div>
      )}

      {(stage.name === 'reading' || stage.name === 'saving') && (
        <div className="flex items-center gap-3 p-6">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
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
          onChange={(proposal) => setStage({ ...stage, proposal })}
          onDiscard={() => setStage({ name: 'idle' })}
          onSave={() => void save()}
        />
      )}
    </Panel>
  );
}

function Review({
  proposal,
  warnings,
  frames,
  costUsd,
  sample,
  onSample,
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
  onChange: (next: Proposal) => void;
  onDiscard: () => void;
  onSave: () => void;
}) {
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

        {proposal.effect === 'write' && (
          <p className="mt-3 rounded-sm bg-amber-soft px-3 py-2 text-[12.5px] leading-relaxed text-amber">
            Marqué este trámite como que <strong>escribe</strong> en el sitio del tercero. Cuando lo
            pida el agente desde el chat, va a pedir aprobación de una persona antes de correr.
          </p>
        )}
      </div>

      {/* The variables are the reason a recording becomes a procedure, so they
          get their own block at the top rather than living inside the steps. */}
      <div className="p-5">
        <h3 className="text-[13.5px] font-semibold text-ink">Lo que cambia cada vez</h3>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-muted">
          Sin esto, el trámite sólo sabría repetir exactamente la misma consulta. Corrige lo que
          haya quedado mal: un dato marcado como fijo que en realidad cambia es lo que obliga a
          volver a enseñarlo.
        </p>
        {proposal.variables.length === 0 ? (
          <p className="mt-3 rounded-sm bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
            No detecté ningún dato variable. Revisa los pasos de abajo: si alguno escribe algo que
            va a cambiar, este trámite todavía no sirve para repetirse.
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
        <Button onClick={onSave}>Guardar y probar</Button>
        <Button variant="ghost" onClick={onDiscard}>
          Descartar
        </Button>
        <p className="text-[12px] text-ink-faint">
          Al guardar lo corro una vez contra el sitio real. Si funciona completo queda{' '}
          <strong className="font-semibold text-ink">probado</strong>; si no, queda{' '}
          <strong className="font-semibold text-ink">propuesto</strong> y te digo en qué paso se
          quedó.
        </p>
      </div>
    </div>
  );
}
