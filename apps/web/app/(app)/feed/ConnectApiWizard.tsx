'use client';

import {
  type CustomToolDraft,
  type CustomToolTestResponse,
  EMPTY_DRAFT,
  type SaveOutcome,
  deleteCustomTool,
  runCustomToolTest,
  saveCustomTool,
} from '@/app/(app)/tools/_components/custom-tools-api';
import {
  AUTH_CHOICES,
  type ApiAuthChoice,
  type DetectedPagination,
  FRESHNESS_CHOICES,
  chatHref,
  detectPagination,
  detectRecords,
  friendlyTestError,
  listCandidates,
  parseTestBody,
  previewTable,
  suggestIdentity,
  urlProblem,
  valueAt,
  withCursorParam,
} from '@/lib/feed/api-wizard';
import type { FeedEntry } from '@/lib/feed/shared';
import { CHIP_BASE, CHIP_INTERACTIVE } from '@/lib/status-chip';
import { clsx } from 'clsx';
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  KeyRound,
  Loader2,
  MessageSquare,
  Plus,
  RotateCcw,
  Table2,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { CustomTools } from '../tools/_components/CustomTools';

const INPUT =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink outline-none transition-colors focus-visible:border-primary/40 focus-visible:ring-2 focus-visible:ring-primary/40';
const BUTTON =
  'inline-flex items-center justify-center gap-2 rounded-pill px-4 py-2 text-sm font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-50';
const PRIMARY = `${BUTTON} bg-primary text-white shadow-card hover:bg-primary-strong`;
const SECONDARY = `${BUTTON} border border-border-strong bg-surface text-ink hover:bg-surface-2`;

// ---------------------------------------------------------------------------
// Transporte: lo real por defecto, uno falso en el escaparate de desarrollo
// ---------------------------------------------------------------------------

export type ApiTool = {
  id: string;
  name: string;
  description: string;
  fields: Array<{ name: string; required: boolean; description: string; enum?: string[] }>;
};

export interface CaptureBody {
  toolId: string;
  input: Record<string, unknown>;
  name?: string;
  pagination?: {
    recordsPath: string;
    nextCursorPath: string;
    cursorInput: string;
    maxPages: number;
  };
  shape?: { recordsPath?: string; asText?: boolean };
}

/** Todo lo que el asistente le pide al servidor. Las rutas y sus contratos son los de siempre. */
export interface ApiWizardClient {
  listApis(signal?: AbortSignal): Promise<{ tools: ApiTool[]; canConfigure: boolean }>;
  saveTool(draft: CustomToolDraft, id?: string): Promise<SaveOutcome>;
  deleteTool(id: string): Promise<void>;
  testTool(id: string, input: Record<string, unknown>): Promise<CustomToolTestResponse>;
  capture(body: CaptureBody): Promise<{ entry: FeedEntry; sourceId: string }>;
  readTables(entryId: string): Promise<{ rows: unknown[][] | null; text: string }>;
  updateSource(
    body:
      | { action: 'freshness'; id: string; minutes: number }
      | { action: 'rename'; id: string; name: string },
  ): Promise<void>;
}

async function readJson(response: Response, fallback: string) {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : fallback);
  return body;
}

