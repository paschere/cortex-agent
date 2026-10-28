'use client';

import { Glyph } from '@/components/apps/AppGlyph';
import { APP_ICON_NAMES } from '@cortex/agent-tools/src/apps/icon-names';
import {
  type BlockDesign,
  DESIGN_TONES,
  EMPHASES,
  EMPHASIS_LABEL,
  HEIGHTS,
  HEIGHT_LABEL,
  SIZES,
  SIZE_LABEL,
  SURFACES,
  SURFACE_LABEL,
  TONE_LABEL,
  VARIANT_LABEL,
  describeDesign,
  hasDesign,
  variantsOf,
} from '@cortex/agent-tools/src/views/design-shape';
import type { ViewBlock } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { RotateCcw } from 'lucide-react';
import { useId } from 'react';
import { Section, Segmented, Toggle } from './controls';

/**
 * LA SECCIÓN «DISEÑO» DEL INSPECTOR.
 *
 * Cada bloque puede tener su propio diseño (`design` en el contrato), y aquí se
 * elige con las manos: una miniatura por variante, chips de superficie, de
 * tamaño y de tono. Nada se escribe a mano y no hay CSS: sólo las opciones con
 * nombre del contrato (design-shape.ts). Lo que queda igual al dibujo de
 * siempre no se guarda: al volver a «Automático» el bloque deja de llevar
 * `design`, y el spec queda como estaba.
 */

type Change = (next: ViewBlock, coalesce?: string) => void;

/** Quita lo que equivale a «no decir nada»; sin nada, el bloque no lleva `design`. */
export function cleanDesign(d: BlockDesign): BlockDesign | undefined {
  const out: BlockDesign = { ...d };
  if (out.size === 'auto') out.size = undefined;
  if (out.height === 'auto') out.height = undefined;
  if (out.emphasis === 'normal') out.emphasis = undefined;
  if (out.title === 'shown') out.title = undefined;
  for (const k of Object.keys(out) as Array<keyof BlockDesign>) if (out[k] === undefined) delete out[k];
  return hasDesign(out) ? out : undefined;
}

