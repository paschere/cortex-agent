'use client';

import { workspaceHref } from '@/lib/workspace-context';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  Play,
  RefreshCw,
  ShieldCheck,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

type JsonObject = Record<string, unknown>;
type ToolOption = {
  toolId: string;
  name: string;
  description: string;
  httpMethod: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  inputSchema: {
    fields: Array<{
      name: string;
      type: 'string' | 'number' | 'integer' | 'boolean' | 'string_array';
      required: boolean;
      description: string;
      enum?: string[];
    }>;
  } | null;
  requiresConfirmation: boolean;
};
type CaseOption = {
  id: string;
  title: string;
  state: string;
  evidenceRunId: string | null;
};
type VerifierDraft = {
  toolId: string;
  input: JsonObject;
  path: string;
  match: 'equals' | 'contains';
  expected: unknown;
};
type Operation = {
  id: string;
  case_id: string;
  activation_run_id: string;
  action_tool_id: string;
  action_input: JsonObject;
  verifier_tool_id: string;
  verifier_input: JsonObject;
  verifier_path: string;
  verifier_match: 'equals' | 'contains';
  verifier_expected: unknown;
  source_evidence: JsonObject;
  status:
    | 'awaiting_approval'
    | 'executing'
    | 'verifying'
    | 'succeeded'
    | 'blocked'
    | 'failed'
    | 'cancelled'
    | 'outcome_unknown'
    | 'verification_failed';
  error: string | null;
  before_observation: unknown;
  action_result: unknown;
  verification_result: unknown;
  evidence: unknown;
  approval_id: string | null;
  approval_expires_at: string | null;
  created_at: string;
  updated_at: string;
  proposal: {
    action: { toolId: string; input: JsonObject };
    verifier: VerifierDraft;
  };
};

export type ActivationExecutionProposal = {
  action: { toolId: string; input: JsonObject };
  verifier: VerifierDraft;
};

export type ActivationExecutionProps = {
  /** Current workspace id; used for the same tenant-aware URL as the app shell. */
  workspaceId: string;
  /** The committed activation case this exact operation is allowed to affect. */
  caseId: string;
  /** The committed run whose immutable evidence is copied into the operation. */
  runId: string;
  /** Optional defaults from a guided activation or a parent detail panel. */
  initialProposal?: ActivationExecutionProposal | null;
  className?: string;
};

const inputClass =
  'min-h-10 w-full rounded-sm border border-border-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
const buttonClass =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-sm px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

const statusLabel: Record<Operation['status'], string> = {
  awaiting_approval: 'Pendiente de aprobación',
  executing: 'Ejecutando',
  verifying: 'Verificando',
  succeeded: 'Verificado',
  blocked: 'Bloqueado',
  failed: 'Falló',
  cancelled: 'Cancelado',
  outcome_unknown: 'Resultado desconocido',
  verification_failed: 'No coincidió la verificación',
};

function pretty(value: unknown) {
  return JSON.stringify(value ?? null, null, 2);
}

function readError(body: unknown, fallback: string) {
  return body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
    ? body.error
    : fallback;
}

function parseObject(value: string, label: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} debe ser JSON válido.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error(`${label} debe ser un objeto JSON.`);
  return parsed as JsonObject;
}

