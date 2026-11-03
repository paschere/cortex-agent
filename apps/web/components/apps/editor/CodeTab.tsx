'use client';

import {
  type CodeBuildInfo,
  type CodeSnapshot,
  addCodeScreen,
  build as buildCode,
  publish as publishBuild,
  readCode,
  saveFiles,
} from '@/lib/apps/code-actions';
import { diagnosticsFor, parseBuildDiagnostics } from '@/lib/apps/code-log';
import { confirmDialog, promptDialog } from '@/lib/ui/dialog-queue';
import { clsx } from 'clsx';
import {
  AlertTriangle,
  Columns2,
  Eye,
  FilePlus2,
  Hammer,
  Loader2,
  RefreshCw,
  Rocket,
  Save,
  Undo2,
} from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FunctionsPanel, GithubPanel, RunsPanel, SecretsPanel } from './code/DevPanels';
import { FileTree } from './code/FileTree';
import {
  type AppEditorData,
  BTN_PRIMARY,
  BTN_SECONDARY,
  ErrorLine,
  INPUT,
  Section,
} from './shared';

// El editor (CodeMirror y sus lenguajes) se baja sólo al abrir esta pestaña.
const CodeEditor = dynamic(() => import('./code/CodeEditor'), {
  ssr: false,
  loading: () => (
    <p className="grid h-full place-items-center rounded-card border border-border text-xs text-ink-muted">
      <span className="flex items-center gap-2">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> Abriendo el editor…
      </span>
    </p>
  ),
});

/**
 * «CÓDIGO» (apps con código): editor de verdad (CodeMirror 6) con árbol de
 * archivos, errores de la última compilación marcados en su línea, vista
 * previa al lado, y las secciones de desarrollador (funciones, secretos,
 * ejecuciones, GitHub). Cortex y las personas escriben sobre los mismos
 * archivos: cada guardado lleva la revisión (`updatedAt`) sobre la que se
 * editó y, si alguien cambió el código mientras tanto, se combina lo que no se
 * pisa y se pregunta por lo demás. El borrador se guarda aparte de lo
 * publicado: guardar nunca cambia lo que ve el equipo.
 */

type CodeState = CodeSnapshot;

const SLUG_RE = /^[a-z][a-z0-9_]{1,47}$/;

function when(iso: string): string {
  return new Date(iso).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' });
}

/** Misma regla que el servidor (code/files.ts), para avisar antes de guardar. */
function pathProblem(path: string): string | null {
  if (!path || path.length > 200) return 'La ruta va de 1 a 200 caracteres.';
  if (!/^[a-zA-Z0-9_./-]+$/.test(path)) return 'Usa letras, números, «/», «.», «-» y «_».';
  if (
    path.startsWith('/') ||
    path.endsWith('/') ||
    path.split('/').some((p) => p === '' || p === '.' || p === '..')
  )
    return 'La ruta no puede empezar ni terminar con «/», ni llevar «..» ni tramos vacíos.';
  return null;
}

/** El registro con los errores marcados (líneas con «error», «✘» o «ERROR»). */
function LogView({ log }: { log: string }) {
  const lines = log.split('\n');
  return (
    <pre className="max-h-64 overflow-auto rounded-card bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
      {lines.map((line, i) => {
        const bad = /error|✘|failed|no se pudo/i.test(line);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: líneas de un registro, no cambian de orden.
          <span key={i} className={clsx('block', bad && 'bg-rose-soft font-semibold text-rose')}>
            {line || ' '}
          </span>
        );
      })}
    </pre>
  );
}

/** Archivos en los que alguien más cambió lo mismo que tú: se quedó la versión de ahora hasta que decidas. */
interface Overlap {
  path: string;
  /** Lo que tenías (undefined = lo habías borrado). */
  mine: string | undefined;
  by: 'cortex' | 'other' | 'me';
}

