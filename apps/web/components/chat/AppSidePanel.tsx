'use client';

import { AppPreviewPanel } from '@/components/apps/AppPreviewPanel';
import { type AppPanelInfo, appPanelInfoAction } from '@/lib/apps/panel-actions';
import { publishAppAction } from '@/lib/apps/phase6-actions';
import {
  type AppPanelMode,
  availableModes,
  editNote,
  newChanges,
  parsePanelMessage,
  publishNote,
  resolveMode,
  statusLabel,
} from '@/lib/chat-app-panel';
import { clsx } from 'clsx';
import {
  ExternalLink,
  Eye,
  Loader2,
  MessageSquareShare,
  Monitor,
  Moon,
  Pencil,
  RefreshCw,
  Send,
  Smartphone,
  Sun,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useChatArtifacts } from './ChatArtifacts';
import { useChatCompose } from './ChatCompose';

export type { AppPanelInfo };

/** Datos de muestra para las pantallas de prueba (sin sesión ni base). */
export interface AppPanelFixture {
  info: AppPanelInfo;
  draft: unknown;
  previews: Record<string, unknown>;
}

/**
 * LA APP AL LADO DEL CHAT.
 *
 * Dos modos arriba: «Vista» (la app corriendo con el BORRADOR, con «Ver como»,
 * teléfono o ancho, claro u oscuro) y «Editar» (el mismo `AppEditor` de
 * /apps/<id>/edit en su diseño compacto). Los dos son páginas sin espacio de
 * trabajo (/panel/apps/<id>/vista y /editar) dentro de un iframe del mismo
 * origen: así se reutilizan las mismas acciones de servidor y los mismos
 * permisos, y la app ve un ancho de pantalla de verdad.
 *
 * Sincronía en los dos sentidos:
 *  - Lo que la persona edita avisa por postMessage (EmbedBridge) y la vista se
 *    recarga al instante; el editor NO se recarga (se perdería lo que escribe).
 *  - Cuando Cortex cambia la app desde el chat, `appSync` sube y se recargan los
 *    dos. Cortex se entera de lo que editó la persona sólo si pulsa «Contarle a
 *    Cortex» o al publicar: nunca solo por cada tecla.
 *
 * Quien no administra la app (`canEdit` falso) sólo recibe «Vista».
 */

const chip = (on: boolean) =>
  clsx(
    'inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3 text-xs font-semibold transition-colors duration-150 motion-reduce:transition-none',
    on ? 'bg-primary-soft text-primary-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
  );

function Frame({
  src,
  title,
  phone,
  theme,
  frameRef,
}: {
  src: string;
  title: string;
  phone?: boolean;
  theme?: 'light' | 'dark' | undefined;
  frameRef?: React.RefObject<HTMLIFrameElement | null>;
}) {
  const [loaded, setLoaded] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: una dirección nueva vuelve a cargar.
  useEffect(() => setLoaded(false), [src]);
  return (
    <div
      className={clsx(
        'relative min-h-0 flex-1',
        phone && 'flex justify-center bg-surface-2 px-3 py-3',
      )}
    >
      <div
        className={clsx(
          'relative h-full overflow-hidden bg-canvas',
          phone
            ? 'w-[410px] max-w-full rounded-[2.25rem] border-[10px] border-ink/80 shadow-pop'
            : 'w-full',
        )}
      >
        {!loaded && (
          <div className="absolute inset-0 z-10 grid place-items-center bg-surface text-ink-faint">
            <Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando" />
          </div>
        )}
        <iframe
          ref={frameRef}
          title={title}
          src={src}
          onLoad={(e) => {
            setLoaded(true);
            if (!theme) return;
            try {
              const doc = (e.currentTarget as HTMLIFrameElement).contentDocument;
              if (doc) doc.documentElement.dataset.theme = theme;
            } catch {
              /* otro origen: lo resuelve ?tema= */
            }
          }}
          className="h-full w-full border-0"
          style={theme ? { colorScheme: theme } : undefined}
        />
      </div>
    </div>
  );
}

export function AppSidePanel() {
  const api = useChatArtifacts();
  if (!api?.app) return null;
  return <AppSideInner key={api.app.id} />;
}

