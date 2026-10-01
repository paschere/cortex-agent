'use client';

import type { ComputedBlock, Tone } from '@cortex/agent-tools';
import { clsx } from 'clsx';
import { ArrowUpRight, ExternalLink, ImageOff, PlayCircle } from 'lucide-react';
import { useState } from 'react';
import { Card, TONE_RING, TONE_SOFT, useViewTheme } from './theme';

/**
 * IMAGEN, VIDEO Y BOTONES: los bloques sin tabla.
 *
 * La imagen y el iframe llegan con su dirección ya validada por el cálculo
 * (packages/agent-tools/src/views/embeds.ts), y aquí se vuelve a exigir
 * `https://` antes de pintar: si algún día un `src` llega raro, no se pinta.
 *
 *   - Imagen: `loading="lazy"`, sin referrer, y si no carga se dice.
 *   - Inserción: iframe con `sandbox` (scripts y mismo origen DEL SERVICIO
 *     —YouTube no reproduce sin ellos—, presentación y ventanas nuevas para
 *     «ver en YouTube»; sin formularios, sin navegar la página de arriba, sin
 *     descargas), carga perezosa y el referrer mínimo que esos servicios
 *     piden para reproducir.
 *   - Botones: enlaces de verdad (`<a>`), los externos en pestaña nueva y sin
 *     `opener`, para que la página de afuera no pueda tocar la vista.
 */

type Media = Extract<ComputedBlock, { type: 'media' }>;
type Links = Extract<ComputedBlock, { type: 'links' }>;

const ASPECT: Record<Media['aspect'], string> = {
  '16:9': 'aspect-video',
  '4:3': 'aspect-[4/3]',
  '1:1': 'aspect-square',
  '3:4': 'aspect-[3/4]',
};

export function MediaBlock({ block }: { block: Media }) {
  const [failed, setFailed] = useState(false);
  const src = block.src?.startsWith('https://') ? block.src : null;
  return (
    <Card title={block.title ?? undefined}>
      <div
        className={clsx(
          'relative w-full overflow-hidden rounded-sm bg-surface-2',
          ASPECT[block.aspect],
        )}
      >
        {!src ? (
          <div className="absolute inset-0 grid place-items-center p-4 text-center">
            <div>
              {block.kind === 'embed' ? (
                <PlayCircle className="mx-auto h-7 w-7 text-ink-faint" aria-hidden />
              ) : (
                <ImageOff className="mx-auto h-7 w-7 text-ink-faint" aria-hidden />
              )}
              <p className="mt-2 text-xs text-ink-muted">
                {block.kind === 'embed'
                  ? 'Pega el enlace de un video de YouTube o Loom, un mapa de Google o una presentación publicada.'
                  : 'Pega la dirección https:// de una imagen.'}
              </p>
            </div>
          </div>
        ) : block.kind === 'embed' ? (
          <iframe
            src={src}
            title={block.title ?? block.alt ?? 'Contenido insertado'}
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            sandbox="allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox"
            allow="fullscreen; picture-in-picture; encrypted-media"
            allowFullScreen
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : failed ? (
          <div className="absolute inset-0 grid place-items-center p-4 text-center">
            <p className="text-xs text-ink-muted">No se pudo cargar la imagen.</p>
          </div>
        ) : (
          <img
            src={src}
            alt={block.alt ?? block.title ?? ''}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
            className="absolute inset-0 h-full w-full object-cover"
          />
        )}
      </div>
      {block.caption && (
        <p className="mt-2 text-xs leading-relaxed text-ink-muted">{block.caption}</p>
      )}
    </Card>
  );
}

const BUTTON: Record<Tone, string> = {
  primary: 'border-primary/30 bg-primary-soft text-primary hover:border-primary/60',
  emerald: 'border-emerald/30 bg-emerald-soft text-emerald hover:border-emerald/60',
  amber: 'border-amber/30 bg-amber-soft text-amber hover:border-amber/60',
  sky: 'border-sky/30 bg-sky-soft text-sky hover:border-sky/60',
  rose: 'border-rose/30 bg-rose-soft text-rose hover:border-rose/60',
};

export function LinksBlock({ block }: { block: Links }) {
  const { density } = useViewTheme();
  const external = (l: Links['links'][number]) =>
    l.external ? { target: '_blank', rel: 'noopener noreferrer nofollow' } : {};
  if (block.style === 'cards')
    return (
      <div>
        {block.title && <h2 className="mb-2 px-1 text-sm font-semibold text-ink">{block.title}</h2>}
        <ul
          className={clsx(
            'grid grid-cols-1 sm:grid-cols-2',
            density === 'compact' ? 'gap-2' : 'gap-3',
          )}
        >
          {block.links.map((l) => (
            <li key={`${l.label}-${l.href}`}>
              <a
                href={l.href}
                {...external(l)}
                className={clsx(
                  'group flex h-full items-start gap-3 rounded-card border bg-surface p-4 shadow-card transition-all duration-150 hover:-translate-y-px hover:shadow-pop',
                  TONE_RING[l.tone],
                )}
              >
                <span
                  className={clsx(
                    'grid h-8 w-8 shrink-0 place-items-center rounded-sm',
                    TONE_SOFT[l.tone],
                  )}
                >
                  {l.external ? (
                    <ExternalLink className="h-4 w-4" aria-hidden />
                  ) : (
                    <ArrowUpRight className="h-4 w-4" aria-hidden />
                  )}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">{l.label}</span>
                  {l.description && (
                    <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                      {l.description}
                    </span>
                  )}
                  {l.external && <span className="sr-only"> (se abre en otra pestaña)</span>}
                </span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <div className="px-1">
      {block.title && <h2 className="mb-2 text-sm font-semibold text-ink">{block.title}</h2>}
      <ul className="flex flex-wrap gap-2">
        {block.links.map((l) => (
          <li key={`${l.label}-${l.href}`}>
            <a
              href={l.href}
              {...external(l)}
              title={l.description ?? undefined}
              className={clsx(
                'inline-flex min-h-9 items-center gap-1.5 rounded-pill border px-3.5 py-1.5 text-sm font-semibold transition-all duration-150 hover:-translate-y-px',
                BUTTON[l.tone],
              )}
            >
              {l.label}
              {l.external ? (
                <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              )}
              {l.external && <span className="sr-only"> (se abre en otra pestaña)</span>}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
