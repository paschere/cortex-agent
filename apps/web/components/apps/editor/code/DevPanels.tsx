'use client';

import * as codeActions from '@/lib/apps/code-actions';
import * as githubActions from '@/lib/apps/code-github';
import { confirmDialog } from '@/lib/ui/dialog-queue';
import { clsx } from 'clsx';
import {
  Check,
  Copy,
  Database,
  GitBranch,
  KeyRound,
  Loader2,
  Play,
  Plug,
  RefreshCw,
  Trash2,
  Upload,
  Webhook,
} from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { BTN_PRIMARY, BTN_SECONDARY, type EditorRole, ErrorLine, INPUT, Section } from '../shared';

/**
 * LAS SECCIONES DE DESARROLLADOR del editor de código: secretos, funciones de
 * servidor, ejecuciones y GitHub.
 *
 * Secretos, funciones y ejecuciones llaman a las acciones de la fase 2
 * (lib/apps/code-actions.ts: listSecrets, setSecret, runFunction,
 * createWebhook, listRuns). Se leen del módulo en tiempo de ejecución y no con
 * imports con nombre: si el servidor todavía no las trae, la sección dice
 * «aún no disponible» en vez de romper la pantalla.
 */

interface Phase2Api {
  listSecrets(appRef: string): Promise<unknown>;
  setSecret(appRef: string, name: string, value: string | null): Promise<unknown>;
  runFunction(appRef: string, name: string, input: unknown): Promise<unknown>;
  createWebhook(appRef: string, input: { name: string; role: string }): Promise<unknown>;
  listRuns(appRef: string, opts: { limit: number }): Promise<unknown>;
}
const api = codeActions as unknown as Partial<Phase2Api>;

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asArray = (v: unknown, key: string): unknown[] =>
  Array.isArray(v) ? v : Array.isArray(asRecord(v)[key]) ? (asRecord(v)[key] as unknown[]) : [];
const errorOf = (v: unknown): string | null => {
  const r = asRecord(v);
  return r.ok === false ? String(r.error ?? 'No se pudo completar.') : null;
};
const fail = (e: unknown, fallback: string) =>
  e instanceof Error && e.message ? e.message : fallback;

function when(iso: unknown): string {
  const d = typeof iso === 'string' ? new Date(iso) : null;
  return d && !Number.isNaN(d.getTime())
    ? d.toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })
    : '';
}