function AppSideInner() {
  const api = useChatArtifacts();
  const compose = useChatCompose();
  const app = api?.app;
  const fixture = api?.appFixture;
  const [info, setInfo] = useState<AppPanelInfo | null>(fixture?.info ?? null);
  const [error, setError] = useState<string | null>(null);
  const [previewKey, setPreviewKey] = useState(0);
  const [phone, setPhone] = useState(true);
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
      ? 'dark'
      : 'light',
  );
  const [role, setRole] = useState('');
  const [told, setTold] = useState<string[] | null>(fixture ? fixture.info.changes : null);
  const [publishing, setPublishing] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [note, setNote] = useState('');
  const [publishError, setPublishError] = useState<string | null>(null);
  const editor = useRef<HTMLIFrameElement | null>(null);
  const appId = app?.id ?? '';
  const appSync = api?.appSync ?? 0;

  const load = useCallback(
    async (kind: 'cortex' | 'editor' | 'publish' | 'open') => {
      if (fixture || !appId) return null;
      const res = await appPanelInfoAction(appId);
      if (!res.ok) {
        setError(res.error);
        return null;
      }
      setError(null);
      setInfo(res.info);
      // Lo que Cortex hizo o lo que ya se le contó no es «pendiente».
      if (kind === 'open' || kind === 'cortex' || kind === 'publish') setTold(res.info.changes);
      return res.info;
    },
    [appId, fixture],
  );

  // Al abrir, y cada vez que Cortex cambia la app desde el chat.
  const first = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `appSync` es la señal.
  useEffect(() => {
    const kind = first.current ? 'open' : 'cortex';
    first.current = false;
    void load(kind);
    if (kind === 'cortex') setPreviewKey((k) => k + 1);
  }, [appSync, load]);

  // Lo que se edita en el panel refresca la vista al instante.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      if (!parsePanelMessage(e.data, appId)) return;
      setPreviewKey((k) => k + 1);
      void load('editor');
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [appId, load]);

  if (!app || !api) return null;
  const canEdit = info?.canEdit ?? false;
  const mode: AppPanelMode = resolveMode(api.appMode, canEdit);
  const modes = availableModes(canEdit);
  const pending = info && told ? newChanges(told, info.changes) : [];
  const name = info?.name ?? app.name;
  const status = info?.status ?? app.status;
  const label = statusLabel(status, info?.publishedNumber ?? app.version);
  const fullHref = `/apps/${app.id}/edit`;
  const como = role ? `como=${encodeURIComponent(role)}&` : '';
  const vistaSrc = `/panel/apps/${encodeURIComponent(app.id)}/vista?${como}tema=${theme}&k=${previewKey}`;
  const editSrc = fixture
    ? '/v/app-editor-showcase?panel=1'
    : `/panel/apps/${encodeURIComponent(app.id)}/editar?k=${appSync}`;

  function tellCortex() {
    if (!compose || !info || pending.length === 0) return;
    compose.ask(editNote(info.name, pending));
    setTold(info.changes);
  }

  async function publish() {
    if (!info) return;
    setPublishing(true);
    setPublishError(null);
    const res = await publishAppAction(info.id, note.trim() || undefined);
    setPublishing(false);
    if (!res.ok) return setPublishError(res.error);
    setPublishOpen(false);
    const sent = note;
    setNote('');
    setPreviewKey((k) => k + 1);
    await load('publish');
    // Al publicar sí se le cuenta a Cortex (una vez), salvo que esté contestando.
    if (compose && !api?.turn?.working) compose.ask(publishNote(info.name, res.number, sent));
  }

  const dirty = status !== 'published' || info?.hasChanges !== false;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <div
          role="tablist"
          aria-label="Modo de la app"
          className="inline-flex items-center gap-0.5 rounded-pill border border-border bg-surface p-0.5"
        >
          {modes.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              onClick={() => api.setAppMode(m)}
              className={chip(mode === m)}
            >
              {m === 'vista' ? (
                <Eye className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <Pencil className="h-3.5 w-3.5" aria-hidden />
              )}
              {m === 'vista' ? 'Vista' : 'Editar'}
            </button>
          ))}
        </div>
        <span
          className={clsx(
            'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-micro font-semibold',
            status === 'published' ? 'bg-emerald-soft text-emerald' : 'bg-amber-soft text-amber',
          )}
        >
          <span
            aria-hidden
            className={clsx(
              'h-1.5 w-1.5 rounded-full',
              status === 'published' ? 'bg-emerald' : 'bg-amber',
            )}
          />
          {label}
        </span>
        <span className="min-w-0 flex-1" />
        {canEdit && pending.length > 0 && compose && (
          <button
            type="button"
            onClick={tellCortex}
            title="Cortex no se entera de lo que editas aquí hasta que se lo cuentes"
            className="inline-flex min-h-8 items-center gap-1.5 rounded-pill border border-border px-3 text-xs font-semibold text-ink hover:bg-surface-2"
          >
            <MessageSquareShare className="h-3.5 w-3.5" aria-hidden />
            Contarle a Cortex ({pending.length})
          </button>
        )}
        {canEdit && info && (
          <div className="relative">
            <button
              type="button"
              disabled={publishing || (status === 'published' && !dirty)}
              onClick={() => setPublishOpen((o) => !o)}
              aria-expanded={publishOpen}
              className={clsx(
                'inline-flex min-h-8 items-center gap-1.5 rounded-pill px-3.5 text-xs font-semibold transition-colors duration-150 disabled:opacity-50 motion-reduce:transition-none',
                dirty
                  ? 'bg-primary text-white shadow-card hover:bg-primary-strong'
                  : 'border border-border text-ink-muted',
              )}
            >
              <Send className="h-3.5 w-3.5" aria-hidden />
              {status !== 'published' ? 'Publicar' : dirty ? 'Publicar cambios' : 'Todo publicado'}
            </button>
            {publishOpen && (
              <div className="absolute right-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-2rem))] space-y-2 rounded-card border border-border bg-surface p-3 shadow-pop">
                <p className="text-xs font-semibold text-ink">
                  Se publicará como versión {(info.publishedNumber ?? 0) + 1}
                </p>
                {info.changes.length > 0 && (
                  <ul className="max-h-28 list-disc space-y-0.5 overflow-auto pl-4 text-xs text-ink-muted">
                    {info.changes.slice(0, 6).map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                )}
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  maxLength={200}
                  placeholder="Nota de la versión (opcional)"
                  className="h-9 w-full rounded-pill border border-border bg-surface px-3 text-xs text-ink outline-none focus:border-primary"
                />
                {publishError && <p className="text-xs text-rose">{publishError}</p>}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setPublishOpen(false)}
                    className="min-h-8 rounded-pill px-3 text-xs font-semibold text-ink-muted hover:text-ink"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={() => void publish()}
                    disabled={publishing}
                    className="inline-flex min-h-8 items-center gap-1.5 rounded-pill bg-primary px-3.5 text-xs font-semibold text-white hover:bg-primary-strong disabled:opacity-60"
                  >
                    {publishing && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
                    Publicar
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
        {canEdit && (
          <a
            href={fullHref}
            target="_blank"
            rel="noreferrer"
            title="Abrir en pestaña completa"
            aria-label="Abrir en pestaña completa"
            className="grid h-8 w-8 place-items-center rounded-full text-ink-muted transition-colors duration-150 hover:bg-surface-2 hover:text-ink motion-reduce:transition-none"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
          </a>
        )}
      </div>

      {!info && !error && (
        <div className="grid flex-1 place-items-center text-ink-faint">
          <Loader2 className="h-5 w-5 animate-spin" aria-label="Cargando" />
        </div>
      )}

      {error && !info && (
        <p className="m-4 rounded-card border border-dashed border-border px-4 py-6 text-sm text-ink-muted">
          {error}
        </p>
      )}

      {mode === 'vista' && !fixture && info && (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-1.5">
            {canEdit && info.roles.length > 0 && (
              <label className="flex items-center gap-2 text-xs font-semibold text-ink-muted">
                Ver como
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="h-8 max-w-[10rem] rounded-pill border border-border bg-surface px-3 text-xs font-semibold text-ink outline-none focus:border-primary"
                >
                  <option value="">Administrador</option>
                  {info.roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <span className="min-w-0 flex-1" />
            <div className="flex items-center gap-0.5 rounded-pill border border-border bg-surface p-0.5">
              <button
                type="button"
                aria-pressed={phone}
                onClick={() => setPhone(true)}
                className={chip(phone)}
                title="Teléfono"
              >
                <Smartphone className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden sm:inline">Teléfono</span>
              </button>
              <button
                type="button"
                aria-pressed={!phone}
                onClick={() => setPhone(false)}
                className={chip(!phone)}
                title="Ancho"
              >
                <Monitor className="h-3.5 w-3.5" aria-hidden />
                <span className="hidden sm:inline">Ancho</span>
              </button>
            </div>
            <div className="flex items-center gap-0.5 rounded-pill border border-border bg-surface p-0.5">
              <button
                type="button"
                aria-pressed={theme === 'light'}
                onClick={() => setTheme('light')}
                className={chip(theme === 'light')}
                title="Claro"
              >
                <Sun className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">Claro</span>
              </button>
              <button
                type="button"
                aria-pressed={theme === 'dark'}
                onClick={() => setTheme('dark')}
                className={chip(theme === 'dark')}
                title="Oscuro"
              >
                <Moon className="h-3.5 w-3.5" aria-hidden />
                <span className="sr-only">Oscuro</span>
              </button>
            </div>
            <button
              type="button"
              onClick={() => setPreviewKey((k) => k + 1)}
              title="Recargar la vista"
              aria-label="Recargar la vista"
              className="grid h-8 w-8 place-items-center rounded-full text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            </button>
          </div>
          <Frame src={vistaSrc} title={`Vista de ${name}`} phone={phone} theme={theme} />
        </>
      )}

      {mode === 'vista' && fixture && (
        <div className="scroll-slim min-h-0 flex-1 overflow-y-auto p-4">
          <AppPreviewPanel draft={fixture.draft} fixtures={fixture.previews} />
        </div>
      )}

      {mode === 'editar' && canEdit && (
        <Frame src={editSrc} title={`Editor de ${name}`} frameRef={editor} />
      )}
    </div>
  );
}
