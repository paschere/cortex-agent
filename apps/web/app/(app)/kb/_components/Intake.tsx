'use client';

import { Panel, PanelHead } from '@/components/ui/panel';
import { clsx } from 'clsx';
import { FolderSearch, Mic, Plus, UploadCloud, Video } from 'lucide-react';
import { useState } from 'react';
import { AudioRecorder } from './AudioRecorder';
import { DriveSyncPanel } from './DriveSyncPanel';
import { MeetingImportPanel } from './MeetingImportPanel';
import { UploadDropzone } from './UploadDropzone';
import { num } from './format';
import type { IntakeCounts, IntakeKey, SpaceSummary } from './types';

/**
 * The four mouths.
 *
 * WHY THEY ARE TOGETHER. Brain Knowledge eats four ways, and until now three of
 * them were buried: recording lived under the dropzone, Meet and Drive were
 * panels further down the page that most people never scrolled to. They are the
 * same act — giving the thing something to remember — so they are shown as one
 * choice of four, with what each one has already brought in.
 */

export const INTAKES: Array<{
  key: IntakeKey;
  label: string;
  line: string;
  icon: typeof UploadCloud;
  /** How its haul reads in the count under the tile. */
  unit: [one: string, many: string];
}> = [
  {
    key: 'upload',
    label: 'Subir un archivo',
    line: 'PDF, Word o texto.',
    icon: UploadCloud,
    unit: ['archivo', 'archivos'],
  },
  {
    key: 'record',
    label: 'Grabar ahora',
    line: 'Hablas y queda escrito, con quién dijo qué.',
    icon: Mic,
    unit: ['grabación', 'grabaciones'],
  },
  {
    key: 'meeting',
    label: 'Traer una reunión',
    line: 'De Google Meet, con fecha y participantes.',
    icon: Video,
    unit: ['reunión', 'reuniones'],
  },
  {
    key: 'drive',
    label: 'Conectar Drive',
    line: 'Una carpeta que se mantiene al día sola.',
    icon: FolderSearch,
    unit: ['archivo', 'archivos'],
  },
];

function haul(count: number, unit: [string, string]): string {
  if (count === 0) return 'nada todavía';
  return `${num(count)} ${count === 1 ? unit[0] : unit[1]}`;
}

/* ------------------------------------------------------------------- index */

/**
 * The mouths on the front page: pick where it goes, then pick how it gets in.
 * Choosing one opens that space already on the right intake, so the four are a
 * way in rather than a menu of things to read about.
 */
export function IntakeChooser({
  spaces,
  totals,
  onFeed,
  onCreateSpace,
}: {
  spaces: SpaceSummary[];
  totals: IntakeCounts;
  onFeed: (spaceId: string, intake: IntakeKey) => void;
  onCreateSpace: () => void;
}) {
  const writable = spaces.filter((s) => s.canWrite);
  const [chosen, setChosen] = useState(
    () => writable.find((s) => s.isMine)?.id ?? writable[0]?.id ?? '',
  );
  // A space can be deleted while this is on screen; fall back rather than
  // feeding an id that no longer exists.
  const target = writable.some((s) => s.id === chosen) ? chosen : (writable[0]?.id ?? '');

  return (
    <Panel>
      <PanelHead title="Por dónde come" right="cuatro entradas" />
      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        Todo termina en el mismo sitio: troceado, indexado y listo para citar.
      </p>

      {writable.length === 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-border px-5 py-4">
          <p className="text-[12.5px] text-ink-muted">
            Necesitas un espacio antes de poder alimentarlo.
          </p>
          <button
            type="button"
            onClick={onCreateSpace}
            className="inline-flex items-center gap-1.5 rounded-card bg-primary px-3.5 py-2 text-[12.5px] font-semibold text-white transition-colors hover:bg-primary-strong"
          >
            <Plus className="h-3.5 w-3.5" />
            Crear un espacio
          </button>
        </div>
      ) : (
        <>
          <label className="mt-3 flex flex-wrap items-center gap-2 border-t border-border px-5 py-3">
            <span className="field-label">Guardar en</span>
            <select
              value={target}
              onChange={(e) => setChosen(e.target.value)}
              className="h-8 min-w-0 max-w-full rounded-card border border-border bg-surface px-2.5 text-[12.5px] font-medium text-ink focus:border-border-strong focus:outline-none"
            >
              {writable.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.kind === 'global' ? ' · todos la leen' : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
            {INTAKES.map(({ key, label, line, icon: Icon, unit }) => (
              <button
                key={key}
                type="button"
                onClick={() => target && onFeed(target, key)}
                className="group flex flex-col gap-1.5 bg-surface px-5 py-4 text-left transition-colors hover:bg-surface-2"
              >
                <span className="flex items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0 text-primary" />
                  <span className="text-[13px] font-bold text-ink">{label}</span>
                </span>
                <span className="text-[11.5px] leading-snug text-ink-muted">{line}</span>
                <span className="tabular mt-auto pt-1 text-[11px] text-ink-faint">
                  {haul(totals[key], unit)}
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

/* --------------------------------------------------------------- one space */

/**
 * The same four inside a space, as a row of switches with the chosen one open
 * underneath. All four stay on screen: which mouth you used is a choice about
 * the material, not a setting to go hunting for.
 */
export function IntakePanel({
  space,
  active,
  onActiveChange,
}: {
  space: SpaceSummary;
  active: IntakeKey;
  onActiveChange: (key: IntakeKey) => void;
}) {
  return (
    <Panel>
      <PanelHead title={`Alimentar a ${space.name}`} />
      <p className="px-5 pt-1 text-[12.5px] text-ink-muted">
        Elige por dónde entra. Cortex lo digiere y queda citable.
      </p>

      {/* Plain toggle buttons rather than a tablist: a real tablist owes the
          keyboard arrow-key navigation, and four buttons you can Tab through
          are what people actually expect here. */}
      <div
        className="mt-3 grid grid-cols-2 gap-px border-y border-border bg-border sm:grid-cols-4"
        role="group"
        aria-label="Formas de alimentar este espacio"
      >
        {INTAKES.map(({ key, label, icon: Icon, unit }) => {
          const on = key === active;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => onActiveChange(key)}
              className={clsx(
                'flex flex-col gap-1 px-4 py-3 text-left transition-colors',
                on ? 'bg-primary-soft' : 'bg-surface hover:bg-surface-2',
              )}
            >
              <span className="flex items-center gap-1.5">
                <Icon
                  className={clsx('h-4 w-4 shrink-0', on ? 'text-primary' : 'text-ink-faint')}
                />
                <span
                  className={clsx(
                    'text-[12.5px] font-semibold',
                    on ? 'text-primary' : 'text-ink-muted',
                  )}
                >
                  {label}
                </span>
              </span>
              <span className="tabular text-[10.5px] text-ink-faint">
                {haul(space.intake[key], unit)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="px-5 py-4">
        {active === 'upload' && <UploadDropzone spaceId={space.id} spaceName={space.name} />}
        {active === 'record' && <AudioRecorder spaceId={space.id} spaceName={space.name} />}
        {active === 'meeting' && <MeetingImportPanel spaceId={space.id} spaceName={space.name} />}
        {active === 'drive' && <DriveSyncPanel spaceId={space.id} />}
      </div>
    </Panel>
  );
}