const WHO = { cortex: 'Cortex', other: 'otra persona', me: 'tú' } as const;

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
  const [showPreview, setShowPreview] = useState(true);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [overlaps, setOverlaps] = useState<Overlap[]>([]);
  const [jump, setJump] = useState<{ line: number; col: number; nonce: number } | null>(null);
  const [slug, setSlug] = useState('');
  const [title, setTitle] = useState('');

  // Lo último que se ve en pantalla, para los avisos que corren fuera del render (foco, temporizador).
  const latest = useRef({ state, draft, removed, busy });
  latest.current = { state, draft, removed, busy };

  const load = useCallback(async () => {
    try {
      const res = await readCode(appId);
      setState(res);
      setDraft({ ...res.files });
      setRemoved([]);
      setOverlaps([]);
      setSelected((cur) =>
        cur && cur in res.files ? cur : (Object.keys(res.files).sort()[0] ?? null),
      );
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
  const pendingRemoved = useMemo(() => removed.filter((p) => !(p in draft)), [removed, draft]);
  const dirty = dirtyPaths.length > 0 || pendingRemoved.length > 0;

  // Aviso del navegador si se cierra la pestaña con cambios sin guardar.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // ---- Co-edición: ponerse al día con lo que cambió Cortex u otra persona ----

  /**
   * Adopta el código del servidor sin perder lo escrito: lo que sólo cambiaste
   * tú se queda, lo que sólo cambió el servidor entra, y donde cambiaron los
   * dos se queda la versión de ahora y el tuyo se guarda para «Conservar la mía».
   */
  const reconcile = useCallback((fresh: CodeSnapshot, announce: boolean) => {
    const { state: cur, draft: mine, removed: gone } = latest.current;
    if (!cur) return;
    const base = cur.files;
    const myPaths = new Set([...Object.keys(mine), ...Object.keys(base)]);
    const merged: Record<string, string> = { ...fresh.files };
    const clashes: Overlap[] = [];
    for (const p of myPaths) {
      const iChanged = (mine[p] ?? undefined) !== base[p] || (gone.includes(p) && !(p in mine));
      if (!iChanged) continue;
      const theyChanged = fresh.files[p] !== base[p];
      if (theyChanged && fresh.files[p] !== mine[p]) {
        clashes.push({ path: p, mine: mine[p], by: fresh.fileAuthors[p]?.by ?? 'other' });
        continue; // se queda la de ahora
      }
      if (p in mine) merged[p] = mine[p] as string;
      else delete merged[p];
    }
    setState(fresh);
    setDraft(merged);
    setRemoved(Object.keys(fresh.files).filter((p) => !(p in merged)));
    setOverlaps(clashes);
    setShownLog((l) => l ?? fresh.builds[0]?.log ?? null);
    setSelected((s) => (s && s in merged ? s : (Object.keys(merged).sort()[0] ?? null)));
    if (announce) {
      const who = Object.values(fresh.fileAuthors).some((a) => a.by === 'cortex')
        ? 'Cortex u otra persona'
        : 'Alguien';
      setNote(
        `${who} cambió el código; lo traje a tu editor${clashes.length ? ' y hay archivos por decidir' : ''}.`,
      );
    }
  }, []);

  const checkForChanges = useCallback(async () => {
    const { state: cur, busy: b } = latest.current;
    if (!cur || b !== null) return;
    try {
      const fresh = await readCode(appId);
      const nowCur = latest.current.state;
      if (!nowCur || latest.current.busy !== null) return;
      if (fresh.updatedAt !== nowCur.updatedAt) reconcile(fresh, true);
    } catch {
      // Una revisión que falla no es motivo para molestar.
    }
  }, [appId, reconcile]);

  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && void checkForChanges();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    const timer = window.setInterval(onVisible, 45_000);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.clearInterval(timer);
    };
  }, [checkForChanges]);

  // ---- Guardar, compilar, publicar ----

  /** Guarda lo pendiente; devuelve false si falló (el error queda a la vista). */
  async function persist(): Promise<boolean> {
    if (!dirty || !state) return true;
    setBusy('save');
    setError(null);
    try {
      const write: Record<string, string> = {};
      for (const p of dirtyPaths) write[p] = draft[p] ?? '';
      const res = await saveFiles(appId, {
        write,
        remove: pendingRemoved,
        baseUpdatedAt: state.updatedAt,
      });
      if (!res.ok) {
        if (res.stale) {
          const fresh = await readCode(appId);
          reconcile(fresh, false);
          setError(
            'Alguien cambió el código mientras editabas. Combiné lo que no se pisa; revisa abajo y vuelve a guardar.',
          );
        } else setError(res.error);
        return false;
      }
      const mine = Object.fromEntries(
        dirtyPaths.map((p) => [p, { by: 'me' as const, at: res.updatedAt }]),
      );
      setState((s) => {
        if (!s) return s;
        const authors = { ...s.fileAuthors, ...mine };
        for (const p of pendingRemoved) delete authors[p];
        return { ...s, files: { ...draft }, updatedAt: res.updatedAt, fileAuthors: authors };
      });
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
      if (!res.ok) setError(res.error);
      else {
        const b = res.build as CodeBuildInfo;
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

  /** Vuelve a leer sólo lo de compilaciones y pantallas, sin pisar lo escrito. */
  async function refreshBuilds() {
    const res = await readCode(appId);
    setState((s) =>
      s
        ? {
            ...s,
            builds: res.builds,
            publishedBuildId: res.publishedBuildId,
            screens: res.screens,
            github: res.github,
            ...(('functions' in res
              ? { functions: (res as { functions?: string[] }).functions }
              : {}) as object),
          }
        : s,
    );
  }

  async function onPublish(b: CodeBuildInfo) {
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
      if (!res.ok) setError(res.error);
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
      return setError(
        'El nombre corto va en minúsculas, con números o guion bajo (ej. torre_control).',
      );
    }
    if (!title.trim()) return setError('Ponle un título a la pantalla.');
    if (dirty && !(await persist())) return;
    setBusy('screen');
    try {
      const res = await addCodeScreen(appId, { slug, title: title.trim() });
      if (!res.ok) return setError(res.error);
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

  // ---- Archivos: nuevo, renombrar, borrar ----

  /** Rutas que son la entrada de una pantalla con código (no se mueven ni se borran a la ligera). */
  const entryOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of state?.screens ?? []) if (s.codeEntry) m.set(s.codeEntry, s.title);
    return m;
  }, [state]);

  async function newFile(folder: string) {
    const raw = await promptDialog({
      title: 'Archivo nuevo',
      label: 'Ruta',
      placeholder: 'lib/utils.ts',
      initial: folder ? `${folder}/` : 'lib/',
      confirmLabel: 'Crear',
    });
    const path = raw?.trim();
    if (!path) return;
    const bad = pathProblem(path);
    if (bad) return setError(bad);
    if (path in draft) return setSelected(path);
    setError(null);
    setDraft((d) => ({ ...d, [path]: '' }));
    setRemoved((r) => r.filter((x) => x !== path));
    setSelected(path);
  }

  async function renamePath(from: string, isFolder: boolean) {
    const raw = await promptDialog({
      title: isFolder ? 'Renombrar carpeta' : 'Renombrar o mover archivo',
      label: 'Nueva ruta',
      initial: from,
      confirmLabel: 'Renombrar',
    });
    const to = raw?.trim();
    if (!to || to === from) return;
    const bad = pathProblem(to);
    if (bad) return setError(bad);
    const moving = isFolder ? paths.filter((p) => p.startsWith(`${from}/`)) : [from];
    for (const p of moving) {
      const target = isFolder ? `${to}${p.slice(from.length)}` : to;
      const problem = pathProblem(target);
      if (problem) return setError(problem);
      if (target in draft && !moving.includes(target)) return setError(`Ya existe «${target}».`);
      const screen = entryOf.get(p);
      if (screen)
        return setError(
          `«${p}» es la entrada de la pantalla «${screen}»; no se puede mover desde aquí.`,
        );
    }
    setError(null);
    const map = new Map(moving.map((p) => [p, isFolder ? `${to}${p.slice(from.length)}` : to]));
    setDraft((d) => {
      const next: Record<string, string> = {};
      for (const [p, c] of Object.entries(d)) next[map.get(p) ?? p] = c;
      return next;
    });
    setRemoved((r) => {
      const next = new Set(r.filter((x) => ![...map.values()].includes(x)));
      for (const p of moving) if (state && p in state.files) next.add(p);
      return [...next];
    });
    setSelected((cur) => (cur && map.has(cur) ? (map.get(cur) as string) : cur));
  }

  async function deletePath(path: string, isFolder: boolean) {
    const victims = isFolder ? paths.filter((p) => p.startsWith(`${path}/`)) : [path];
    const entries = victims.filter((p) => entryOf.has(p));
    const ok = await confirmDialog({
      title: isFolder
        ? `¿Borrar la carpeta ${path} (${victims.length} archivos)?`
        : `¿Borrar ${path}?`,
      message: entries.length
        ? `Es la entrada de ${entries.map((p) => `«${entryOf.get(p)}»`).join(', ')}: esa pantalla dejará de compilar hasta que vuelvas a crear el archivo.`
        : 'Se quita del borrador al guardar; las compilaciones ya hechas no cambian.',
      tone: 'danger',
      confirmLabel: 'Borrar',
    });
    if (!ok) return;
    setDraft((d) => {
      const next = { ...d };
      for (const p of victims) delete next[p];
      return next;
    });
    setRemoved((r) => [...new Set([...r, ...victims.filter((p) => state && p in state.files)])]);
    setSelected((cur) => (cur && victims.includes(cur) ? null : cur));
  }

  /** Revierte un archivo a lo último guardado (o lo quita, si todavía no existía). */
  function revertSelected() {
    if (!selected || !state) return;
    if (selected in state.files)
      setDraft((d) => ({ ...d, [selected]: state.files[selected] as string }));
    else {
      setDraft((d) => {
        const { [selected]: _gone, ...rest } = d;
        return rest;
      });
      setSelected(null);
    }
  }

  // ---- Conflictos de co-edición ----

  function keepMine(o: Overlap) {
    if (o.mine === undefined) {
      setDraft((d) => {
        const { [o.path]: _gone, ...rest } = d;
        return rest;
      });
      setRemoved((r) => [...new Set([...r, o.path])]);
    } else {
      setDraft((d) => ({ ...d, [o.path]: o.mine as string }));
    }
    setOverlaps((list) => list.filter((x) => x.path !== o.path));
  }

  // ---- Errores del último registro ----

  const lastLog = state?.builds[0]?.log ?? '';
  const diagnostics = useMemo(() => parseBuildDiagnostics(lastLog), [lastLog]);
  const errorCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const d of diagnostics)
      if (d.path && d.severity === 'error') out[d.path] = (out[d.path] ?? 0) + 1;
    return out;
  }, [diagnostics]);
  const marks = useMemo(
    () => (selected ? diagnosticsFor(diagnostics, selected) : []),
    // El nuevo arreglo al cambiar de archivo hace que el editor repinte las marcas.
    [diagnostics, selected],
  );
  const dirtySet = useMemo(() => new Set(dirtyPaths), [dirtyPaths]);
  const byCortex = useMemo(
    () =>
      new Set(
        Object.entries(state?.fileAuthors ?? {})
          .filter(([, a]) => a.by === 'cortex')
          .map(([p]) => p),
      ),
    [state],
  );

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
  const selectedSlug = selected
    ? state.screens.find((s) => s.codeEntry === selected)?.slug
    : undefined;
  const shownPreview = selectedSlug ?? previewScreen;
  const authorOfSelected = selected ? state.fileAuthors[selected] : undefined;
  const functions = (state as { functions?: string[] }).functions ?? [];

  return (
    <div className="space-y-4">
      <Section
        title="Código"
        help="Pantallas en screens/, código compartido en lib/, funciones de servidor en server/. Guardar no cambia lo que ve el equipo; solo publicar lo hace."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={clsx(
                BTN_SECONDARY,
                'hidden xl:inline-flex',
                showPreview && 'border-primary/50 text-primary',
              )}
              aria-pressed={showPreview}
              onClick={() => setShowPreview((v) => !v)}
            >
              <Columns2 className="h-3.5 w-3.5" aria-hidden /> Vista previa
            </button>
            <button
              type="button"
              className={BTN_SECONDARY}
              disabled={working || !dirty}
              onClick={onSave}
              title="Ctrl/Cmd + S"
            >
              {busy === 'save' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Save className="h-3.5 w-3.5" aria-hidden />
              )}
              Guardar
            </button>
            <button type="button" className={BTN_PRIMARY} disabled={working} onClick={onBuild}>
              {busy === 'build' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Hammer className="h-3.5 w-3.5" aria-hidden />
              )}
              Compilar
            </button>
          </div>
        }
      >
        <ErrorLine error={error} />
        {note && !error && <p className="text-xs font-semibold text-emerald">{note}</p>}

        {overlaps.length > 0 && (
          <section
            aria-live="polite"
            className="space-y-2 rounded-card border border-amber/40 bg-amber-soft p-3 text-xs text-ink"
          >
            <p className="flex items-center gap-1.5 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5 text-amber" aria-hidden /> Alguien cambió estos
              archivos mientras tú también los editabas
            </p>
            <p className="text-ink-muted">
              Se quedó la versión de ahora. Si prefieres la tuya, conserva la tuya; luego guarda.
            </p>
            <ul className="space-y-1">
              {overlaps.map((o) => (
                <li key={o.path} className="flex flex-wrap items-center gap-2">
                  <code className="font-mono font-semibold">{o.path}</code>
                  <span className="text-ink-muted">cambiado por {WHO[o.by]}</span>
                  <span className="ml-auto flex gap-1.5">
                    <button type="button" className={BTN_SECONDARY} onClick={() => keepMine(o)}>
                      <Undo2 className="h-3.5 w-3.5" aria-hidden /> Conservar la mía
                    </button>
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      onClick={() => setOverlaps((l) => l.filter((x) => x.path !== o.path))}
                    >
                      Usar la de ahora
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div
          className={clsx(
            'grid gap-3 md:grid-cols-[14rem_minmax(0,1fr)]',
            showPreview &&
              previewBuild &&
              shownPreview &&
              'xl:grid-cols-[14rem_minmax(0,1.2fr)_minmax(0,1fr)]',
          )}
        >
          <div className="space-y-2">
            <FileTree
              paths={paths}
              selected={selected}
              dirty={dirtySet}
              errors={errorCounts}
              byCortex={byCortex}
              disabled={working}
              onSelect={setSelected}
              onNew={(f) => void newFile(f)}
              onRename={(p, folder) => void renamePath(p, folder)}
              onDelete={(p, folder) => void deletePath(p, folder)}
            />
            <button
              type="button"
              className={clsx(BTN_SECONDARY, 'w-full')}
              disabled={working}
              onClick={() =>
                void newFile(
                  selected?.includes('/') ? selected.slice(0, selected.lastIndexOf('/')) : '',
                )
              }
            >
              <FilePlus2 className="h-3.5 w-3.5" aria-hidden /> Archivo nuevo
            </button>
          </div>

          <div className="min-w-0 space-y-2">
            {selected ? (
              <>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <code className="font-mono font-semibold text-ink">{selected}</code>
                  {dirtySet.has(selected) && (
                    <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-micro font-semibold text-amber">
                      Sin guardar
                    </span>
                  )}
                  {authorOfSelected && (
                    <span className="text-ink-faint">
                      último cambio: {WHO[authorOfSelected.by]} · {when(authorOfSelected.at)}
                    </span>
                  )}
                  {dirtySet.has(selected) && (
                    <button
                      type="button"
                      className="ml-auto text-ink-muted hover:text-primary hover:underline"
                      onClick={revertSelected}
                    >
                      Deshacer cambios
                    </button>
                  )}
                </div>
                <div className="h-[32rem]">
                  <CodeEditor
                    path={selected}
                    value={draft[selected] ?? ''}
                    onChange={(next) =>
                      setDraft((d) => (selected in d ? { ...d, [selected]: next } : d))
                    }
                    onSave={() => void onSave()}
                    marks={marks}
                    jump={jump}
                  />
                </div>
                {diagnostics.some((d) => d.path) && (
                  <ul className="max-h-32 space-y-0.5 overflow-auto rounded-card border border-border bg-surface-2 p-2 text-[11px]">
                    {diagnostics
                      .filter((d) => d.path)
                      .map((d, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: lista fija del último registro.
                        <li key={i}>
                          <button
                            type="button"
                            className="flex w-full items-baseline gap-2 text-left hover:text-primary"
                            onClick={() => {
                              if (d.path && d.path in draft) {
                                setSelected(d.path);
                                setJump({ line: d.line, col: d.col, nonce: Date.now() });
                              }
                            }}
                          >
                            <span
                              className={clsx(
                                'font-semibold',
                                d.severity === 'error' ? 'text-rose' : 'text-amber',
                              )}
                            >
                              {d.severity === 'error' ? 'Error' : 'Aviso'}
                            </span>
                            <code className="font-mono text-ink">
                              {d.path}:{d.line}:{d.col}
                            </code>
                            <span className="min-w-0 truncate text-ink-muted">{d.message}</span>
                          </button>
                        </li>
                      ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="grid h-40 place-items-center rounded-card border border-dashed border-border-strong text-xs text-ink-muted">
                Elige un archivo para editarlo.
              </p>
            )}
          </div>

          {showPreview && previewBuild && shownPreview && (
            <div className="hidden min-w-0 space-y-2 xl:block">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                <Eye className="h-3.5 w-3.5" aria-hidden />
                <span className="font-semibold text-ink">Vista previa</span>
                <span>compilación #{previewBuild.number}</span>
                {state.screens.length > 1 && (
                  <select
                    value={shownPreview}
                    onChange={(e) => setPreviewScreen(e.target.value)}
                    className={clsx(INPUT, 'h-7')}
                    aria-label="Pantalla de la vista previa"
                  >
                    {state.screens.map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.title}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  className="ml-auto inline-flex items-center gap-1 hover:text-primary"
                  onClick={() => setPreviewNonce((n) => n + 1)}
                >
                  <RefreshCw className="h-3 w-3" aria-hidden /> Recargar
                </button>
              </div>
              <iframe
                key={`${previewBuild.id}:${shownPreview}:${previewNonce}`}
                title="Vista previa de la pantalla"
                src={`/apps/${data.app.slug}/${shownPreview}?build=${previewBuild.id}`}
                className="h-[32rem] w-full rounded-card border border-border bg-surface"
              />
              {dirty && (
                <p className="text-micro text-ink-faint">
                  Muestra la última compilación; compila para ver tus cambios.
                </p>
              )}
            </div>
          )}
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
                  <button
                    type="button"
                    className="text-primary hover:underline"
                    onClick={() => setSelected(s.codeEntry)}
                  >
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
            {busy === 'screen' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <FilePlus2 className="h-3.5 w-3.5" aria-hidden />
            )}
            Nueva pantalla con código
          </button>
        </div>
      </Section>

      <Section
        title="Compilaciones"
        help="Se guardan las últimas 30. La publicada es la que ve el equipo."
      >
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
                        b.status === 'ok'
                          ? 'bg-emerald-soft text-emerald'
                          : 'bg-rose-soft text-rose',
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
                      <button
                        type="button"
                        className={BTN_SECONDARY}
                        onClick={() => setShownLog(b.log)}
                      >
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
                        <button
                          type="button"
                          className={BTN_PRIMARY}
                          disabled={working}
                          onClick={() => void onPublish(b)}
                        >
                          {busy === 'publish' ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                          ) : (
                            <Rocket className="h-3.5 w-3.5" aria-hidden />
                          )}
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
        {shownLog !== null &&
          (shownLog.trim() ? (
            <LogView log={shownLog} />
          ) : (
            <p className="text-xs text-ink-muted">El registro está vacío.</p>
          ))}
        {!previewBuild && state.builds.length > 0 && (
          <p className="text-xs text-ink-muted">
            Ninguna compilación salió bien todavía: corrige los errores del registro.
          </p>
        )}
      </Section>

      <FunctionsPanel appId={appId} functions={functions} roles={data.roles} />
      <SecretsPanel appId={appId} />
      <RunsPanel appId={appId} />
      <GithubPanel
        appId={appId}
        link={state.github}
        updatedAt={state.updatedAt}
        hasUnsaved={dirty}
        disabled={working}
        onLinked={(github) => setState((s) => (s ? { ...s, github } : s))}
        onPulled={(res) => {
          setState((s) =>
            s
              ? {
                  ...s,
                  files: res.files,
                  updatedAt: res.updatedAt,
                  github: res.github,
                  fileAuthors: Object.fromEntries(
                    Object.keys(res.files).map((p) => [
                      p,
                      s.fileAuthors[p] ?? { by: 'me' as const, at: res.updatedAt },
                    ]),
                  ),
                }
              : s,
          );
          setDraft({ ...res.files });
          setRemoved([]);
          setOverlaps([]);
          setSelected((cur) =>
            cur && cur in res.files ? cur : (Object.keys(res.files).sort()[0] ?? null),
          );
        }}
      />
    </div>
  );
}