function Unavailable() {
  return <p className="text-xs text-ink-muted">Aún no disponible en este servidor.</p>;
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={BTN_SECONDARY}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? (
        <Check className="h-3.5 w-3.5" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {done ? 'Copiado' : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Secretos
// ---------------------------------------------------------------------------

const SECRET_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function SecretsPanel({ appId }: { appId: string }) {
  const [rows, setRows] = useState<Array<{ name: string; updatedAt: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const valueInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    if (!api.listSecrets) return;
    try {
      const res = await api.listSecrets(appId);
      const bad = errorOf(res);
      if (bad) return setError(bad);
      setRows(
        asArray(res, 'secrets').map((r) => ({
          name: String(asRecord(r).name ?? ''),
          updatedAt: String(asRecord(r).updatedAt ?? ''),
        })),
      );
      setError(null);
    } catch (e) {
      setError(fail(e, 'No se pudieron leer los secretos.'));
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(secretName: string, secretValue: string | null) {
    if (!api.setSecret) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.setSecret(appId, secretName, secretValue);
      const bad = errorOf(res);
      if (bad) return setError(bad);
      setName('');
      setValue('');
      await load();
    } catch (e) {
      setError(fail(e, 'No se pudo guardar el secreto.'));
    } finally {
      setBusy(false);
    }
  }

  /** «Cambiar valor» deja el nombre listo en el formulario: el valor se escribe ahí, en un campo de contraseña. */
  function change(secretName: string) {
    setName(secretName);
    setValue('');
    valueInput.current?.focus();
  }

  async function remove(secretName: string) {
    if (
      !(await confirmDialog({
        title: `¿Borrar el secreto ${secretName}?`,
        message: 'Las funciones que lo usen dejarán de encontrarlo.',
        tone: 'danger',
        confirmLabel: 'Borrar',
      }))
    )
      return;
    await save(secretName, null);
  }

  return (
    <Section
      title="Secretos"
      help="Llaves y contraseñas que las funciones de servidor leen como ctx.secrets.NOMBRE. Se guardan cifradas y nunca se vuelven a mostrar ni llegan al navegador de nadie."
    >
      {!api.listSecrets ? (
        <Unavailable />
      ) : (
        <>
          <ErrorLine error={error} />
          {rows && rows.length > 0 && (
            <ul className="divide-y divide-border rounded-card border border-border">
              {rows.map((r) => (
                <li key={r.name} className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs">
                  <KeyRound className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
                  <code className="font-mono font-semibold text-ink">{r.name}</code>
                  <span className="text-ink-faint">cambiado {when(r.updatedAt)}</span>
                  <span className="ml-auto flex gap-1.5">
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      disabled={busy}
                      onClick={() => change(r.name)}
                    >
                      Cambiar valor
                    </button>
                    <button
                      type="button"
                      className={BTN_SECONDARY}
                      disabled={busy}
                      aria-label={`Borrar ${r.name}`}
                      onClick={() => void remove(r.name)}
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          )}
          {rows && rows.length === 0 && (
            <p className="text-xs text-ink-muted">Sin secretos todavía.</p>
          )}
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!SECRET_RE.test(name))
                return setError(
                  'El nombre va en MAYÚSCULAS, números o guion bajo (ej. RESEND_API_KEY).',
                );
              if (!value) return setError('Escribe el valor del secreto.');
              void save(name, value);
            }}
          >
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toUpperCase())}
              placeholder="NOMBRE_DEL_SECRETO"
              aria-label="Nombre del secreto"
              className={clsx(INPUT, 'w-56 font-mono')}
            />
            <input
              ref={valueInput}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              type="password"
              autoComplete="off"
              placeholder="Valor"
              aria-label="Valor del secreto"
              className={clsx(INPUT, 'w-56')}
            />
            <button type="submit" className={BTN_SECONDARY} disabled={busy}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <KeyRound className="h-3.5 w-3.5" aria-hidden />
              )}
              Guardar secreto
            </button>
          </form>
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Funciones
// ---------------------------------------------------------------------------

interface RunOut {
  ok: boolean;
  result?: unknown;
  error?: string;
  log?: string;
  durationMs?: number;
}

function FunctionRow({ appId, fn, roles }: { appId: string; fn: string; roles: EditorRole[] }) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState('{}');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<RunOut | null>(null);
  const [hook, setHook] = useState<{ url: string; token: string } | null>(null);
  const [role, setRole] = useState(roles[0]?.key ?? '');
  const [error, setError] = useState<string | null>(null);

  async function run() {
    if (!api.runFunction) return;
    let parsed: unknown;
    try {
      parsed = input.trim() ? JSON.parse(input) : {};
    } catch {
      return setError('La entrada no es un JSON válido.');
    }
    setBusy(true);
    setError(null);
    setOut(null);
    try {
      const r = asRecord(await api.runFunction(appId, fn, parsed));
      setOut({
        ok: r.ok === true,
        result: r.result,
        error: typeof r.error === 'string' ? r.error : undefined,
        log: typeof r.log === 'string' ? r.log : undefined,
        durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined,
      });
    } catch (e) {
      setError(fail(e, 'No se pudo ejecutar la función.'));
    } finally {
      setBusy(false);
    }
  }

  async function webhook() {
    if (!api.createWebhook) return;
    setBusy(true);
    setError(null);
    try {
      const r = asRecord(await api.createWebhook(appId, { name: fn, role }));
      if (r.ok === false) return setError(String(r.error ?? 'No se pudo crear el webhook.'));
      setHook({ url: String(r.url ?? ''), token: String(r.token ?? '') });
    } catch (e) {
      setError(fail(e, 'No se pudo crear el webhook.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-mono font-semibold text-ink">server/{fn}.ts</code>
        <span className="ml-auto flex gap-1.5">
          <button type="button" className={BTN_SECONDARY} onClick={() => setOpen((o) => !o)}>
            <Play className="h-3.5 w-3.5" aria-hidden /> Probar
          </button>
        </span>
      </div>
      {open && (
        <div className="space-y-2">
          <ErrorLine error={error} />
          <label className="block space-y-1 text-ink-muted">
            Entrada (JSON)
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              spellCheck={false}
              rows={3}
              className="w-full rounded-card border border-border bg-surface p-2 font-mono text-micro text-ink outline-none focus:border-primary"
            />
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy || !api.runFunction}
              onClick={() => void run()}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Play className="h-3.5 w-3.5" aria-hidden />
              )}
              Ejecutar
            </button>
            {api.createWebhook && (
              <>
                <span className="text-ink-faint">o abrirla al mundo como webhook con el rol</span>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className={INPUT}
                  aria-label="Rol del webhook"
                >
                  {roles.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={BTN_SECONDARY}
                  disabled={busy || !role}
                  onClick={() => void webhook()}
                >
                  <Webhook className="h-3.5 w-3.5" aria-hidden /> Crear webhook
                </button>
              </>
            )}
          </div>
          {hook && (
            <div className="space-y-1 rounded-card border border-amber/40 bg-amber-soft p-2 text-ink">
              <p className="font-semibold">Guárdalo ahora: el token no se vuelve a mostrar.</p>
              <p className="break-all font-mono text-micro">{hook.url}</p>
              <div className="flex gap-1.5">
                <CopyButton text={hook.url} label="Copiar URL" />
                <CopyButton text={hook.token} label="Copiar token" />
              </div>
            </div>
          )}
          {out && (
            <div className="space-y-1">
              <p className={clsx('font-semibold', out.ok ? 'text-emerald' : 'text-rose')}>
                {out.ok ? 'Salió bien' : `Falló: ${out.error ?? 'error'}`}
                {out.durationMs !== undefined && (
                  <span className="ml-2 font-normal text-ink-faint">{out.durationMs} ms</span>
                )}
              </p>
              {out.ok && out.result !== undefined && (
                <pre className="max-h-48 overflow-auto rounded-card bg-surface-2 p-2 font-mono text-micro text-ink">
                  {JSON.stringify(out.result, null, 2)}
                </pre>
              )}
              {out.log?.trim() && (
                <pre className="max-h-48 overflow-auto rounded-card bg-surface-2 p-2 font-mono text-micro text-ink-muted">
                  {out.log}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

export function FunctionsPanel({
  appId,
  functions,
  roles,
}: { appId: string; functions: string[]; roles: EditorRole[] }) {
  return (
    <Section
      title="Funciones"
      help="Archivos server/<nombre>.ts con `export default async function (input, ctx)`. Las llama una pantalla (cortex.functions.call), una regla, un horario o un webhook."
    >
      {!api.runFunction ? (
        <Unavailable />
      ) : functions.length === 0 ? (
        <p className="text-xs text-ink-muted">
          Aún no hay funciones: crea un archivo en server/ (ej. server/avisar.ts) y compila.
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-card border border-border">
          {functions.map((fn) => (
            <FunctionRow key={fn} appId={appId} fn={fn} roles={roles} />
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Ejecuciones
// ---------------------------------------------------------------------------

interface RunRow {
  id: string;
  fn: string;
  status: string;
  trigger: string;
  durationMs: number | null;
  at: string;
  log: string;
  error: string;
}

function toRun(raw: unknown, i: number): RunRow {
  const r = asRecord(raw);
  const dur = r.durationMs ?? r.duration_ms;
  return {
    id: String(r.id ?? i),
    fn: String(r.function ?? r.functionName ?? r.name ?? r.fn ?? ''),
    status: String(r.status ?? (r.ok === false ? 'error' : 'ok')),
    trigger: String(r.trigger ?? r.source ?? ''),
    durationMs: typeof dur === 'number' ? dur : null,
    at: String(r.startedAt ?? r.createdAt ?? r.created_at ?? r.started_at ?? ''),
    log: typeof r.log === 'string' ? r.log : '',
    error: typeof r.error === 'string' ? r.error : '',
  };
}

export function RunsPanel({ appId }: { appId: string }) {
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!api.listRuns) return;
    setBusy(true);
    try {
      const res = await api.listRuns(appId, { limit: 50 });
      const bad = errorOf(res);
      if (bad) return setError(bad);
      setRuns(asArray(res, 'runs').map(toRun));
      setError(null);
    } catch (e) {
      setError(fail(e, 'No se pudieron leer las ejecuciones.'));
    } finally {
      setBusy(false);
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Section
      title="Ejecuciones"
      help="Cada vez que corrió una función: quién la disparó, cuánto tardó y su registro."
      action={
        api.listRuns ? (
          <button
            type="button"
            className={BTN_SECONDARY}
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCw className={clsx('h-3.5 w-3.5', busy && 'animate-spin')} aria-hidden />{' '}
            Actualizar
          </button>
        ) : undefined
      }
    >
      {!api.listRuns ? (
        <Unavailable />
      ) : (
        <>
          <ErrorLine error={error} />
          {runs && runs.length === 0 && (
            <p className="text-xs text-ink-muted">Todavía no ha corrido ninguna función.</p>
          )}
          {runs && runs.length > 0 && (
            <div className="overflow-x-auto rounded-card border border-border">
              <table className="w-full text-left text-xs">
                <thead className="bg-surface-2 text-ink-muted">
                  <tr>
                    <th className="px-3 py-1.5 font-semibold">Función</th>
                    <th className="px-3 py-1.5 font-semibold">Estado</th>
                    <th className="px-3 py-1.5 font-semibold">Origen</th>
                    <th className="px-3 py-1.5 font-semibold">Duración</th>
                    <th className="px-3 py-1.5 font-semibold">Cuándo</th>
                    <th className="px-3 py-1.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {runs.map((r) => {
                    const ok = r.status === 'ok' || r.status === 'success';
                    const hasLog = Boolean(r.log.trim() || r.error);
                    return (
                      <Fragment key={r.id}>
                        <tr>
                          <td className="px-3 py-1.5 font-mono text-ink">{r.fn}</td>
                          <td className="px-3 py-1.5">
                            <span
                              className={clsx(
                                'rounded-pill px-2 py-0.5 text-micro font-semibold',
                                ok ? 'bg-emerald-soft text-emerald' : 'bg-rose-soft text-rose',
                              )}
                            >
                              {ok ? 'Bien' : r.status === 'error' ? 'Error' : r.status}
                            </span>
                          </td>
                          <td className="px-3 py-1.5 text-ink-muted">{r.trigger}</td>
                          <td className="px-3 py-1.5 text-ink-muted">
                            {r.durationMs === null
                              ? '—'
                              : r.durationMs >= 1000
                                ? `${(r.durationMs / 1000).toFixed(1)} s`
                                : `${r.durationMs} ms`}
                          </td>
                          <td className="px-3 py-1.5 text-ink-faint">{when(r.at)}</td>
                          <td className="px-3 py-1.5 text-right">
                            {hasLog && (
                              <button
                                type="button"
                                className="text-primary hover:underline"
                                aria-expanded={open === r.id}
                                onClick={() => setOpen(open === r.id ? null : r.id)}
                              >
                                {open === r.id ? 'Ocultar' : 'Ver registro'}
                              </button>
                            )}
                          </td>
                        </tr>
                        {open === r.id && (
                          <tr>
                            <td colSpan={6} className="bg-surface-2 px-3 py-2">
                              {r.error && <p className="mb-1 font-semibold text-rose">{r.error}</p>}
                              <pre className="max-h-64 overflow-auto font-mono text-micro leading-relaxed text-ink-muted">
                                {r.log || ' '}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Base de datos propia (fase 3, 0246)
// ---------------------------------------------------------------------------

function bytesText(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** Estado de la base propia de la app, migraciones y una consola de sólo lectura. */
export function DbPanel({ appId }: { appId: string }) {
  const [status, setStatus] = useState<Awaited<ReturnType<typeof codeActions.dbStatus>> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<{
    fields: string[];
    rows: Array<Record<string, unknown>>;
    truncated: boolean;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await codeActions.dbStatus(appId));
      setError(null);
    } catch (e) {
      setError(fail(e, 'No se pudo leer el estado de la base de datos.'));
    }
  }, [appId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply() {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const res = await codeActions.applyMigrations(appId);
      if (!res.ok) return setError(res.error);
      setNote(
        res.applied.length
          ? `Migraciones aplicadas: ${res.applied.join(', ')}.`
          : 'No había migraciones pendientes.',
      );
      await load();
    } catch (e) {
      setError(fail(e, 'No se pudieron aplicar las migraciones.'));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!sql.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await codeActions.dbQuery(appId, sql);
      if (!res.ok) {
        setResult(null);
        return setError(res.error);
      }
      setResult({ fields: res.fields, rows: res.rows, truncated: res.truncated });
    } catch (e) {
      setError(fail(e, 'No se pudo consultar la base de datos.'));
    } finally {
      setBusy(false);
    }
  }

  const pending = status?.pending.length ?? 0;
  return (
    <Section
      title="Base de datos"
      help="La base propia de la app: un esquema que solo ella ve. Las migraciones son los archivos db/migrations/NNNN_nombre.sql del código; se aplican una vez, en orden, al publicar o aquí. OJO: esta base no filtra por rol del usuario; las funciones deciden qué ve cada quien."
      action={
        <div className="flex gap-2">
          <button
            type="button"
            className={BTN_SECONDARY}
            disabled={busy}
            onClick={() => void load()}
          >
            <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Actualizar
          </button>
          {status?.available && (
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy || pending === 0 || (status?.errors.length ?? 0) > 0}
              onClick={() => void apply()}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Database className="h-3.5 w-3.5" aria-hidden />
              )}{' '}
              Aplicar migraciones{pending ? ` (${pending})` : ''}
            </button>
          )}
        </div>
      }
    >
      <ErrorLine error={error} />
      {note && <p className="rounded-card bg-emerald-soft px-3 py-2 text-xs text-emerald">{note}</p>}
      {status && !status.available && (
        <p className="text-xs text-ink-muted">
          Las bases propias no están disponibles en este servidor.
        </p>
      )}
      {status && (
        <>
          <p className="text-xs text-ink-muted">
            {status.exists ? (
              <>
                Esquema <span className="font-mono text-ink">{status.schema}</span> ·{' '}
                {bytesText(status.sizeBytes)} de {bytesText(status.quotaBytes)}
                {status.percent !== null ? ` (${status.percent} %)` : ''}
              </>
            ) : (
              'Todavía no tiene base: se crea con la primera migración.'
            )}
          </p>
          {status.errors.map((e) => (
            <p key={e} role="alert" className="rounded-card bg-rose-soft px-3 py-2 text-xs text-rose">
              {e}
            </p>
          ))}
          {status.warnings.map((w) => (
            <p key={w} className="text-xs text-amber">
              {w}
            </p>
          ))}
          {(status.migrations.length > 0 || pending > 0) && (
            <ul className="divide-y divide-border rounded-card border border-border text-xs">
              {status.migrations.map((m) => (
                <li key={m.name} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="font-mono text-ink">{m.name}</span>
                  <span className="text-ink-faint">aplicada {when(m.appliedAt)}</span>
                </li>
              ))}
              {status.pending.map((n) => (
                <li key={n} className="flex items-center justify-between gap-2 px-3 py-1.5">
                  <span className="font-mono text-ink">{n}</span>
                  <span className="rounded-pill bg-amber-soft px-2 py-0.5 text-micro font-semibold text-amber">
                    pendiente
                  </span>
                </li>
              ))}
            </ul>
          )}
          {status.exists && status.available && (
            <div className="space-y-2">
              <textarea
                className={clsx(INPUT, 'min-h-[72px] font-mono text-xs')}
                placeholder="SELECT * FROM mi_tabla LIMIT 20  (solo lectura)"
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                aria-label="Consulta SQL de solo lectura"
              />
              <button
                type="button"
                className={BTN_SECONDARY}
                disabled={busy || !sql.trim()}
                onClick={() => void run()}
              >
                <Play className="h-3.5 w-3.5" aria-hidden /> Consultar
              </button>
              {result && (
                <div className="overflow-x-auto rounded-card border border-border">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-surface-2 text-ink-muted">
                      <tr>
                        {result.fields.map((f) => (
                          <th key={f} className="px-3 py-1.5 font-semibold">
                            {f}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {result.rows.map((r, i) => (
                        // biome-ignore lint/suspicious/noArrayIndexKey: filas de un resultado sin identificador propio
                        <tr key={i}>
                          {result.fields.map((f) => (
                            <td key={f} className="px-3 py-1.5 font-mono text-ink">
                              {cell(r[f])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="px-3 py-1.5 text-micro text-ink-faint">
                    {result.rows.length} fila(s){result.truncated ? ' (recortado)' : ''}
                  </p>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

export function GithubPanel({
  appId,
  link,
  updatedAt,
  hasUnsaved,
  disabled,
  onLinked,
  onPulled,
}: {
  appId: string;
  link: codeActions.CodeGithubLink | null;
  /** Revisión del borrador que ve el editor. */
  updatedAt: string | null;
  hasUnsaved: boolean;
  disabled: boolean;
  onLinked: (link: codeActions.CodeGithubLink | null) => void;
  /** Se trajo el código de GitHub: el editor debe adoptar estos archivos. */
  onPulled: (res: {
    files: Record<string, string>;
    updatedAt: string;
    github: codeActions.CodeGithubLink;
  }) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [repos, setRepos] = useState<Array<{ fullName: string; defaultBranch: string }> | null>(
    null,
  );
  const [branches, setBranches] = useState<string[]>([]);
  const [repo, setRepo] = useState(link?.repo ?? '');
  const [branch, setBranch] = useState(link?.branch ?? '');
  const [path, setPath] = useState(link?.path ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState<null | 'link' | 'push' | 'pull' | 'repos'>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; url?: string } | null>(null);

  async function openForm() {
    setEditing(true);
    setError(null);
    if (repos) return;
    setBusy('repos');
    const res = await githubActions.githubRepos(appId);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setRepos(res.repos);
  }

  async function pickRepo(full: string) {
    setRepo(full);
    setBranches([]);
    const def = repos?.find((r) => r.fullName === full)?.defaultBranch ?? '';
    setBranch(def);
    if (!full.includes('/')) return;
    const res = await githubActions.githubBranches(appId, full);
    if (res.ok) setBranches(res.branches);
  }

  async function connect() {
    setBusy('link');
    setError(null);
    const res = await githubActions.connectGithub(appId, { repo, branch, path });
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setEditing(false);
    setNote({ text: 'Conectado.' });
    onLinked(res.github);
  }

  async function disconnect() {
    if (
      !(await confirmDialog({
        title: '¿Desconectar GitHub?',
        message: 'El código se queda como está; solo se quita el vínculo.',
        confirmLabel: 'Desconectar',
      }))
    )
      return;
    const res = await githubActions.disconnectGithub(appId);
    if (!res.ok) return setError(res.error);
    onLinked(null);
  }

  async function push() {
    if (hasUnsaved) return setError('Guarda tus cambios antes de enviar: se envía lo guardado.');
    setBusy('push');
    setError(null);
    setNote(null);
    const res = await githubActions.pushToGithub(appId, message || undefined);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    setMessage('');
    setNote({ text: res.summary, url: res.committed ? res.url : undefined });
    onLinked(res.github);
  }

  async function pull() {
    const ok = await confirmDialog({
      title: '¿Traer el código de GitHub?',
      message: hasUnsaved
        ? 'Reemplaza el borrador con el de la rama y descarta lo que tienes sin guardar.'
        : 'Reemplaza el borrador con el de la rama (lo publicado no cambia).',
      confirmLabel: 'Traer',
      tone: 'danger',
    });
    if (!ok) return;
    setBusy('pull');
    setError(null);
    setNote(null);
    const res = await githubActions.pullFromGithub(appId, updatedAt);
    setBusy(null);
    if (!res.ok) return setError(res.error);
    onPulled(res);
    setNote({
      text: `Código traído (${Object.keys(res.files).length} archivos).${res.skipped.length ? ` No se trajeron: ${res.skipped.slice(0, 5).join(', ')}.` : ''}`,
    });
  }

  return (
    <Section
      title="GitHub"
      help="Para desarrolladores: envía el borrador a una rama como un commit, o trae los cambios que hizo tu equipo en el repo. Usa tu conexión de GitHub (Integraciones)."
    >
      <ErrorLine error={error} />
      {note && !error && (
        <p className="text-xs font-semibold text-emerald">
          {note.text}{' '}
          {note.url && (
            <a href={note.url} target="_blank" rel="noreferrer" className="text-primary underline">
              Ver el commit
            </a>
          )}
        </p>
      )}
      {link && !editing ? (
        <div className="space-y-2">
          <p className="flex flex-wrap items-center gap-2 text-xs text-ink">
            <GitBranch className="h-3.5 w-3.5 text-ink-faint" aria-hidden />
            <code className="font-mono font-semibold">{link.repo}</code>
            <span className="text-ink-muted">rama</span>
            <code className="font-mono">{link.branch}</code>
            <span className="text-ink-muted">carpeta</span>
            <code className="font-mono">{link.path || '/'}</code>
            {link.lastSha && (
              <span className="text-ink-faint">último {link.lastSha.slice(0, 7)}</span>
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Mensaje del commit (opcional)"
              aria-label="Mensaje del commit"
              maxLength={200}
              className={clsx(INPUT, 'w-72')}
            />
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={disabled || busy !== null}
              onClick={() => void push()}
            >
              {busy === 'push' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Upload className="h-3.5 w-3.5" aria-hidden />
              )}
              Enviar a GitHub
            </button>
            <button
              type="button"
              className={BTN_SECONDARY}
              disabled={disabled || busy !== null}
              onClick={() => void pull()}
            >
              {busy === 'pull' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <GitBranch className="h-3.5 w-3.5" aria-hidden />
              )}
              Traer de GitHub
            </button>
            <button
              type="button"
              className="text-xs text-ink-muted hover:underline"
              onClick={() => void openForm()}
            >
              Cambiar
            </button>
            <button
              type="button"
              className="text-xs text-rose hover:underline"
              onClick={() => void disconnect()}
            >
              Desconectar
            </button>
          </div>
        </div>
      ) : editing ? (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              onBlur={() => repo.includes('/') && void pickRepo(repo)}
              list="gh-repos"
              placeholder="propietario/repo"
              aria-label="Repositorio"
              className={clsx(INPUT, 'w-64 font-mono')}
            />
            <datalist id="gh-repos">
              {repos?.map((r) => (
                <option key={r.fullName} value={r.fullName} />
              ))}
            </datalist>
            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              list="gh-branches"
              placeholder="rama (main)"
              aria-label="Rama"
              className={clsx(INPUT, 'w-40 font-mono')}
            />
            <datalist id="gh-branches">
              {branches.map((b) => (
                <option key={b} value={b} />
              ))}
            </datalist>
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="carpeta (vacío = raíz)"
              aria-label="Carpeta del repo"
              className={clsx(INPUT, 'w-48 font-mono')}
            />
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={BTN_PRIMARY}
              disabled={busy !== null || !repo || !branch}
              onClick={() => void connect()}
            >
              {busy === 'link' || busy === 'repos' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              ) : (
                <Plug className="h-3.5 w-3.5" aria-hidden />
              )}
              {link ? 'Guardar' : 'Conectar'}
            </button>
            <button type="button" className={BTN_SECONDARY} onClick={() => setEditing(false)}>
              Cancelar
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className={BTN_SECONDARY} onClick={() => void openForm()}>
          <Plug className="h-3.5 w-3.5" aria-hidden /> Conectar con GitHub
        </button>
      )}
    </Section>
  );
}