export function DesignSection({ block, onChange }: { block: ViewBlock; onChange: Change }) {
  const current: BlockDesign = (block as { design?: BlockDesign }).design ?? {};
  const variants = variantsOf(block.type);
  const set = (patch: Partial<BlockDesign>) => {
    const design = cleanDesign({ ...current, ...patch });
    onChange({ ...block, design } as ViewBlock);
  };
  const hasTitle = 'title' in block;

  return (
    <Section
      title="Diseño"
      action={
        hasDesign(current) ? (
          <button
            type="button"
            onClick={() => onChange({ ...block, design: undefined } as ViewBlock)}
            className="inline-flex items-center gap-1 rounded-pill px-2 py-1 text-micro font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <RotateCcw className="h-3 w-3" aria-hidden /> Quitar diseño
          </button>
        ) : undefined
      }
    >
      <p className="text-micro text-ink-faint" aria-live="polite">
        {describeDesign(current)}
      </p>

      {variants.length > 0 && (
        <Choice
          label="Forma"
          value={current.variant}
          onChange={(variant) => set({ variant })}
          cols={variants.length > 4 ? 3 : 2}
          options={variants.map((v) => ({
            value: v,
            label: VARIANT_LABEL[v] ?? v,
            preview: <VariantThumb type={block.type} variant={v} />,
          }))}
          emptyLabel="De siempre"
        />
      )}

      <Choice
        label="Superficie"
        value={current.surface}
        onChange={(surface) => set({ surface })}
        cols={3}
        options={SURFACES.map((s) => ({
          value: s,
          label: SURFACE_LABEL[s],
          preview: <SurfaceSwatch surface={s} />,
        }))}
      />

      <Choice
        label="Ancho en la pantalla"
        value={current.size ?? 'auto'}
        onChange={(size) => set({ size })}
        cols={5}
        options={SIZES.map((s) => ({
          value: s,
          label: SIZE_LABEL[s],
          preview: <SizeSwatch size={s} />,
        }))}
      />

      <Segmented
        label="Altura"
        value={current.height ?? 'auto'}
        options={HEIGHTS.map((h) => ({ value: h, label: HEIGHT_LABEL[h] }))}
        onChange={(height) => set({ height })}
      />

      <ToneChips value={current.tone} onChange={(tone) => set({ tone })} />

      <Segmented
        label="Énfasis"
        value={current.emphasis ?? 'normal'}
        options={EMPHASES.map((e) => ({ value: e, label: EMPHASIS_LABEL[e] }))}
        onChange={(emphasis) => set({ emphasis })}
      />

      {hasTitle && (
        <Toggle
          label="Mostrar el título"
          hint="Apagado, el título sigue para los lectores de pantalla pero no se ve."
          checked={current.title !== 'hidden'}
          onChange={(shown) => set({ title: shown ? 'shown' : 'hidden' })}
        />
      )}

      <IconPicker value={current.icon} onChange={(icon) => set({ icon })} />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
  cols,
  emptyLabel,
}: {
  label: string;
  value: T | undefined;
  onChange: (v: T | undefined) => void;
  options: Array<{ value: T; label: string; preview: React.ReactNode }>;
  cols: 2 | 3 | 4 | 5;
  /** Con esto se muestra una primera opción «sin elegir». */
  emptyLabel?: string;
}) {
  const id = useId();
  const colClass = { 2: 'grid-cols-2', 3: 'grid-cols-3', 4: 'grid-cols-4', 5: 'grid-cols-5' }[cols];
  return (
    <div role="radiogroup" aria-labelledby={`${id}-l`}>
      <p id={`${id}-l`} className="field-label mb-1">
        {label}
      </p>
      <div className={clsx('grid gap-1.5', colClass)}>
        {emptyLabel && (
          <Chip active={value === undefined} onClick={() => onChange(undefined)} label={emptyLabel}>
            <span className="grid h-9 w-full place-items-center text-ink-faint">
              <RotateCcw className="h-4 w-4" aria-hidden />
            </span>
          </Chip>
        )}
        {options.map((o) => (
          <Chip
            key={o.value}
            active={value === o.value}
            onClick={() => onChange(o.value)}
            label={o.label}
          >
            {o.preview}
          </Chip>
        ))}
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  label,
  children,
}: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={clsx(
        'flex min-w-0 flex-col items-stretch gap-1 rounded-sm border p-1.5 text-center transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        active
          ? 'border-primary bg-primary-soft text-ink'
          : 'border-border-strong bg-surface text-ink-muted hover:border-primary/50 hover:text-ink',
      )}
    >
      {children}
      <span className="truncate text-micro font-semibold">{label}</span>
    </button>
  );
}

function ToneChips({
  value,
  onChange,
}: { value: BlockDesign['tone']; onChange: (v: BlockDesign['tone']) => void }) {
  const id = useId();
  const DOT: Record<(typeof DESIGN_TONES)[number], string> = {
    primary: 'bg-primary',
    emerald: 'bg-emerald',
    amber: 'bg-amber',
    sky: 'bg-sky',
    rose: 'bg-rose',
  };
  return (
    <div role="radiogroup" aria-labelledby={`${id}-l`}>
      <p id={`${id}-l`} className="field-label mb-1">
        Color del bloque
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          role="radio"
          aria-checked={value === undefined}
          onClick={() => onChange(undefined)}
          className={clsx(
            'rounded-pill border px-2.5 py-1 text-micro font-semibold',
            value === undefined
              ? 'border-primary bg-primary-soft text-ink'
              : 'border-border-strong text-ink-muted hover:text-ink',
          )}
        >
          De siempre
        </button>
        {DESIGN_TONES.map((t) => (
          <button
            key={t}
            type="button"
            role="radio"
            aria-checked={value === t}
            onClick={() => onChange(t)}
            className={clsx(
              'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-micro font-semibold',
              value === t
                ? 'border-primary bg-primary-soft text-ink'
                : 'border-border-strong text-ink-muted hover:text-ink',
            )}
          >
            <span aria-hidden className={clsx('h-2.5 w-2.5 rounded-pill', DOT[t])} />
            {TONE_LABEL[t]}
          </button>
        ))}
      </div>
    </div>
  );
}

