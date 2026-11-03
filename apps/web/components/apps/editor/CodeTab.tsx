'use client';

import { confirmDialog } from '@/lib/ui/dialog-queue';
import {
  addCodeScreen,
  build as buildCode,
  publish as publishBuild,
  readCode,
  saveFiles,
} from '@/lib/apps/code-actions';
import { clsx } from 'clsx';
import { Eye, FilePlus2, Hammer, Loader2, Rocket, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  type AppEditorData,
  BTN_PRIMARY,
  BTN_SECONDARY,
  ErrorLine,
  INPUT,
  Section,
} from './shared';

/**
 * «CÓDIGO» (apps con código): los archivos del proyecto, un editor de texto,
 * compilar, ver el registro, publicar y abrir una vista previa de cualquier
 * compilación. Es un editor sencillo a propósito (un <textarea>): lo pesado
 * —tipos, compilación, pruebas— lo hace el servidor al compilar. Cortex y los
 * desarrolladores escriben sobre los mismos archivos; el borrador se guarda
 * aparte de lo publicado, así que guardar nunca cambia lo que ve el equipo.
 */

// Forma que se espera de las acciones de servidor (lib/apps/code-actions.ts).
interface CodeBuild {
  id: string;
  number: number;
  status: 'ok' | 'error';
  log: string;
  createdAt: string;
}
interface CodeScreenInfo {
  slug: string;
  title: string;
  codeEntry: string | null;
}
interface CodeState {
  files: Record<string, string>;
  builds: CodeBuild[];
  publishedBuildId: string | null;
  screens: CodeScreenInfo[];
}

const SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;

function when(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
}

