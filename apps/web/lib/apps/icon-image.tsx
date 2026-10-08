import 'server-only';
import { readAppImage } from '@/lib/apps/app-assets';
import { appColor } from '@/lib/apps/manifest';
import { readBranding } from '@/lib/branding/store';
import type { PublishedApp } from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ImageResponse } from 'next/og';

/**
 * El ícono de una app instalable, dibujado al pedirlo: el emoji de la app
 * sobre el color de la marca, o la inicial del nombre cuando el ícono es una
 * URL (un logo remoto no se descarga aquí: es una petición a un tercero desde
 * el servidor por cada ícono). `maskable` deja un margen de seguridad del 20%
 * para que Android pueda recortarlo en círculo sin cortar el dibujo.
 */

const HTTP_ICON = /^https?:\/\//i;

function glyphOf(app: Pick<PublishedApp, 'icon' | 'name'>): string {
  const icon = app.icon.trim();
  if (icon && !HTTP_ICON.test(icon)) return [...icon].slice(0, 2).join('');
  return ([...app.name.trim()][0] ?? 'A').toUpperCase();
}

export async function appIconResponse(
  db: SupabaseClient,
  app: PublishedApp,
  size: number,
  options: { maskable?: boolean } = {},
): Promise<Response> {
  const brand = await readBranding(db).catch(() => null);
  const color = appColor(app, brand?.primary_color);
  const glyph = glyphOf(app);
  const inner = options.maskable ? size * 0.5 : size * 0.62;
  // Si la app subió su ícono (o, a falta de él, su logo), ése es el ícono:
  // sobre su color, con el margen de seguridad si es maskable.
  const own =
    (await readAppImage(db, app, 'icon').catch(() => null)) ??
    (await readAppImage(db, app, 'logo').catch(() => null));
  if (own) {
    const src = `data:${own.contentType};base64,${Buffer.from(own.content).toString('base64')}`;
    const pad = options.maskable ? size * 0.2 : size * 0.12;
    const image = new ImageResponse(
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#ffffff',
          borderRadius: options.maskable ? 0 : size * 0.22,
        }}
      >
        <img
          src={src}
          width={size - pad * 2}
          height={size - pad * 2}
          style={{ objectFit: 'contain' }}
          alt=""
        />
      </div>,
      { width: size, height: size },
    );
    try {
      await image.clone().arrayBuffer();
      return withCache(image);
    } catch {
      // cae al dibujo de siempre
    }
  }
  const draw = (text: string) =>
    new ImageResponse(
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: color,
          color: '#ffffff',
          fontSize: inner,
          fontWeight: 800,
          // Un cuadrado con las esquinas suaves; maskable va a sangre completa.
          borderRadius: options.maskable ? 0 : size * 0.22,
        }}
      >
        {text}
      </div>,
      { width: size, height: size },
    );
  try {
    const image = draw(glyph);
    // Fuerza el dibujo ahora: si el emoji no se pudo cargar, cae a la inicial.
    await image.clone().arrayBuffer();
    return withCache(image);
  } catch {
    return withCache(draw(([...app.name.trim()][0] ?? 'A').toUpperCase()));
  }
}

function withCache(res: Response): Response {
  res.headers.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
  return res;
}
