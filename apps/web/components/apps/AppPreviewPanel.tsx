'use client';

import { clsx } from 'clsx';
import { Monitor, Moon, Smartphone, Sun } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * «VISTA PREVIA DE LA APP»: el borrador corriendo ANTES de crearlo.
 *
 * Un iframe a /v/app-preview (mismo origen) pinta la app real —AppRunner, las
 * mismas pantallas— con filas de ejemplo; este panel le habla por postMessage:
 * qué rol mira («Ver como»), claro u oscuro, y qué pantalla. Las pantallas son
 * pestañas arriba; en «Teléfono» el iframe mide 390 px (la app ve un teléfono
 * de verdad) y en «Ancho» 1100 px, reducido para caber. No guarda nada.
 */

interface PreviewState {
  roles: Array<{ key: string; name: string }>;
  screens: Array<{ slug: string; title: string }>;
  screen: string | null;
  notes: string[];
  samples: Array<{ slug: string; name: string; rows: number }>;
}

const PHONE = { w: 390, h: 720 };
const WIDE = { w: 1100, h: 700 };

export function AppPreviewPanel({
  draft,
  fixtures,
  initialPhone = true,
  initialTheme = 'light',
  className,
}: {
  /** El borrador de `apps.design` (la vista previa lo recalcula en el servidor). */
  draft: unknown;
  /** Para pantallas de prueba sin sesión: la vista ya calculada de cada rol. */
  fixtures?: Record<string, unknown>;
  initialPhone?: boolean;
  initialTheme?: 'light' | 'dark';
  className?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<PreviewState | null>(null);
  const [role, setRole] = useState<string>('administrador');
  const [theme, setTheme] = useState<'light' | 'dark'>(initialTheme);
  const [phone, setPhone] = useState(initialPhone);
  const [width, setWidth] = useState(520);

  const post = useCallback((msg: Record<string, unknown>) => {
    frame.current?.contentWindow?.postMessage(
      { type: 'cortex-preview-set', ...msg },
      window.location.origin,
    );
  }, []);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      const m = e.data as ({ type?: string } & Partial<PreviewState>) | null;
      if (m?.type === 'cortex-preview-ready') setReady(true);
      if (m?.type === 'cortex-preview-state')
        setState({
          roles: m.roles ?? [],
          screens: m.screens ?? [],
          screen: m.screen ?? null,
          notes: m.notes ?? [],
          samples: m.samples ?? [],
        });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // El borrador, el rol y el tema viajan al iframe cuando cambian (y al estar listo).
  useEffect(() => {
    if (!ready) return;
    const fixture = fixtures?.[role] ?? fixtures?.administrador;
    post({
      draft: fixtures ? undefined : draft,
      fixture,
      role: role === 'administrador' ? null : role,
      theme,
    });
  }, [ready, draft, fixtures, role, theme, post]);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const size = phone ? PHONE : WIDE;
  const scale = phone ? 1 : Math.min(1, Math.max(0.3, (width - 4) / size.w));
  const chip = (on: boolean) =>
    clsx(
      'inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold transition-colors',
      on ? 'bg-primary-soft text-primary-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
    );

  return (
    <section aria-label="Vista previa de la app" className={clsx('space-y-3', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
          Ver como
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="h-8 rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink outline-none focus:border-primary"
          >
            {(state?.roles.length
              ? state.roles
              : [{ key: 'administrador', name: 'Administrador' }]
            ).map((r) => (
              <option key={r.key} value={r.key}>
                {r.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex items-center gap-1 rounded-pill border border-border bg-surface p-0.5">
          <button
            type="button"
            aria-pressed={phone}
            onClick={() => setPhone(true)}
            className={chip(phone)}
          >
            <Smartphone className="h-3.5 w-3.5" aria-hidden /> Teléfono
          </button>
          <button
            type="button"
            aria-pressed={!phone}
            onClick={() => setPhone(false)}
            className={chip(!phone)}
          >
            <Monitor className="h-3.5 w-3.5" aria-hidden /> Ancho
          </button>
        </div>
        <div className="flex items-center gap-1 rounded-pill border border-border bg-surface p-0.5">
          <button
            type="button"
            aria-pressed={theme === 'light'}
            onClick={() => setTheme('light')}
            className={chip(theme === 'light')}
          >
            <Sun className="h-3.5 w-3.5" aria-hidden /> Claro
          </button>
          <button
            type="button"
            aria-pressed={theme === 'dark'}
            onClick={() => setTheme('dark')}
            className={chip(theme === 'dark')}
          >
            <Moon className="h-3.5 w-3.5" aria-hidden /> Oscuro
          </button>
        </div>
      </div>

      {state && state.screens.length > 0 && (
        <div
          role="tablist"
          aria-label="Pantallas de la app"
          className="scroll-slim flex gap-1 overflow-x-auto"
        >
          {state.screens.map((s) => (
            <button
              key={s.slug}
              type="button"
              role="tab"
              aria-selected={state.screen === s.slug}
              onClick={() => {
                setState({ ...state, screen: s.slug });
                post({ screen: s.slug });
              }}
              className={clsx(
                'shrink-0 whitespace-nowrap rounded-pill px-3.5 py-1.5 text-xs font-semibold transition-colors',
                state.screen === s.slug
                  ? 'bg-primary text-white shadow-card'
                  : 'border border-border bg-surface text-ink-muted hover:text-ink',
              )}
            >
              {s.title}
            </button>
          ))}
        </div>
      )}

      <div ref={holder} className="flex justify-center">
        <div
          className={clsx(
            'overflow-hidden bg-canvas',
            phone
              ? 'rounded-[2.25rem] border-[10px] border-ink/80 shadow-pop'
              : 'rounded-card border border-border shadow-card',
          )}
          style={{
            width: phone ? size.w + 20 : size.w * scale,
            height: phone ? size.h + 20 : size.h * scale,
          }}
        >
          <iframe
            ref={frame}
            title="Vista previa de la app"
            src="/v/app-preview"
            style={{
              width: size.w,
              height: size.h,
              border: 0,
              transform: phone ? undefined : `scale(${scale})`,
              transformOrigin: 'top left',
              colorScheme: theme,
            }}
          />
        </div>
      </div>

      {state && (
        <p className="text-micro leading-relaxed text-ink-faint">
          {state.samples.length > 0 &&
            `Filas de ejemplo: ${state.samples.map((s) => `${s.name} (${s.rows})`).join(', ')}. `}
          {state.notes.join(' ')}
        </p>
      )}
    </section>
  );
}