function IconPicker({
  value,
  onChange,
}: { value: BlockDesign['icon']; onChange: (v: BlockDesign['icon']) => void }) {
  return (
    <details className="group rounded-sm border border-border-strong">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-xs font-semibold text-ink-muted hover:text-ink">
        <span>Ícono del título</span>
        <span className="flex items-center gap-1.5 text-ink">
          {value ? (
            <>
              <Glyph name={value} className="h-4 w-4" />
              <span className="text-micro text-ink-faint">{value}</span>
            </>
          ) : (
            <span className="text-micro text-ink-faint">Sin ícono</span>
          )}
        </span>
      </summary>
      <div className="max-h-48 overflow-y-auto border-t border-border p-2">
        <div className="grid grid-cols-6 gap-1">
          <button
            type="button"
            aria-label="Sin ícono"
            aria-pressed={value === undefined}
            onClick={() => onChange(undefined)}
            className={clsx(
              'grid h-9 place-items-center rounded-sm text-micro font-semibold',
              value === undefined ? 'bg-primary-soft text-primary' : 'text-ink-faint hover:bg-surface-2',
            )}
          >
            Ninguno
          </button>
          {APP_ICON_NAMES.map((n) => (
            <button
              key={n}
              type="button"
              aria-label={n}
              title={n}
              aria-pressed={value === n}
              onClick={() => onChange(n)}
              className={clsx(
                'grid h-9 place-items-center rounded-sm',
                value === n ? 'bg-primary-soft text-primary' : 'text-ink-muted hover:bg-surface-2',
              )}
            >
              <Glyph name={n} className="h-4 w-4" />
            </button>
          ))}
        </div>
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Miniaturas
// ---------------------------------------------------------------------------

function SurfaceSwatch({ surface }: { surface: (typeof SURFACES)[number] }) {
  const base = 'mx-auto h-9 w-full rounded-sm';
  switch (surface) {
    case 'plain':
      return <span className={clsx(base, 'border border-dashed border-border')} />;
    case 'card':
      return <span className={clsx(base, 'border border-border bg-surface shadow-card')} />;
    case 'tinted':
      return <span className={clsx(base, 'border border-primary/20 bg-primary-soft')} />;
    case 'outline':
      return <span className={clsx(base, 'border-2 border-border-strong')} />;
    case 'elevated':
      return <span className={clsx(base, 'bg-surface shadow-pop')} />;
    case 'hero':
      return <span className={clsx(base, 'bg-primary-strong')} />;
  }
}

function SizeSwatch({ size }: { size: (typeof SIZES)[number] }) {
  const span = { auto: 0, third: 2, half: 3, 'two-thirds': 4, full: 6 }[size];
  return (
    <span className="grid h-9 grid-cols-6 items-center gap-px" aria-hidden>
      {size === 'auto' ? (
        <span className="col-span-6 text-center text-micro font-semibold text-ink-faint">auto</span>
      ) : (
        <span
          className="h-5 rounded-sm bg-primary/70"
          style={{ gridColumn: `span ${span} / span ${span}` }}
        />
      )}
    </span>
  );
}

/** Una miniatura por variante: rayas y bloques que sugieren la forma, no la dibujan fiel. */
export function VariantThumb({ type, variant }: { type: string; variant: string }) {
  return (
    <svg
      viewBox="0 0 56 36"
      className="mx-auto h-9 w-full text-ink-faint"
      aria-hidden
      role="presentation"
    >
      <Shapes type={type} variant={variant} />
    </svg>
  );
}

const P = 'fill-primary';
const F = 'fill-current';

function Shapes({ type, variant }: { type: string; variant: string }) {
  const key = `${type}:${variant}`;
  switch (key) {
    case 'metric:number':
      return (
        <>
          <rect x="6" y="6" width="18" height="3" rx="1.5" className={F} opacity=".5" />
          <rect x="6" y="14" width="34" height="10" rx="2" className={P} />
        </>
      );
    case 'metric:number-sparkline':
      return (
        <>
          <rect x="6" y="5" width="30" height="8" rx="2" className={P} />
          <path d="M6 30 16 24l8 4 10-8 16 4" fill="none" stroke="currentColor" strokeWidth="2" />
        </>
      );
    case 'metric:ring':
      return (
        <>
          <circle cx="28" cy="18" r="12" fill="none" stroke="currentColor" strokeWidth="4" opacity=".3" />
          <path d="M28 6a12 12 0 1 1-12 12" fill="none" className="stroke-primary" strokeWidth="4" strokeLinecap="round" />
        </>
      );
    case 'metric:compare':
      return (
        <>
          <rect x="6" y="6" width="28" height="9" rx="2" className={P} />
          <path d="m8 28 5-7 5 7z" className="fill-emerald" />
          <rect x="22" y="23" width="22" height="3" rx="1.5" className={F} opacity=".5" />
        </>
      );
    case 'metric:split':
      return (
        <>
          <rect x="5" y="9" width="20" height="14" rx="2" className={P} />
          <rect x="31" y="9" width="20" height="14" rx="2" className={F} opacity=".4" />
          <rect x="5" y="28" width="20" height="2" rx="1" className={F} opacity=".4" />
          <rect x="31" y="28" width="20" height="2" rx="1" className={F} opacity=".4" />
        </>
      );
    case 'cards:compact':
      return <Grid cols={3} rows={2} />;
    case 'cards:rich':
      return (
        <>
          {[0, 1].map((i) => (
            <g key={i}>
              <circle cx={10 + i * 28} cy="11" r="4" className={P} />
              <rect x={17 + i * 28} y="8" width="8" height="3" rx="1.5" className={F} opacity=".6" />
              <rect x={5 + i * 28} y="19" width="22" height="3" rx="1.5" className={F} opacity=".4" />
              <rect x={5 + i * 28} y="25" width="12" height="5" rx="2.5" className="fill-emerald" opacity=".7" />
            </g>
          ))}
        </>
      );
    case 'cards:image':
      return (
        <>
          {[0, 1].map((i) => (
            <g key={i}>
              <rect x={4 + i * 26} y="4" width="22" height="16" rx="2" className={P} opacity=".7" />
              <rect x={4 + i * 26} y="23" width="16" height="3" rx="1.5" className={F} opacity=".6" />
              <rect x={4 + i * 26} y="29" width="22" height="2" rx="1" className={F} opacity=".35" />
            </g>
          ))}
        </>
      );
    case 'cards:row':
      return (
        <>
          {[0, 1, 2, 3].map((i) => (
            <g key={i}>
              <rect x="4" y={5 + i * 8} width="3" height="5" rx="1.5" className={P} />
              <rect x="10" y={6 + i * 8} width="26" height="3" rx="1.5" className={F} opacity=".5" />
              <rect x="42" y={6 + i * 8} width="10" height="3" rx="1.5" className={F} opacity=".3" />
            </g>
          ))}
        </>
      );
    case 'sheet:grid':
    case 'table:lined':
      return (
        <>
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x="4" y={5 + i * 8} width="48" height="1.5" className={F} opacity={i === 0 ? 0.8 : 0.35} />
          ))}
          <rect x="4" y="9" width="14" height="3" rx="1.5" className={F} opacity=".5" />
        </>
      );
    case 'table:zebra':
      return (
        <>
          {[0, 1, 2, 3].map((i) => (
            <rect key={i} x="4" y={4 + i * 8} width="48" height="7" rx="1.5" className={F} opacity={i % 2 ? 0.25 : 0.06} />
          ))}
        </>
      );
    case 'sheet:airy':
    case 'table:minimal':
      return (
        <>
          {[0, 1, 2].map((i) => (
            <rect key={i} x="4" y={7 + i * 9} width={40 - i * 6} height="3" rx="1.5" className={F} opacity=".45" />
          ))}
        </>
      );
    case 'board:columns':
      return (
        <>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect x={4 + i * 17} y="4" width="15" height="28" rx="2" className={F} opacity=".1" />
              <rect x={6 + i * 17} y="7" width="11" height="6" rx="1.5" className={i === 0 ? P : F} opacity={i === 0 ? 1 : 0.4} />
              <rect x={6 + i * 17} y="16" width="11" height="6" rx="1.5" className={F} opacity=".4" />
            </g>
          ))}
        </>
      );
    case 'board:compact':
      return (
        <>
          {[0, 1, 2, 3].map((i) => (
            <g key={i}>
              <rect x={4 + i * 12.5} y="4" width="11" height="28" rx="2" className={F} opacity=".1" />
              <rect x={5.5 + i * 12.5} y="7" width="8" height="3" rx="1" className={F} opacity=".5" />
              <rect x={5.5 + i * 12.5} y="12" width="8" height="3" rx="1" className={F} opacity=".5" />
            </g>
          ))}
        </>
      );
    case 'chart:bar':
      return (
        <>
          {[10, 18, 14, 24, 20].map((h, i) => (
            <rect key={i} x={6 + i * 9.5} y={32 - h} width="6" height={h} rx="1.5" className={P} opacity={0.5 + i * 0.1} />
          ))}
        </>
      );
    case 'chart:line':
      return <path d="M5 26 15 18l10 5 12-12 14 6" fill="none" className="stroke-primary" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />;
    case 'chart:area':
      return (
        <>
          <path d="M5 26 15 18l10 5 12-12 14 6V32H5z" className={P} opacity=".25" />
          <path d="M5 26 15 18l10 5 12-12 14 6" fill="none" className="stroke-primary" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case 'chart:donut':
      return (
        <>
          <circle cx="28" cy="18" r="11" fill="none" stroke="currentColor" strokeWidth="6" opacity=".25" />
          <path d="M28 7a11 11 0 0 1 11 11" fill="none" className="stroke-primary" strokeWidth="6" />
        </>
      );
    case 'detail:sections':
      return (
        <>
          <rect x="4" y="4" width="48" height="7" rx="2" className={P} opacity=".6" />
          <rect x="4" y="14" width="23" height="18" rx="2" className={F} opacity=".15" />
          <rect x="29" y="14" width="23" height="18" rx="2" className={F} opacity=".15" />
        </>
      );
    case 'detail:timeline-first':
      return (
        <>
          <rect x="4" y="4" width="48" height="5" rx="2" className={P} opacity=".6" />
          <path d="M10 13v19" stroke="currentColor" strokeWidth="1.5" opacity=".5" />
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <circle cx="10" cy={16 + i * 7} r="2" className={P} />
              <rect x="16" y={14.5 + i * 7} width={30 - i * 4} height="3" rx="1.5" className={F} opacity=".4" />
            </g>
          ))}
        </>
      );
    case 'calendar:month':
      return <Grid cols={7} rows={5} />;
    case 'calendar:agenda':
      return (
        <>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect x="4" y={5 + i * 10} width="9" height="8" rx="2" className={P} opacity={0.9 - i * 0.2} />
              <rect x="17" y={6 + i * 10} width="30" height="3" rx="1.5" className={F} opacity=".5" />
              <rect x="17" y={11 + i * 10} width="18" height="2" rx="1" className={F} opacity=".3" />
            </g>
          ))}
        </>
      );
    case 'gallery:grid':
      return <Grid cols={3} rows={2} tall />;
    case 'gallery:masonry':
      return (
        <>
          {[
            [4, 4, 14, 16],
            [4, 23, 14, 9],
            [21, 4, 14, 9],
            [21, 16, 14, 16],
            [38, 4, 14, 20],
            [38, 27, 14, 5],
          ].map(([x, y, w, h], i) => (
            <rect key={i} x={x} y={y} width={w} height={h} rx="2" className={F} opacity={0.15 + (i % 3) * 0.12} />
          ))}
        </>
      );
    case 'progress:bar':
      return (
        <>
          {[34, 22, 40].map((w, i) => (
            <g key={i}>
              <rect x="4" y={6 + i * 10} width="48" height="5" rx="2.5" className={F} opacity=".15" />
              <rect x="4" y={6 + i * 10} width={w} height="5" rx="2.5" className={P} />
            </g>
          ))}
        </>
      );
    case 'progress:steps':
      return (
        <>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <rect key={i} x={4 + i * 8.2} y="12" width="6.4" height="12" rx="2" className={i < 4 ? P : F} opacity={i < 4 ? 1 : 0.2} />
          ))}
        </>
      );
    case 'progress:ring':
      return (
        <>
          {[0, 1].map((i) => (
            <g key={i}>
              <circle cx={16 + i * 24} cy="18" r="9" fill="none" stroke="currentColor" strokeWidth="4" opacity=".25" />
              <path d={i ? 'M40 9a9 9 0 0 1 9 9' : 'M16 9a9 9 0 1 1-9 9'} fill="none" className="stroke-primary" strokeWidth="4" strokeLinecap="round" />
            </g>
          ))}
        </>
      );
    case 'links:buttons':
      return (
        <>
          <rect x="4" y="12" width="22" height="9" rx="4.5" className={P} />
          <rect x="30" y="12" width="22" height="9" rx="4.5" className={F} opacity=".25" />
        </>
      );
    case 'links:cards':
      return (
        <>
          {[0, 1].map((i) => (
            <g key={i}>
              <rect x={4 + i * 25} y="6" width="23" height="24" rx="3" className={F} opacity=".12" />
              <rect x={7 + i * 25} y="10" width="7" height="7" rx="2" className={P} />
              <rect x={7 + i * 25} y="21" width="16" height="3" rx="1.5" className={F} opacity=".5" />
            </g>
          ))}
        </>
      );
    case 'links:tiles':
      return (
        <>
          {[0, 1, 2].map((i) => (
            <g key={i}>
              <rect x={4 + i * 17} y="6" width="15" height="24" rx="3" className={i === 0 ? P : F} opacity={i === 0 ? 0.85 : 0.18} />
              <circle cx={11.5 + i * 17} cy="15" r="3" className="fill-white" opacity=".8" />
            </g>
          ))}
        </>
      );
    case 'text:plain':
      return (
        <>
          {[40, 46, 34].map((w, i) => (
            <rect key={i} x="5" y={8 + i * 7} width={w} height="3" rx="1.5" className={F} opacity=".45" />
          ))}
        </>
      );
    case 'text:callout':
      return (
        <>
          <rect x="4" y="6" width="48" height="24" rx="3" className={P} opacity=".15" />
          <rect x="4" y="6" width="3" height="24" rx="1.5" className={P} />
          <rect x="12" y="13" width="34" height="3" rx="1.5" className={F} opacity=".55" />
          <rect x="12" y="20" width="24" height="3" rx="1.5" className={F} opacity=".4" />
        </>
      );
    case 'text:quote':
      return (
        <>
          <text x="6" y="22" fontSize="22" className="fill-primary" fontFamily="Georgia, serif">“</text>
          <rect x="20" y="12" width="28" height="3" rx="1.5" className={F} opacity=".55" />
          <rect x="20" y="19" width="20" height="3" rx="1.5" className={F} opacity=".4" />
        </>
      );
    default:
      return <rect x="8" y="8" width="40" height="20" rx="3" className={F} opacity=".15" />;
  }
}

function Grid({ cols, rows, tall }: { cols: number; rows: number; tall?: boolean }) {
  const gap = 2;
  const w = (48 - gap * (cols - 1)) / cols;
  const h = (28 - gap * (rows - 1)) / rows;
  return (
    <>
      {Array.from({ length: cols * rows }, (_, i) => (
        <rect
          key={i}
          x={4 + (i % cols) * (w + gap)}
          y={4 + Math.floor(i / cols) * (h + gap)}
          width={w}
          height={h}
          rx={tall ? 2 : 1.5}
          className={F}
          opacity={i === 0 ? 0.55 : 0.18}
        />
      ))}
    </>
  );
}