export function httpApiWizardClient(paths: {
  apiSources: string;
  sources: string;
  entry: (id: string) => string;
}): ApiWizardClient {
  return {
    async listApis(signal) {
      const body = await readJson(
        await fetch(paths.apiSources, { signal }),
        'No se pudieron cargar las APIs.',
      );
      return {
        tools: (body.tools as ApiTool[] | undefined) ?? [],
        canConfigure: body.canConfigure === true,
      };
    },
    saveTool: (draft, id) => saveCustomTool(draft, id),
    async deleteTool(id) {
      await deleteCustomTool(id);
    },
    testTool: (id, input) => runCustomToolTest(id, input),
    async capture(payload) {
      const body = await readJson(
        await fetch(paths.apiSources, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        'No se pudo consultar la API.',
      );
      return { entry: body.entry as FeedEntry, sourceId: String(body.sourceId) };
    },
    async readTables(entryId) {
      const body = await readJson(
        await fetch(paths.entry(entryId), { cache: 'no-store' }),
        'No se pudo leer lo que trajo la API.',
      );
      const entry = body.entry as {
        feed_tables?: Array<{ rows: unknown[][] }> | null;
        extracted_text?: string;
      };
      return { rows: entry.feed_tables?.[0]?.rows ?? null, text: entry.extracted_text ?? '' };
    },
    async updateSource(payload) {
      await readJson(
        await fetch(paths.sources, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
        'No se pudo guardar la configuración de la fuente.',
      );
    },
  };
}

// ---------------------------------------------------------------------------
// El asistente
// ---------------------------------------------------------------------------

type Step = 1 | 2 | 3 | 'done';
type Origin = 'new' | 'existing';

interface HeaderRow {
  key: string;
  value: string;
}

interface Probe {
  ok: boolean;
  error: string | null;
  status: number | null;
  elapsedMs: number | null;
  /** Lo que contestó, interpretado. */
  data: unknown;
  /** Sólo para quien no puede probar sin guardar: la captura ya hecha. */
  captured?: { entry: FeedEntry; sourceId: string };
}

const STEPS: Array<{ n: 1 | 2 | 3; label: string }> = [
  { n: 1, label: 'Pega la dirección' },
  { n: 2, label: 'Probar' },
  { n: 3, label: 'Nombre y frecuencia' },
];

/**
 * «Conectar una API» en tres pasos: la dirección y la clave; una prueba que
 * muestra lo que vuelve como tabla (detectando dónde está la lista y si viene
 * por páginas); y el nombre con cada cuánto se actualiza.
 *
 * Por debajo usa lo de siempre: una herramienta propia GET (/api/custom-tools)
 * que guarda la clave cifrada, su probador, y la captura de Feed
 * (/api/feed/api-sources). La herramienta se crea APAGADA para probarla y se
 * enciende al guardar, así una prueba abandonada no queda disponible en el
 * chat. La clave se manda una vez y se borra del formulario: nunca vuelve a la
 * pantalla.
 *
 * Quien no administra la empresa no puede crear ni probar herramientas: para
 * esa persona, «Probar» trae los datos de una API ya conectada a la bandeja.
 */
export function ConnectApiWizard({
  client,
  onAdded,
  showAdminEditor = true,
}: {
  client: ApiWizardClient;
  onAdded: (entry: FeedEntry) => void;
  /** El editor completo de conexiones (CustomTools) dentro de «Opciones avanzadas». */
  showAdminEditor?: boolean;
}) {
  const [tools, setTools] = useState<ApiTool[] | null>(null);
  const [canConfigure, setCanConfigure] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>(1);
  const [origin, setOrigin] = useState<Origin>('new');
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Paso 1 — una API nueva.
  const [url, setUrl] = useState('');
  const [auth, setAuth] = useState<ApiAuthChoice>('none');
  const [headerName, setHeaderName] = useState('X-API-Key');
  const [username, setUsername] = useState('');
  const [secret, setSecret] = useState('');
  /** La clave ya quedó guardada (cifrada) en la herramienta; no se conserva aquí. */
  const [secretSaved, setSecretSaved] = useState<ApiAuthChoice | null>(null);
  const [headers, setHeaders] = useState<HeaderRow[]>([]);
  const [allowHttp, setAllowHttp] = useState(false);
  const [followRedirects, setFollowRedirects] = useState(false);
  const [timeoutSec, setTimeoutSec] = useState(15);
  const [draftToolId, setDraftToolId] = useState<string | null>(null);
  const [identity] = useState(() => Math.random().toString(36).slice(2, 8));

  // Paso 1 — una API ya conectada.
  const [toolId, setToolId] = useState('');
  const [input, setInput] = useState<Record<string, string>>({});

  // Paso 2.
  const [probe, setProbe] = useState<Probe | null>(null);
  const [recordsPath, setRecordsPath] = useState<string | null>(null);
  const [pagination, setPagination] = useState<DetectedPagination | null>(null);
  const [paginate, setPaginate] = useState(false);

  // Paso 3.
  const [name, setName] = useState('');
  const [freshness, setFreshness] = useState(1440);
  const [asTable, setAsTable] = useState(true);
  const [manualPages, setManualPages] = useState({
    recordsPath: '',
    nextCursorPath: '',
    cursorInput: '',
    maxPages: 5,
  });
  const [saved, setSaved] = useState<{ name: string; freshness: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    client
      .listApis(controller.signal)
      .then((list) => {
        setTools(list.tools);
        setCanConfigure(list.canConfigure);
        if (!list.canConfigure && list.tools.length > 0) setOrigin('existing');
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted)
          setLoadError(err instanceof Error ? err.message : 'No se pudieron cargar las APIs.');
      });
    return () => controller.abort();
  }, [client]);

  const tool = tools?.find((t) => t.id === toolId) ?? null;
  const problem = origin === 'new' ? urlProblem(url, allowHttp) : null;
  const needsSecret = auth !== 'none' && secretSaved !== auth;
  const authIncomplete =
    (auth === 'header' && !headerName.trim()) ||
    (auth === 'basic' && !username.trim()) ||
    (needsSecret && !secret.trim());

  const records = useMemo(() => {
    if (!probe?.ok || recordsPath === null) return null;
    const list = recordsPath ? valueAt(probe.data, recordsPath) : probe.data;
    return Array.isArray(list) ? (list as Array<Record<string, unknown>>) : null;
  }, [probe, recordsPath]);
  const candidates = useMemo(() => (probe?.ok ? listCandidates(probe.data) : []), [probe]);

  function toolDraft(enabled: boolean): CustomToolDraft {
    const id = suggestIdentity(url, identity);
    return {
      ...EMPTY_DRAFT,
      slug: id.slug,
      name: id.name,
      description: id.description,
      method: 'GET',
      urlTemplate: url.trim(),
      headers: Object.fromEntries(
        headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value]),
      ),
      authType: auth,
      authHeaderName: auth === 'header' ? headerName.trim() : '',
      authUsername: auth === 'basic' ? username.trim() : '',
      authSecret: auth !== 'none' ? secret : '',
      // Feed lee listas largas: el máximo que acepta una herramienta.
      responseMaxChars: 50_000,
      timeoutMs: Math.min(60, Math.max(1, timeoutSec)) * 1000,
      allowInsecureHttp: allowHttp,
      followRedirects,
      requiresConfirmation: false,
      enabled,
    };
  }

  /**
   * Una API ya conectada sólo puede paginar con un parámetro que ya tenga; a
   * una nueva se le añade el que se detectó al guardar.
   */
  function suggestPages(data: unknown, path: string) {
    const pages = detectPagination(data, path);
    const usable =
      !!pages && (origin === 'new' || !!tool?.fields.some((f) => f.name === pages.cursorInput));
    setPagination(usable ? pages : null);
    setPaginate(usable);
    if (pages) setManualPages({ ...pages, maxPages: 5 });
  }

  function absorb(data: unknown) {
    const found = detectRecords(data);
    setRecordsPath(found ? found.path : null);
    setAsTable(!!found);
    if (found) suggestPages(data, found.path);
    else {
      setPagination(null);
      setPaginate(false);
    }
  }

  async function runProbe() {
    setError(null);
    setWorking(true);
    setProbe(null);
    setStep(2);
    try {
      if (origin === 'new') {
        // Crear (o corregir) la herramienta, apagada hasta que se guarde.
        const outcome = await client.saveTool(toolDraft(false), draftToolId ?? undefined);
        if (!outcome.ok) {
          setProbe({
            ok: false,
            error: [outcome.error, ...outcome.problems].join(' '),
            status: null,
            elapsedMs: null,
            data: undefined,
          });
          return;
        }
        setDraftToolId(outcome.tool.id);
        if (auth !== 'none' && secret) setSecretSaved(auth);
        setSecret(''); // Nunca se conserva ni se vuelve a mostrar.
        const test = await client.testTool(outcome.tool.id, {});
        const failure = friendlyTestError(test);
        const data = parseTestBody(test);
        setProbe({
          ok: !failure,
          error: failure,
          status: test.response?.status ?? test.modelResult?.status ?? null,
          elapsedMs: test.elapsedMs ?? null,
          data,
        });
        if (!failure) absorb(data);
        if (!name) setName(outcome.tool.name);
        return;
      }

      if (!tool) throw new Error('Elige una API.');
      if (canConfigure) {
        const test = await client.testTool(tool.id, input);
        const failure = friendlyTestError(test);
        const data = parseTestBody(test);
        setProbe({
          ok: !failure,
          error: failure,
          status: test.response?.status ?? test.modelResult?.status ?? null,
          elapsedMs: test.elapsedMs ?? null,
          data,
        });
        if (!failure) absorb(data);
      } else {
        // Sin permiso para probar: la prueba ES traer los datos a la bandeja.
        const captured = await client.capture({ toolId: tool.id, input });
        const read = await client.readTables(captured.entry.id);
        const rows = read.rows;
        const data =
          rows && rows.length > 1
            ? rows
                .slice(1)
                .map((row) =>
                  Object.fromEntries((rows[0] ?? []).map((h, i) => [String(h), row[i]])),
                )
            : read.text;
        setProbe({ ok: true, error: null, status: null, elapsedMs: null, data, captured });
        setRecordsPath(Array.isArray(data) ? '' : null);
        setAsTable(Array.isArray(data));
        onAdded(captured.entry);
      }
      if (!name) setName(tool.name);
    } catch (err) {
      setProbe({
        ok: false,
        error: err instanceof Error ? err.message : 'No se pudo consultar la API.',
        status: null,
        elapsedMs: null,
        data: undefined,
      });
    } finally {
      setWorking(false);
    }
  }

  async function save() {
    setError(null);
    setWorking(true);
    try {
      const finalName = name.trim() || 'API';
      let sourceId: string;
      let entry: FeedEntry;
      if (probe?.captured) {
        // Ya está en la bandeja: sólo falta el nombre.
        ({ sourceId, entry } = probe.captured);
        if (tool && finalName !== tool.name)
          await client.updateSource({ action: 'rename', id: sourceId, name: finalName });
      } else {
        let id = origin === 'new' ? draftToolId : toolId;
        if (!id) throw new Error('Primero prueba la API.');
        const pages = paginate
          ? {
              recordsPath: manualPages.recordsPath.trim(),
              nextCursorPath: manualPages.nextCursorPath.trim(),
              cursorInput: manualPages.cursorInput.trim(),
              maxPages: manualPages.maxPages,
            }
          : undefined;
        if (pages && (!pages.nextCursorPath || !pages.cursorInput))
          throw new Error('Para leer por páginas faltan la ruta del cursor y el parámetro.');
        if (origin === 'new') {
          // Encenderla, y si lee por páginas, darle el parámetro del cursor.
          const draft = toolDraft(true);
          if (pages) {
            draft.urlTemplate = withCursorParam(url, pages.cursorInput);
            draft.fields = [
              {
                name: pages.cursorInput,
                type: 'string',
                required: false,
                description: 'Cursor de la siguiente página, tal como lo devolvió la API.',
              },
            ];
          }
          const outcome = await client.saveTool(draft, id);
          if (!outcome.ok) throw new Error([outcome.error, ...outcome.problems].join(' '));
          id = outcome.tool.id;
        }
        const shape = !asTable
          ? { asText: true }
          : // Al paginar, Feed junta los registros en una lista: ya no hay ruta.
            !pages && recordsPath
            ? { recordsPath }
            : undefined;
        ({ sourceId, entry } = await client.capture({
          toolId: id,
          input: origin === 'existing' ? input : {},
          name: finalName,
          ...(pages ? { pagination: pages } : {}),
          ...(shape ? { shape } : {}),
        }));
        onAdded(entry);
      }
      await client.updateSource({ action: 'freshness', id: sourceId, minutes: freshness });
      setSaved({ name: finalName, freshness });
      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar la conexión.');
    } finally {
      setWorking(false);
    }
  }

  async function startOver() {
    // Una herramienta de prueba que nunca se guardó no debe quedar suelta.
    if (draftToolId && step !== 'done') await client.deleteTool(draftToolId).catch(() => undefined);
    setStep(1);
    setUrl('');
    setAuth('none');
    setSecret('');
    setSecretSaved(null);
    setUsername('');
    setHeaders([]);
    setDraftToolId(null);
    setProbe(null);
    setRecordsPath(null);
    setPagination(null);
    setPaginate(false);
    setName('');
    setToolId('');
    setInput({});
    setSaved(null);
    setError(null);
  }

  if (loadError)
    return (
      <p role="alert" className="text-sm text-rose">
        {loadError}
      </p>
    );
  if (tools === null)
    return (
      <p className="inline-flex items-center gap-2 text-sm text-ink-muted">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Cargando…
      </p>
    );

  const cortexLink = (
    <Link
      href={chatHref(problem ? '' : url)}
      className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary underline-offset-2 hover:underline"
    >
      <MessageSquare className="h-3.5 w-3.5" aria-hidden />
      ¿Prefieres contarle cómo es? Hazlo con Cortex
    </Link>
  );

  if (!canConfigure && tools.length === 0)
    return (
      <div className="space-y-3 rounded-card border border-border bg-surface-2 p-4">
        <p className="text-sm text-ink">
          Todavía no hay APIs conectadas en tu empresa, y conectar una nueva lo hace un
          administrador (guarda claves que ven todos).
        </p>
        {cortexLink}
      </div>
    );

  if (step === 'done' && saved)
    return (
      <div className="space-y-4 rounded-card border border-emerald/30 bg-emerald-soft p-5">
        <p className="flex items-center gap-2 text-base font-bold text-ink">
          <CheckCircle2 className="h-5 w-5 text-emerald" aria-hidden /> «{saved.name}» quedó
          conectada
        </p>
        <p className="text-sm text-ink-muted">
          Ya está en tu bandeja y se mantendrá al día{' '}
          {FRESHNESS_CHOICES.find((f) => f.minutes === saved.freshness)?.label.toLowerCase() ??
            'según la frecuencia elegida'}
          . La verás también en «Fuentes conectadas», donde puedes actualizarla o desconectarla.
        </p>
        <button type="button" onClick={() => void startOver()} className={SECONDARY}>
          <Plus className="h-4 w-4" aria-hidden /> Conectar otra API
        </button>
      </div>
    );

  return (
    <div className="min-w-0 space-y-5">
      <Stepper step={step} />

      {step === 1 && (
        <div className="space-y-5">
          {tools.length > 0 && canConfigure && (
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  ['new', 'Una API nueva'],
                  ['existing', `Una ya conectada (${tools.length})`],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={origin === value}
                  onClick={() => setOrigin(value)}
                  className={clsx(
                    CHIP_BASE,
                    CHIP_INTERACTIVE,
                    'px-3 py-1 text-xs',
                    origin === value
                      ? 'border-primary/30 bg-primary-soft text-primary-ink'
                      : 'border-border bg-surface text-ink-muted hover:text-ink',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          )}

          {origin === 'new' ? (
            <>
              <div>
                <label htmlFor="api-wizard-url" className="block text-sm font-semibold text-ink">
                  Pega la dirección
                </label>
                <p className="mt-0.5 text-xs text-ink-muted">
                  La dirección (URL) que devuelve los datos. En la documentación suele aparecer
                  junto a la palabra GET, por ejemplo https://api.tuempresa.com/v1/pedidos
                </p>
                <input
                  id="api-wizard-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="https://"
                  className={`${INPUT} mt-2 font-mono`}
                  aria-invalid={!!url && !!problem}
                  aria-describedby="api-wizard-url-problem"
                />
                {url && problem ? (
                  <p id="api-wizard-url-problem" className="mt-1 text-xs text-rose">
                    {problem}
                  </p>
                ) : null}
              </div>

              <fieldset>
                <legend className="text-sm font-semibold text-ink">¿Necesita clave?</legend>
                <p className="mt-0.5 text-xs text-ink-muted">
                  Se guarda cifrada y nadie la vuelve a ver, ni siquiera tú.
                </p>
                <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  {AUTH_CHOICES.map((choice) => (
                    <label
                      key={choice.value}
                      className={clsx(
                        'flex cursor-pointer gap-2.5 rounded-card border p-3 transition-colors',
                        auth === choice.value
                          ? 'border-primary/40 bg-primary-soft'
                          : 'border-border bg-surface hover:bg-surface-2',
                      )}
                    >
                      <input
                        type="radio"
                        name="api-wizard-auth"
                        value={choice.value}
                        checked={auth === choice.value}
                        onChange={() => setAuth(choice.value)}
                        className="mt-0.5"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-ink">{choice.label}</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                          {choice.help}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>

                {auth !== 'none' && (
                  <div className="mt-3 grid gap-3 rounded-card border border-border bg-surface-2 p-3 sm:grid-cols-2">
                    {auth === 'header' && (
                      <Labeled label="Nombre de la cabecera" htmlFor="api-wizard-header">
                        <input
                          id="api-wizard-header"
                          value={headerName}
                          onChange={(e) => setHeaderName(e.target.value)}
                          placeholder="X-API-Key"
                          className={`${INPUT} font-mono`}
                        />
                      </Labeled>
                    )}
                    {auth === 'basic' && (
                      <Labeled label="Usuario" htmlFor="api-wizard-user">
                        <input
                          id="api-wizard-user"
                          value={username}
                          onChange={(e) => setUsername(e.target.value)}
                          autoComplete="off"
                          className={INPUT}
                        />
                      </Labeled>
                    )}
                    <Labeled
                      label={
                        auth === 'basic' ? 'Contraseña' : auth === 'bearer' ? 'Token' : 'Llave'
                      }
                      htmlFor="api-wizard-secret"
                    >
                      <input
                        id="api-wizard-secret"
                        type="password"
                        value={secret}
                        onChange={(e) => setSecret(e.target.value)}
                        autoComplete="new-password"
                        spellCheck={false}
                        placeholder={
                          secretSaved === auth ? 'Guardada · escribe otra para cambiarla' : ''
                        }
                        className={`${INPUT} font-mono`}
                      />
                      {secretSaved === auth && (
                        <span className="mt-1 inline-flex items-center gap-1 text-micro font-semibold text-emerald">
                          <KeyRound className="h-3 w-3" aria-hidden /> Guardada y cifrada
                        </span>
                      )}
                    </Labeled>
                  </div>
                )}
              </fieldset>

              <details className="rounded-card border border-border bg-surface">
                <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-ink-muted">
                  Opciones avanzadas
                </summary>
                <div className="space-y-4 border-t border-border p-3">
                  <div>
                    <p className="text-xs font-semibold text-ink">Cabeceras adicionales</p>
                    <p className="text-xs text-ink-muted">
                      Para APIs que piden algo más, como «Accept» o una versión. No pongas claves
                      aquí: usa «¿Necesita clave?».
                    </p>
                    <div className="mt-2 space-y-1.5">
                      {headers.map((row, i) => (
                        <div key={`header-${i.toString()}`} className="flex gap-1.5">
                          <input
                            aria-label="Nombre de la cabecera"
                            value={row.key}
                            onChange={(e) =>
                              setHeaders(
                                headers.map((h, j) =>
                                  j === i ? { ...h, key: e.target.value } : h,
                                ),
                              )
                            }
                            placeholder="Accept"
                            className={`${INPUT} font-mono`}
                          />
                          <input
                            aria-label="Valor de la cabecera"
                            value={row.value}
                            onChange={(e) =>
                              setHeaders(
                                headers.map((h, j) =>
                                  j === i ? { ...h, value: e.target.value } : h,
                                ),
                              )
                            }
                            placeholder="application/json"
                            className={`${INPUT} font-mono`}
                          />
                          <button
                            type="button"
                            onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                            aria-label="Quitar cabecera"
                            className="grid w-9 shrink-0 place-items-center rounded-sm text-ink-faint hover:bg-surface-2 hover:text-rose"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden />
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setHeaders([...headers, { key: '', value: '' }])}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-primary"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden /> Añadir cabecera
                      </button>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="flex items-center gap-2 text-xs text-ink">
                      <input
                        type="checkbox"
                        checked={allowHttp}
                        onChange={(e) => setAllowHttp(e.target.checked)}
                      />
                      Permitir http:// sin cifrar
                    </label>
                    <label className="flex items-center gap-2 text-xs text-ink">
                      <input
                        type="checkbox"
                        checked={followRedirects}
                        onChange={(e) => setFollowRedirects(e.target.checked)}
                      />
                      Seguir redirecciones
                    </label>
                    <label className="flex items-center gap-2 text-xs text-ink">
                      Esperar hasta
                      <input
                        type="number"
                        min={1}
                        max={60}
                        value={timeoutSec}
                        onChange={(e) => setTimeoutSec(Number(e.target.value) || 15)}
                        className={`${INPUT} w-16 py-1`}
                      />
                      s
                    </label>
                  </div>
                  {showAdminEditor && (
                    <details className="rounded-sm border border-border bg-surface-2">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-semibold text-ink-muted">
                        Editor completo de conexiones API (POST, campos, rutas de respuesta…)
                      </summary>
                      <div className="border-t border-border p-3">
                        <CustomTools />
                      </div>
                    </details>
                  )}
                </div>
              </details>
            </>
          ) : (
            <div className="space-y-4">
              <Labeled label="API conectada" htmlFor="api-wizard-tool">
                <select
                  id="api-wizard-tool"
                  value={toolId}
                  onChange={(e) => {
                    setToolId(e.target.value);
                    setInput({});
                  }}
                  className={INPUT}
                >
                  <option value="">Elige una API</option>
                  {tools.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Labeled>
              {tool ? <p className="text-xs text-ink-muted">{tool.description}</p> : null}
              {tool?.fields.map((field) => (
                <Labeled
                  key={field.name}
                  label={`${field.name}${field.required ? '' : ' (opcional)'}`}
                  htmlFor={`api-wizard-field-${field.name}`}
                  help={field.description}
                >
                  {field.enum?.length ? (
                    <select
                      id={`api-wizard-field-${field.name}`}
                      value={input[field.name] ?? ''}
                      onChange={(e) => setInput({ ...input, [field.name]: e.target.value })}
                      className={INPUT}
                    >
                      <option value="">Seleccionar</option>
                      {field.enum.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      id={`api-wizard-field-${field.name}`}
                      value={input[field.name] ?? ''}
                      onChange={(e) => setInput({ ...input, [field.name]: e.target.value })}
                      className={INPUT}
                    />
                  )}
                </Labeled>
              ))}
              {!canConfigure && (
                <p className="text-xs text-ink-muted">
                  Al probar, los datos llegan a tu bandeja. Conectar una API nueva lo hace un
                  administrador.
                </p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            {cortexLink}
            <button
              type="button"
              onClick={() => void runProbe()}
              disabled={
                working ||
                (origin === 'new'
                  ? !!problem || authIncomplete
                  : !tool || tool.fields.some((f) => f.required && !input[f.name]?.trim()))
              }
              className={PRIMARY}
            >
              Probar <ArrowRight className="h-4 w-4" aria-hidden />
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-4">
          {working || !probe ? (
            <p className="inline-flex items-center gap-2 text-sm text-ink-muted">
              <Loader2 className="h-4 w-4 animate-spin text-primary" aria-hidden /> Consultando la
              API…
            </p>
          ) : !probe.ok ? (
            <div role="alert" className="rounded-card border border-rose/30 bg-rose-soft p-4">
              <p className="text-sm font-semibold text-rose">No funcionó todavía</p>
              <p className="mt-1 text-sm text-ink">{probe.error}</p>
            </div>
          ) : (
            <>
              <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                <CheckCircle2 className="h-4 w-4 text-emerald" aria-hidden />
                <span className="font-semibold">La API respondió.</span>
                {probe.status ? (
                  <span className="text-xs text-ink-muted">
                    Código {probe.status}
                    {probe.elapsedMs !== null ? ` · ${probe.elapsedMs} ms` : ''}
                  </span>
                ) : null}
              </p>
              {records && records.length > 0 ? (
                <RecordsPreview
                  records={records}
                  path={recordsPath ?? ''}
                  candidates={probe.captured ? [] : candidates}
                  onPath={(path) => {
                    setRecordsPath(path);
                    suggestPages(probe.data, path);
                  }}
                />
              ) : (
                <div className="rounded-card border border-border bg-surface-2 p-3">
                  <p className="text-xs text-ink-muted">
                    No encontramos una lista de registros, así que se guardará como texto. Así
                    empieza:
                  </p>
                  <pre className="scroll-slim mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-micro text-ink">
                    {(typeof probe.data === 'string'
                      ? probe.data
                      : (JSON.stringify(probe.data, null, 2) ?? '')
                    ).slice(0, 1500)}
                  </pre>
                </div>
              )}
              {pagination && (
                <label className="flex items-start gap-2 rounded-card border border-border bg-surface p-3 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={paginate}
                    onChange={(e) => setPaginate(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block font-semibold">Viene por páginas</span>
                    <span className="text-ink-muted">
                      Encontramos el cursor de la siguiente página en{' '}
                      <code className="font-mono">{pagination.nextCursorPath}</code>. Cortex leerá
                      hasta 5 páginas (1.000 filas) enviándolo como{' '}
                      <code className="font-mono">{pagination.cursorInput}</code>.
                    </span>
                  </span>
                </label>
              )}
            </>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={working}
              className={SECONDARY}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              {probe && !probe.ok ? 'Volver y corregir' : 'Volver'}
            </button>
            <div className="flex flex-wrap items-center gap-2">
              {probe && !probe.ok && (
                <button
                  type="button"
                  onClick={() => void runProbe()}
                  disabled={working || (origin === 'new' && authIncomplete)}
                  className={SECONDARY}
                >
                  <RotateCcw className="h-4 w-4" aria-hidden /> Probar de nuevo
                </button>
              )}
              <button
                type="button"
                onClick={() => setStep(3)}
                disabled={working || !probe?.ok}
                className={PRIMARY}
              >
                Continuar <ArrowRight className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-5">
          <Labeled
            label="¿Cómo se llama?"
            htmlFor="api-wizard-name"
            help="Así aparecerá en la bandeja y cuando le pidas algo a Cortex."
          >
            <input
              id="api-wizard-name"
              value={name}
              maxLength={240}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pedidos de la tienda"
              className={INPUT}
            />
          </Labeled>

          <fieldset>
            <legend className="text-sm font-semibold text-ink">¿Cada cuánto se actualiza?</legend>
            <p className="mt-0.5 text-xs text-ink-muted">
              Cuánto tiempo pueden tener los datos antes de considerarse viejos y volver a pedirlos.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {FRESHNESS_CHOICES.map((choice) => (
                <button
                  key={choice.minutes}
                  type="button"
                  aria-pressed={freshness === choice.minutes}
                  onClick={() => setFreshness(choice.minutes)}
                  className={clsx(
                    CHIP_BASE,
                    CHIP_INTERACTIVE,
                    'px-3 py-1 text-xs',
                    freshness === choice.minutes
                      ? 'border-primary/30 bg-primary-soft text-primary-ink'
                      : 'border-border bg-surface text-ink-muted hover:text-ink',
                  )}
                >
                  {choice.label}
                </button>
              ))}
            </div>
          </fieldset>

          <label
            className={clsx(
              'flex items-start gap-2.5 rounded-card border border-border p-3',
              records?.length && !probe?.captured ? 'bg-surface' : 'bg-surface-2 opacity-60',
            )}
          >
            <input
              type="checkbox"
              checked={asTable && !!records?.length}
              disabled={!records?.length || !!probe?.captured}
              onChange={(e) => setAsTable(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
                <Table2 className="h-4 w-4 text-primary" aria-hidden /> Convertir en tabla
              </span>
              <span className="mt-0.5 block text-xs text-ink-muted">
                {records?.length
                  ? 'Cada registro queda como una fila, lista para vistas, cruces y automatizaciones. Si lo apagas se guarda como texto.'
                  : 'La respuesta no trae una lista de registros: se guardará como texto.'}
              </span>
            </span>
          </label>

          {!probe?.captured && (
            <details className="rounded-card border border-border bg-surface">
              <summary className="cursor-pointer px-3 py-2.5 text-xs font-semibold text-ink-muted">
                Opciones avanzadas: lectura por páginas
              </summary>
              <div className="space-y-3 border-t border-border p-3">
                <label className="flex items-center gap-2 text-xs text-ink">
                  <input
                    type="checkbox"
                    checked={paginate}
                    onChange={(e) => setPaginate(e.target.checked)}
                  />
                  La API devuelve un cursor para obtener la siguiente página
                </label>
                {paginate && (
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Labeled label="Ruta de la lista en la respuesta" htmlFor="api-wizard-records">
                      <input
                        id="api-wizard-records"
                        value={manualPages.recordsPath}
                        onChange={(e) =>
                          setManualPages({ ...manualPages, recordsPath: e.target.value })
                        }
                        placeholder="data.items"
                        className={`${INPUT} font-mono`}
                      />
                    </Labeled>
                    <Labeled label="Ruta del siguiente cursor" htmlFor="api-wizard-next">
                      <input
                        id="api-wizard-next"
                        value={manualPages.nextCursorPath}
                        onChange={(e) =>
                          setManualPages({ ...manualPages, nextCursorPath: e.target.value })
                        }
                        placeholder="pagination.next_cursor"
                        className={`${INPUT} font-mono`}
                      />
                    </Labeled>
                    <Labeled label="Parámetro que recibe el cursor" htmlFor="api-wizard-cursor">
                      {origin === 'existing' && tool ? (
                        <select
                          id="api-wizard-cursor"
                          value={manualPages.cursorInput}
                          onChange={(e) =>
                            setManualPages({ ...manualPages, cursorInput: e.target.value })
                          }
                          className={INPUT}
                        >
                          <option value="">Seleccionar parámetro</option>
                          {tool.fields.map((f) => (
                            <option key={f.name} value={f.name}>
                              {f.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id="api-wizard-cursor"
                          value={manualPages.cursorInput}
                          onChange={(e) =>
                            setManualPages({ ...manualPages, cursorInput: e.target.value })
                          }
                          placeholder="cursor"
                          className={`${INPUT} font-mono`}
                        />
                      )}
                    </Labeled>
                    <Labeled label="Máximo de páginas" htmlFor="api-wizard-max">
                      <input
                        id="api-wizard-max"
                        type="number"
                        min={1}
                        max={10}
                        value={manualPages.maxPages}
                        onChange={(e) =>
                          setManualPages({
                            ...manualPages,
                            maxPages: Math.min(10, Math.max(1, Number(e.target.value) || 5)),
                          })
                        }
                        className={INPUT}
                      />
                    </Labeled>
                    <p className="text-xs leading-relaxed text-ink-muted sm:col-span-2">
                      Usa los nombres de la documentación de tu API. Cortex consulta hasta 10
                      páginas y 1.000 filas; si queda contenido pendiente, lo marca incompleto y
                      bloquea su uso automático.
                    </p>
                  </div>
                )}
              </div>
            </details>
          )}

          {error && (
            <p role="alert" className="text-sm text-rose">
              {error}
            </p>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <button
              type="button"
              onClick={() => setStep(2)}
              disabled={working}
              className={SECONDARY}
            >
              <ArrowLeft className="h-4 w-4" aria-hidden /> Volver
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={working || !name.trim()}
              className={PRIMARY}
            >
              {working ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Check className="h-4 w-4" aria-hidden />
              )}
              {probe?.captured ? 'Guardar' : 'Guardar y traer los datos'}
            </button>
          </div>
        </div>
      )}

      {step !== 1 && (
        <button
          type="button"
          onClick={() => void startOver()}
          disabled={working}
          className="text-xs font-semibold text-ink-faint hover:text-ink"
        >
          Empezar de nuevo
        </button>
      )}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const current = step === 'done' ? 4 : step;
  return (
    <ol className="flex flex-wrap items-center gap-2" aria-label="Pasos">
      {STEPS.map((s, i) => {
        const state = s.n < current ? 'done' : s.n === current ? 'current' : 'next';
        return (
          <li key={s.n} className="flex items-center gap-2">
            <span
              aria-current={state === 'current' ? 'step' : undefined}
              className={clsx(
                'inline-flex items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-semibold',
                state === 'current' && 'border-primary/30 bg-primary-soft text-primary-ink',
                state === 'done' && 'border-emerald/20 bg-emerald-soft text-emerald',
                state === 'next' && 'border-border bg-surface text-ink-faint',
              )}
            >
              <span
                className={clsx(
                  'grid h-4 w-4 place-items-center rounded-full text-micro',
                  state === 'current' && 'bg-primary text-white',
                  state === 'done' && 'bg-emerald text-white',
                  state === 'next' && 'bg-surface-2 text-ink-faint',
                )}
              >
                {state === 'done' ? <Check className="h-2.5 w-2.5" aria-hidden /> : s.n}
              </span>
              {s.label}
            </span>
            {i < STEPS.length - 1 && <span className="h-px w-4 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

function RecordsPreview({
  records,
  path,
  candidates,
  onPath,
}: {
  records: Array<Record<string, unknown>>;
  path: string;
  candidates: Array<{ path: string; count: number }>;
  onPath: (path: string) => void;
}) {
  const table = previewTable(records);
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <span>
          Encontramos <strong className="text-ink">{table.totalRows} registros</strong>
          {path ? (
            <>
              {' '}
              en <code className="font-mono text-ink">{path}</code>
            </>
          ) : null}
          .
        </span>
        {candidates.length > 1 && (
          <label className="inline-flex items-center gap-1.5">
            ¿No es esa lista?
            <select
              value={path}
              onChange={(e) => onPath(e.target.value)}
              className="rounded-sm border border-border bg-surface px-2 py-1 font-mono text-xs text-ink"
            >
              {candidates.map((c) => (
                <option key={c.path || '(raíz)'} value={c.path}>
                  {c.path || '(la respuesta entera)'} · {c.count}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="scroll-slim overflow-auto rounded-card border border-border">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Vista previa de lo que devolvió la API</caption>
          <thead className="bg-surface-2">
            <tr>
              {table.headers.map((h) => (
                <th
                  key={h}
                  scope="col"
                  className="whitespace-nowrap px-3 py-2 font-semibold text-ink"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row, r) => (
              <tr key={`row-${r.toString()}`} className="border-t border-border">
                {row.map((cell, c) => (
                  <td
                    key={`cell-${r.toString()}-${c.toString()}`}
                    className="whitespace-nowrap px-3 py-1.5 text-ink-muted"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-micro text-ink-faint">
        Mostrando {table.rows.length} de {table.totalRows} filas
        {table.totalColumns > table.headers.length
          ? ` y ${table.headers.length} de ${table.totalColumns} columnas`
          : ''}
        .
      </p>
    </div>
  );
}

function Labeled({
  label,
  htmlFor,
  help,
  children,
}: {
  label: string;
  htmlFor: string;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-ink">
        {label}
      </label>
      {help ? <p className="mt-0.5 text-xs text-ink-muted">{help}</p> : null}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