/** El registro con los errores marcados (líneas con «error», «✘» o «ERROR»). */
function LogView({ log }: { log: string }) {
  const lines = log.split('\n');
  return (
    <pre className="max-h-64 overflow-auto rounded-card bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
      {lines.map((line, i) => {
        const bad = /error|✘|failed|no se pudo/i.test(line);
        // biome-ignore lint/suspicious/noArrayIndexKey: líneas de un registro, no cambian de orden.
        return (
          <span key={i} className={clsx('block', bad && 'bg-rose-soft font-semibold text-rose')}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

export function CodeTab({ data }: { data: AppEditorData }) {
  const appId = data.app.id;
  const [state, setState] = useState<CodeState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // El borrador local: lo escrito en pantalla y lo que se quitó, hasta guardar.
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'save' | 'build' | 'publish' | 'screen'>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [shownLog, setShownLog] = useState<string | null>(null);
  const [previewScreen, setPreviewScreen] = useState('');
  const [newFile, setNewFile] = useState('');
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await readCode(appId);
      setState(res);
      setDraft({ ...res.files });
      setRemoved([]);
      setSelected((cur) => (cur && cur in res.files ? cur : (Object.keys(res.files).sort()[0] ?? null)));
      setShownLog(res.builds[0]?.log ?? null);
      setPreviewScreen((cur) => cur || res.screens[0]?.slug || '');
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'No se pudo abrir el código.');
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  const paths = useMemo(() => Object.keys(draft).sort(), [draft]);
  const dirtyPaths = useMemo(
    () => (state ? paths.filter((p) => draft[p] !== state.files[p]) : []),
    [paths, draft, state],
  );
  const dirty = dirtyPaths.length > 0 || removed.length > 0;

  /** Guarda lo pendiente; devuelve false si falló (el error queda a la vista). */
  async function persist(): Promise<boolean> {
    if (!dirty) return true;
    setBusy('save');
    setError(null);
    try {
      const write: Record<string, string> = {};
      for (const p of dirtyPaths) write[p] = draft[p] ?? '';
      const res = await saveFiles(appId, { write, remove: removed });
      if ('error' in res && res.error) {
        setError(res.error);
        return false;
      }
      setState((s) => (s ? { ...s, files: { ...draft } } : s));
      setRemoved([]);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo guardar.');
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    setNote(null);
    if (await persist()) setNote('Guardado.');
  }

  async function onBuild() {
    setNote(null);
    if (!(await persist())) return;
    setBusy('build');
    try {
      const res = await buildCode(appId);
      if ('error' in res && res.error) setError(res.error);
      else if ('build' in res && res.build) {
        const b = res.build as CodeBuild;
        setShownLog(b.log);
        setNote(
          b.status === 'ok'
            ? `Compilación #${b.number} lista.`
            : `La compilación #${b.number} tiene errores.`,
        );
      }
      await refreshBuilds();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo compilar.');
    } finally {
      setBusy(null);
    }
  }

  /** Vuelve a leer solo la lista de compilaciones, sin pisar lo escrito. */
  async function refreshBuilds() {
    const res = await readCode(appId);
    setState((s) =>
      s ? { ...s, builds: res.builds, publishedBuildId: res.publishedBuildId, screens: res.screens } : s,
    );
  }

  async function onPublish(b: CodeBuild) {
    const ok = await confirmDialog({
      title: `¿Publicar la compilación #${b.number}?`,
      message: 'Todo el equipo verá esta versión de las pantallas con código.',
      confirmLabel: 'Publicar',
    });
    if (!ok) return;
    setBusy('publish');
    setError(null);
    setNote(null);
    try {
      const res = await publishBuild(appId, b.id);
      if ('error' in res && res.error) setError(res.error);
      else {
        setNote(`Compilación #${b.number} publicada.`);
        await refreshBuilds();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo publicar.');
    } finally {
      setBusy(null);
    }
  }

  async function onAddScreen() {
    setError(null);
    setNote(null);
    if (!SLUG_RE.test(slug)) {
      return setError('El nombre corto va en minúsculas, con números o guion bajo (ej. torre_control).');
    }
    if (!title.trim()) return setError('Ponle un título a la pantalla.');
    if (dirty && !(await persist())) return;
    setBusy('screen');
    try {
      const res = await addCodeScreen(appId, { slug, title: title.trim() });
      if ('error' in res && res.error) return setError(res.error);
      setSlug('');
      setTitle('');
      setNote('Pantalla creada. Compila para verla.');
      await load();
      setSelected(`screens/${slug}.tsx`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo crear la pantalla.');
    } finally {
      setBusy(null);
    }
  }

  function addFile() {
    const path = newFile.trim();
    if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.includes('..') || path.startsWith('/')) {
      return setError('Ruta no válida: usa letras, números, «/», «.», «-» y «_».');
    }
    if (path in draft) return setSelected(path);
    setError(null);
    setDraft((d) => ({ ...d, [path]: '' }));
    setRemoved((r) => r.filter((x) => x !== path));
    setSelected(path);
    setNewFile('');
  }

  async function removeFile(path: string) {
    if (!(await confirmDialog({ title: `¿Borrar ${path}?`, tone: 'danger', confirmLabel: 'Borrar' }))) return;
    setDraft((d) => {
      const { [path]: _gone, ...rest } = d;
      return rest;
    });
    if (state && path in state.files) setRemoved((r) => [...r, path]);
    setSelected((cur) => (cur === path ? null : cur));
  }

  /** Tab inserta dos espacios (y Mayús+Tab los quita) en vez de saltar el foco. */
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      void onSave();
      return;
    }
    if (e.key !== 'Tab' || !selected) return;
    e.preventDefault();
    const el = e.currentTarget;
    const { selectionStart: a, selectionEnd: b, value } = el;
    let next: string;
    let caret: number;
    if (e.shiftKey) {
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      if (!value.startsWith('  ', lineStart)) return;
      next = value.slice(0, lineStart) + value.slice(lineStart + 2);
      caret = Math.max(lineStart, a - 2);
    } else {
      next = `${value.slice(0, a)}  ${value.slice(b)}`;
      caret = a + 2;
    }
    setDraft((d) => ({ ...d, [selected]: next }));
    requestAnimationFrame(() => {
      area.current?.setSelectionRange(caret, caret);
    });
  }

  if (loadError) return <ErrorLine error={loadError} />;
  if (!state) {
    return (
      <p className="flex items-center gap-2 text-xs text-ink-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Abriendo el código…
      </p>
    );
  }

  const working = busy !== null;
  const previewBuild = state.builds.find((b) => b.status === 'ok');

  return (
    <div className="space-y-4">
      <Section
        title="Archivos"
        help="Pantallas en screens/, código compartido en lib/. Guardar no cambia lo que ve el equipo; solo publicar lo hace."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={BTN_SECONDARY} disabled={working || !dirty} onClick={onSave}>
              {busy === 'save' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Save className="h-3.5 w-3.5" aria-hidden />}
              Guardar
            </button>
            <button type="button" className={BTN_PRIMARY} disabled={working} onClick={onBuild}>
              {busy === 'build' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Hammer className="h-3.5 w-3.5" aria-hidden />}
              Compilar
            </button>
          </div>
        }
      >
        <ErrorLine error={error} />
        {note && !error && <p className="text-xs font-semibold text-emerald">{note}</p>}
        <div className="grid gap-3 md:grid-cols-[14rem_1fr]">
          <div className="space-y-2">
            <ul className="max-h-80 space-y-0.5 overflow-auto rounded-card border border-border bg-surface-2 p-1.5 font-mono text-[11px]">
              {paths.length === 0 && <li className="px-2 py-1 text-ink-faint">Sin archivos todavía.</li>}
              {paths.map((p) => {
                const parts = p.split('/');
                const name = parts.pop() ?? p;
                return (
                  <li key={p} className="group flex items-center">
                    <button
                      type="button"
                      onClick={() => setSelected(p)}
                      title={p}
                      className={clsx(
                        'min-w-0 flex-1 truncate rounded px-2 py-1 text-left',
                        selected === p ? 'bg-primary-soft text-primary-ink' : 'text-ink hover:bg-surface',
                      )}
                    >
                      {parts.length > 0 && <span className="text-ink-faint">{parts.join('/')}/</span>}
                      {name}
                      {dirtyPaths.includes(p) && <span className="text-amber"> ●</span>}
                    </button>
                    <button
                      type="button"
                      aria-label={`Borrar ${p}`}
                      onClick={() => void removeFile(p)}
                      className="px-1 text-ink-faint opacity-0 hover:text-rose focus:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3 w-3" aria-hidden />
                    </button>
                  </li>
                );
              })}
            </ul>
            <div className="flex gap-1.5">
              <input
                value={newFile}
                onChange={(e) => setNewFile(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addFile()}
                placeholder="lib/utils.ts"
                aria-label="Ruta del archivo nuevo"
                className={clsx(INPUT, 'min-w-0 flex-1 font-mono')}
              />
              <button type="button" className={BTN_SECONDARY} onClick={addFile} aria-label="Agregar archivo">
                <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>

          <div className="min-w-0">
            {selected ? (
              <textarea
                ref={area}
                value={draft[selected] ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, [selected]: e.target.value }))}
                onKeyDown={onKeyDown}
                spellCheck={false}
                autoCapitalize="off"
                autoCorrect="off"
                aria-label={`Contenido de ${selected}`}
                wrap="off"
                className="h-96 w-full resize-y rounded-card border border-border bg-surface p-3 font-mono text-xs leading-relaxed text-ink outline-none focus:border-primary [tab-size:2]"
              />
            ) : (
              <p className="grid h-40 place-items-center rounded-card border border-dashed border-border-strong text-xs text-ink-muted">
                Elige un archivo para editarlo.
              </p>
            )}
          </div>
        </div>
      </Section>

      <Section
        title="Pantallas con código"
        help="Cada una es una pantalla más del menú de la app, con la misma regla de roles."
      >
        {state.screens.length > 0 && (
          <ul className="space-y-1 text-xs text-ink">
            {state.screens.map((s) => (
              <li key={s.slug} className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{s.title}</span>
                <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
                  {s.codeEntry ?? `screens/${s.slug}.tsx`}
                </code>
                {s.codeEntry && (
                  <button type="button" className="text-primary hover:underline" onClick={() => setSelected(s.codeEntry)}>
                    Editar
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            placeholder="nombre_corto"
            aria-label="Nombre corto de la pantalla"
            className={clsx(INPUT, 'w-40 font-mono')}
          />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título (ej. Torre de control)"
            aria-label="Título de la pantalla"
            className={clsx(INPUT, 'w-56')}
          />
          <button type="button" className={BTN_SECONDARY} disabled={working} onClick={onAddScreen}>
            {busy === 'screen' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <FilePlus2 className="h-3.5 w-3.5" aria-hidden />}
            Nueva pantalla con código
          </button>
        </div>
      </Section>

      <Section title="Compilaciones" help="Se guardan las últimas 30. La publicada es la que ve el equipo.">
        {state.builds.length === 0 ? (
          <p className="text-xs text-ink-muted">Aún no has compilado. Pulsa «Compilar».</p>
        ) : (
          <>
            {state.screens.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-ink-muted">
                Vista previa de
                <select
                  value={previewScreen}
                  onChange={(e) => setPreviewScreen(e.target.value)}
                  className={INPUT}
                >
                  {state.screens.map((s) => (
                    <option key={s.slug} value={s.slug}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <ul className="divide-y divide-border rounded-card border border-border">
              {state.builds.map((b) => {
                const isPublished = b.id === state.publishedBuildId;
                return (
                  <li key={b.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                    <span className="font-semibold text-ink">#{b.number}</span>
                    <span
                      className={clsx(
                        'rounded-pill px-2 py-0.5 text-micro font-semibold',
                        b.status === 'ok' ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
                      )}
                    >
                      {b.status === 'ok' ? 'Lista' : 'Con errores'}
                    </span>
                    {isPublished && (
                      <span className="rounded-pill bg-primary-soft px-2 py-0.5 text-micro font-semibold text-primary-ink">
                        Publicada
                      </span>
                    )}
                    <span className="text-ink-faint">{when(b.createdAt)}</span>
                    <span className="ml-auto flex items-center gap-1.5">
                      <button type="button" className={BTN_SECONDARY} onClick={() => setShownLog(b.log)}>
                        Ver registro
                      </button>
                      {b.status === 'ok' && previewScreen && (
                        <a
                          className={BTN_SECONDARY}
                          href={`/apps/${data.app.slug}/${previewScreen}?build=${b.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <Eye className="h-3.5 w-3.5" aria-hidden /> Vista previa
                        </a>
                      )}
                      {b.status === 'ok' && !isPublished && (
                        <button type="button" className={BTN_PRIMARY} disabled={working} onClick={() => void onPublish(b)}>
                          {busy === 'publish' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Rocket className="h-3.5 w-3.5" aria-hidden />}
                          Publicar
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {shownLog !== null && (shownLog.trim() ? <LogView log={shownLog} /> : <p className="text-xs text-ink-muted">El registro está vacío.</p>)}
        {!previewBuild && state.builds.length > 0 && (
          <p className="text-xs text-ink-muted">Ninguna compilación salió bien todavía: corrige los errores del registro.</p>
        )}
      </Section>
    </div>
  );
}