function parseJson(value: string, label: string) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} debe ser JSON válido.`);
  }
}

function asFieldValue(value: unknown, type: string) {
  if (value === undefined || value === null) return '';
  if (type === 'boolean') return Boolean(value);
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
}

type FieldValues = Record<string, string | boolean>;

function rawObject(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonObject)
      : {};
  } catch {
    return {};
  }
}

function buildInput(
  tool: ToolOption | undefined,
  values: FieldValues,
  advanced: boolean,
  raw: string,
  label: string,
): JsonObject {
  if (advanced || !tool?.inputSchema?.fields.length) return parseObject(raw, label);
  const seed = rawObject(raw);
  const result: JsonObject = {};
  for (const field of tool.inputSchema.fields) {
    const value = Object.prototype.hasOwnProperty.call(values, field.name)
      ? values[field.name]
      : seed[field.name];
    if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) {
      if (field.required) throw new Error(`${field.name} es obligatorio.`);
      continue;
    }
    if (field.type === 'boolean') {
      result[field.name] = value === true || value === 'true';
    } else if (field.type === 'number' || field.type === 'integer') {
      const number = Number(value);
      if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number)))
        throw new Error(
          `${field.name} debe ser ${field.type === 'integer' ? 'un entero' : 'un número'}.`,
        );
      result[field.name] = number;
    } else if (field.type === 'string_array') {
      const items = (Array.isArray(value) ? value : String(value).split(','))
        .map((item) => String(item).trim())
        .filter(Boolean);
      if (field.required && items.length === 0) throw new Error(`${field.name} es obligatorio.`);
      result[field.name] = items;
    } else {
      result[field.name] = String(value);
    }
  }
  return result;
}

function formatDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function statusTone(status: Operation['status']) {
  if (status === 'succeeded') return 'border-emerald-300 bg-emerald-50 text-emerald-800';
  if (['blocked', 'failed', 'cancelled', 'outcome_unknown', 'verification_failed'].includes(status))
    return 'border-amber-300 bg-amber-50 text-amber-900';
  return 'border-border bg-surface-muted text-ink-soft';
}

export function ActivationExecution({
  workspaceId,
  caseId,
  runId,
  initialProposal = null,
  className = '',
}: ActivationExecutionProps) {
  const apiHref = workspaceHref(workspaceId, '/api/activations/operations');
  const [tools, setTools] = useState<ToolOption[]>([]);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [cases, setCases] = useState<CaseOption[]>([]);
  const [actionToolId, setActionToolId] = useState(initialProposal?.action.toolId ?? '');
  const [verifierToolId, setVerifierToolId] = useState(initialProposal?.verifier.toolId ?? '');
  const [actionInput, setActionInput] = useState(pretty(initialProposal?.action.input ?? {}));
  const [verifierInput, setVerifierInput] = useState(pretty(initialProposal?.verifier.input ?? {}));
  const [verifierPath, setVerifierPath] = useState(initialProposal?.verifier.path ?? 'data');
  const [verifierMatch, setVerifierMatch] = useState<'equals' | 'contains'>(
    initialProposal?.verifier.match ?? 'equals',
  );
  const [verifierExpected, setVerifierExpected] = useState(
    pretty(initialProposal?.verifier.expected ?? null),
  );
  const [actionFieldValues, setActionFieldValues] = useState<FieldValues>({});
  const [verifierFieldValues, setVerifierFieldValues] = useState<FieldValues>({});
  const [actionAdvanced, setActionAdvanced] = useState(false);
  const [verifierAdvanced, setVerifierAdvanced] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const actionTools = useMemo(() => tools.filter((tool) => tool.httpMethod !== 'GET'), [tools]);
  const verifierTools = useMemo(
    () => tools.filter((tool) => tool.httpMethod === 'GET' && !tool.requiresConfirmation),
    [tools],
  );
  const selectedActionTool = actionTools.find((tool) => tool.toolId === actionToolId);
  const selectedVerifierTool = verifierTools.find((tool) => tool.toolId === verifierToolId);
  const currentCase = cases.find((item) => item.id === caseId);
  const canPrepare =
    !loading &&
    Boolean(currentCase) &&
    !['verified', 'cancelled'].includes(currentCase?.state ?? '');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `${apiHref}&caseId=${encodeURIComponent(caseId)}&runId=${encodeURIComponent(runId)}`,
        { cache: 'no-store' },
      );
      const body = (await response.json().catch(() => null)) as {
        operations?: Operation[];
        tools?: ToolOption[];
        cases?: CaseOption[];
        error?: string;
      } | null;
      if (!response.ok || !body)
        throw new Error(readError(body, 'No pudimos cargar la operación.'));
      setOperations(body.operations ?? []);
      setTools(body.tools ?? []);
      setCases(body.cases ?? []);
      if (!actionToolId && body.tools?.find((tool) => tool.httpMethod !== 'GET'))
        setActionToolId(body.tools.find((tool) => tool.httpMethod !== 'GET')?.toolId ?? '');
      if (
        !verifierToolId &&
        body.tools?.find((tool) => tool.httpMethod === 'GET' && !tool.requiresConfirmation)
      )
        setVerifierToolId(
          body.tools.find((tool) => tool.httpMethod === 'GET' && !tool.requiresConfirmation)
            ?.toolId ?? '',
        );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No pudimos cargar la operación.');
    } finally {
      setLoading(false);
    }
  }, [apiHref, caseId, runId, actionToolId, verifierToolId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function post(payload: unknown, busyKey: string) {
    setBusy(busyKey);
    setError(null);
    try {
      const response = await fetch(apiHref, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = (await response.json().catch(() => null)) as {
        operation?: Operation;
        error?: string;
      } | null;
      if (!response.ok || !body?.operation)
        throw new Error(readError(body, 'No pudimos actualizar la operación.'));
      setOperations((current) => {
        const next = current.filter((item) => item.id !== body.operation?.id);
        return [body.operation as Operation, ...next];
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No pudimos actualizar la operación.');
    } finally {
      setBusy(null);
    }
  }

  async function prepare(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      if (!canPrepare)
        throw new Error(
          'Esta activación ya no está vigente para preparar una propuesta. Puedes revisar operaciones anteriores.',
        );
      if (!actionToolId || !verifierToolId) throw new Error('Elige una acción y un verificador.');
      await post(
        {
          action: 'prepare',
          caseId,
          runId,
          operation: {
            toolId: actionToolId,
            input: buildInput(
              selectedActionTool,
              actionFieldValues,
              actionAdvanced,
              actionInput,
              'Los parámetros de la acción',
            ),
          },
          verifier: {
            toolId: verifierToolId,
            input: buildInput(
              selectedVerifierTool,
              verifierFieldValues,
              verifierAdvanced,
              verifierInput,
              'Los parámetros del verificador',
            ),
            path: verifierPath,
            match: verifierMatch,
            expected: parseJson(verifierExpected, 'El criterio esperado'),
          },
        },
        'prepare',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'La propuesta no es válida.');
    }
  }

  const renderFields = (
    tool: ToolOption | undefined,
    values: FieldValues,
    raw: string,
    update: (next: FieldValues) => void,
  ) => {
    const fields = tool?.inputSchema?.fields ?? [];
    if (fields.length === 0)
      return (
        <p className="text-xs text-ink-muted">
          Esta herramienta no declara parámetros simples. Puedes usar JSON avanzado.
        </p>
      );
    const seed = rawObject(raw);
    return (
      <div className="space-y-3">
        {fields.map((field) => {
          const value = Object.prototype.hasOwnProperty.call(values, field.name)
            ? values[field.name]
            : asFieldValue(seed[field.name], field.type);
          const label = `${field.name}${field.required ? ' *' : ''}`;
          if (field.type === 'boolean') {
            return (
              <label key={field.name} className="flex items-start gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  className="mt-1 h-4 w-4 rounded border-border-strong text-primary focus:ring-primary"
                  checked={value === true || value === 'true'}
                  onChange={(event) => update({ ...values, [field.name]: event.target.checked })}
                  disabled={Boolean(busy)}
                />
                <span>
                  <span className="font-medium">{label}</span>
                  <span className="block text-xs text-ink-muted">{field.description}</span>
                </span>
              </label>
            );
          }
          const control = field.enum?.length ? (
            <select
              className={inputClass}
              value={String(value ?? '')}
              onChange={(event) => update({ ...values, [field.name]: event.target.value })}
              disabled={Boolean(busy)}
            >
              <option value="">Selecciona una opción</option>
              {field.enum.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          ) : (
            <input
              className={inputClass}
              type={field.type === 'number' || field.type === 'integer' ? 'number' : 'text'}
              step={field.type === 'integer' ? 1 : field.type === 'number' ? 'any' : undefined}
              value={String(value ?? '')}
              onChange={(event) => update({ ...values, [field.name]: event.target.value })}
              disabled={Boolean(busy)}
              placeholder={field.type === 'string_array' ? 'valor 1, valor 2' : undefined}
            />
          );
          return (
            <div key={field.name} className="block space-y-1 text-sm text-ink">
              <span className="font-medium">{label}</span>
              {control}
              <span className="block text-xs text-ink-muted">{field.description}</span>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section
      className={`space-y-5 rounded-lg border border-border bg-surface p-5 shadow-sm ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink-muted">
            Ejecución de activación
          </p>
          <h2 className="mt-1 text-lg font-semibold text-ink">
            Proponer, aprobar y verificar una acción
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            La propuesta queda vinculada al asunto y a la evidencia de la activación. Una aprobación
            explícita abre una sola llamada; la lectura GET debe confirmar el criterio indicado.
          </p>
        </div>
        <button
          type="button"
          className={`${buttonClass} border border-border-strong bg-surface text-ink hover:bg-surface-muted`}
          onClick={() => void load()}
          disabled={loading || Boolean(busy)}
        >
          <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden="true" />
          Actualizar
        </button>
      </div>

      {error ? (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : null}

      {!loading && !canPrepare ? (
        <div className="rounded-md border border-border bg-surface-muted p-4 text-sm text-ink-soft">
          <p className="font-medium text-ink">
            {currentCase
              ? 'Este asunto está cerrado y no admite una nueva propuesta.'
              : 'Esta activación ya no está vigente para preparar una propuesta.'}
          </p>
          <p className="mt-1">
            Puedes revisar operaciones anteriores; para preparar una nueva, vuelve a simular una
            fuente vigente.
          </p>
        </div>
      ) : null}

      {canPrepare ? (
        <form
          onSubmit={prepare}
          className="grid gap-4 rounded-md border border-border bg-surface-muted p-4 lg:grid-cols-2"
        >
          <div className="lg:col-span-2 flex items-center gap-2 text-sm font-semibold text-ink">
            <ShieldCheck className="h-4 w-4 text-primary" aria-hidden="true" />
            Nueva propuesta exacta
          </div>
          <label className="space-y-1.5 text-sm text-ink">
            <span className="font-medium">Herramienta de acción</span>
            <select
              className={inputClass}
              value={actionToolId}
              onChange={(event) => {
                setActionToolId(event.target.value);
                setActionFieldValues({});
                setActionInput('{}');
                setActionAdvanced(false);
              }}
              disabled={Boolean(busy)}
            >
              <option value="">Selecciona una acción de escritura</option>
              {actionTools.map((tool) => (
                <option key={tool.toolId} value={tool.toolId}>
                  {tool.name} · {tool.httpMethod}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-sm text-ink">
            <span className="font-medium">Herramienta verificadora</span>
            <select
              className={inputClass}
              value={verifierToolId}
              onChange={(event) => {
                setVerifierToolId(event.target.value);
                setVerifierFieldValues({});
                setVerifierInput('{}');
                setVerifierAdvanced(false);
              }}
              disabled={Boolean(busy)}
            >
              <option value="">Selecciona una lectura GET</option>
              {verifierTools.map((tool) => (
                <option key={tool.toolId} value={tool.toolId}>
                  {tool.name} · GET
                </option>
              ))}
            </select>
          </label>
          <div className="space-y-3 rounded-md border border-border bg-surface p-3">
            <p className="text-sm font-medium text-ink">Parámetros de la acción</p>
            {renderFields(selectedActionTool, actionFieldValues, actionInput, setActionFieldValues)}
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={actionAdvanced}
                onChange={(event) => setActionAdvanced(event.target.checked)}
                disabled={Boolean(busy)}
              />
              Editar JSON avanzado
            </label>
            {actionAdvanced ? (
              <textarea
                className={`${inputClass} min-h-28 font-mono text-xs`}
                value={actionInput}
                onChange={(event) => setActionInput(event.target.value)}
                disabled={Boolean(busy)}
                spellCheck={false}
              />
            ) : null}
          </div>
          <div className="space-y-3 rounded-md border border-border bg-surface p-3">
            <p className="text-sm font-medium text-ink">Parámetros del verificador</p>
            {renderFields(
              selectedVerifierTool,
              verifierFieldValues,
              verifierInput,
              setVerifierFieldValues,
            )}
            <label className="flex items-center gap-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={verifierAdvanced}
                onChange={(event) => setVerifierAdvanced(event.target.checked)}
                disabled={Boolean(busy)}
              />
              Editar JSON avanzado
            </label>
            {verifierAdvanced ? (
              <textarea
                className={`${inputClass} min-h-28 font-mono text-xs`}
                value={verifierInput}
                onChange={(event) => setVerifierInput(event.target.value)}
                disabled={Boolean(busy)}
                spellCheck={false}
              />
            ) : null}
          </div>
          <label className="space-y-1.5 text-sm text-ink">
            <span className="font-medium">Ruta a comparar</span>
            <input
              className={inputClass}
              value={verifierPath}
              onChange={(event) => setVerifierPath(event.target.value)}
              placeholder="data.status"
              disabled={Boolean(busy)}
            />
            <span className="text-xs text-ink-muted">
              Usa una ruta de respuesta propia, por ejemplo data.status.
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1.5 text-sm text-ink">
              <span className="font-medium">Criterio</span>
              <select
                className={inputClass}
                value={verifierMatch}
                onChange={(event) => setVerifierMatch(event.target.value as 'equals' | 'contains')}
                disabled={Boolean(busy)}
              >
                <option value="equals">Igual a</option>
                <option value="contains">Contiene</option>
              </select>
            </label>
            <label className="space-y-1.5 text-sm text-ink">
              <span className="font-medium">Valor esperado · JSON</span>
              <input
                className={`${inputClass} font-mono text-xs`}
                value={verifierExpected}
                onChange={(event) => setVerifierExpected(event.target.value)}
                disabled={Boolean(busy)}
                spellCheck={false}
              />
            </label>
          </div>
          <p className="lg:col-span-2 rounded-md border border-primary/20 bg-primary/5 p-3 text-xs leading-5 text-ink-soft">
            Se considerará confirmado únicamente si la lectura GET devuelve{' '}
            <span className="font-mono font-semibold text-ink">{verifierPath || 'data'}</span>{' '}
            {verifierMatch === 'equals' ? 'igual a' : 'conteniendo'}{' '}
            <span className="font-mono font-semibold text-ink">{verifierExpected || '…'}</span>. Una
            respuesta HTTP 200 sin ese valor no completa la operación.
          </p>
          <div className="lg:col-span-2 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <p className="max-w-xl text-xs leading-5 text-ink-muted">
              La propuesta no ejecuta nada. Después de prepararla verás la carga exacta, la
              evidencia de origen y el botón de aprobación.
            </p>
            <button
              type="submit"
              className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`}
              disabled={
                loading || Boolean(busy) || actionTools.length === 0 || verifierTools.length === 0
              }
            >
              {busy === 'prepare' ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Play className="h-4 w-4" aria-hidden="true" />
              )}
              Preparar propuesta
            </button>
          </div>
        </form>
      ) : null}

      {canPrepare && (actionTools.length === 0 || verifierTools.length === 0) ? (
        <p className="rounded-md border border-border bg-surface-muted p-3 text-sm text-ink-soft">
          Necesitas una herramienta de empresa de escritura y otra GET de lectura sin confirmación
          para preparar una operación.
        </p>
      ) : null}

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-ink">Operaciones de este asunto</h3>
          <span className="text-xs text-ink-muted">
            {operations.length} registrada{operations.length === 1 ? '' : 's'}
          </span>
        </div>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Cargando operaciones…
          </div>
        ) : operations.length === 0 ? (
          <p className="rounded-md border border-dashed border-border-strong p-4 text-sm text-ink-soft">
            Todavía no hay una propuesta vinculada a este asunto.
          </p>
        ) : (
          operations.map((operation) => (
            <article key={operation.id} className="rounded-md border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-mono text-xs text-ink-muted">{operation.id}</p>
                  <p className="mt-1 text-sm font-semibold text-ink">{operation.action_tool_id}</p>
                  <p className="text-xs text-ink-muted">
                    Preparada {formatDate(operation.created_at)}
                  </p>
                </div>
                <span
                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${statusTone(operation.status)}`}
                >
                  {statusLabel[operation.status]}
                </span>
              </div>
              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                <details
                  className="group rounded-md border border-border bg-surface-muted p-3"
                  open={operation.status === 'awaiting_approval'}
                >
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-ink">
                    <span>Propuesta exacta</span>
                    <ChevronDown
                      className="h-4 w-4 transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    />
                  </summary>
                  <div className="mt-3 space-y-2 text-xs text-ink-soft">
                    <p>
                      <span className="font-semibold text-ink">Acción:</span>{' '}
                      {operation.proposal.action.toolId}
                    </p>
                    <pre className="max-h-44 overflow-auto rounded bg-surface p-2 font-mono">
                      {pretty(operation.proposal.action.input)}
                    </pre>
                    <p>
                      <span className="font-semibold text-ink">Verificador:</span>{' '}
                      {operation.proposal.verifier.toolId} · {operation.proposal.verifier.path}{' '}
                      {operation.proposal.verifier.match}
                    </p>
                    <pre className="max-h-44 overflow-auto rounded bg-surface p-2 font-mono">
                      {pretty(operation.proposal.verifier.expected)}
                    </pre>
                  </div>
                </details>
                <details className="group rounded-md border border-border bg-surface-muted p-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium text-ink">
                    <span>Evidencia y resultado</span>
                    <ChevronDown
                      className="h-4 w-4 transition-transform group-open:rotate-180"
                      aria-hidden="true"
                    />
                  </summary>
                  <div className="mt-3 space-y-2 text-xs text-ink-soft">
                    <p className="font-semibold text-ink">
                      Evidencia de origen capturada al preparar
                    </p>
                    <pre className="max-h-40 overflow-auto rounded bg-surface p-2 font-mono">
                      {pretty(operation.source_evidence)}
                    </pre>
                    {operation.error ? (
                      <p className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">
                        {operation.error}
                      </p>
                    ) : null}
                    {operation.verification_result ? (
                      <pre className="max-h-40 overflow-auto rounded bg-surface p-2 font-mono">
                        {pretty(operation.verification_result)}
                      </pre>
                    ) : null}
                  </div>
                </details>
              </div>
              {operation.status === 'awaiting_approval' ? (
                <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-3">
                  <p className="mr-auto text-xs text-ink-muted">
                    La aprobación vence {formatDate(operation.approval_expires_at)}.
                  </p>
                  <button
                    type="button"
                    className={`${buttonClass} border border-border-strong bg-surface text-ink hover:bg-surface-muted`}
                    onClick={() =>
                      void post({ action: 'decline', operationId: operation.id }, operation.id)
                    }
                    disabled={Boolean(busy)}
                  >
                    <XCircle className="h-4 w-4" aria-hidden="true" /> Rechazar
                  </button>
                  <button
                    type="button"
                    className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`}
                    onClick={() =>
                      void post({ action: 'approve', operationId: operation.id }, operation.id)
                    }
                    disabled={Boolean(busy)}
                  >
                    {busy === operation.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                    )}{' '}
                    Aprobar y ejecutar
                  </button>
                </div>
              ) : null}
              {['outcome_unknown', 'verification_failed', 'executing', 'verifying'].includes(
                operation.status,
              ) ? (
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                  <p className="text-xs text-ink-muted">
                    Solo se consultará el verificador. No se repetirá la escritura.
                  </p>
                  <button
                    type="button"
                    className={`${buttonClass} border border-border-strong bg-surface text-ink hover:bg-surface-muted`}
                    onClick={() =>
                      void post({ action: 'reconcile', operationId: operation.id }, operation.id)
                    }
                    disabled={Boolean(busy)}
                  >
                    {busy === operation.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    ) : (
                      <RefreshCw className="h-4 w-4" aria-hidden="true" />
                    )}{' '}
                    Reconciliar lectura
                  </button>
                </div>
              ) : null}
            </article>
          ))
        )}
      </div>
      <p className="text-xs leading-5 text-ink-muted">
        El estado del asunto permanece bajo revisión humana; una respuesta HTTP 200 o una respuesta
        del proveedor no lo cierra automáticamente.
      </p>
    </section>
  );
}
