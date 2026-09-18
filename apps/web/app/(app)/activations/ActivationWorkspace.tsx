'use client';

import type {
  ActivationCandidate,
  ActivationConditionOperator,
  ActivationDefinition,
  ActivationRun,
  ActivationSource,
  ActivationsGetResponse,
  CommitActivationResponse,
  InvoiceColumnMapping,
  PrepareSourceResponse,
  SimulateActivationResponse,
} from '@/lib/activations/types';
import { workspaceHref } from '@/lib/workspace-context';
import {
  AlertCircle,
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  FileSpreadsheet,
  History,
  Link2,
  Loader2,
  Plug,
  RefreshCw,
  SearchCheck,
  ShieldCheck,
  Table2,
  Type,
  Upload,
} from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivationExecution } from './ActivationExecution';

type Props = {
  workspaceId: string;
  organizationName: string;
  feedHref: string;
  feedFileHref: string;
  feedUrlHref: string;
  feedTextHref: string;
  feedApiHref: string;
  managementHref: string;
  initialSourceId?: string | null;
  initialPrompt?: string;
  initialRunId?: string | null;
};
type MappingKey = keyof InvoiceColumnMapping;
type Result = { run: ActivationRun; created: number; reused: number; restored?: boolean };
type Condition = {
  column: number;
  operator: ActivationConditionOperator;
  value?: string;
  uiId: string;
};
type PlanResponse = {
  status: 'ready' | 'needs_input';
  explanation: string;
  questions: string[];
  draft?: {
    sourceId: string;
    sheetIndex: number;
    viewId?: string;
    definition: ActivationDefinition;
    trigger?: {
      kind: 'manual' | 'on_source_change' | 'scheduled';
      intervalMinutes?: 60 | 360 | 1440 | 10080;
    };
  };
  limitations: string[];
};

const fields: Array<{ key: MappingKey; label: string; hint: string }> = [
  { key: 'invoiceNumber', label: 'Número de factura', hint: 'Identificador único' },
  { key: 'issuer', label: 'Emisor', hint: 'Empresa o proveedor' },
  { key: 'amount', label: 'Valor', hint: 'Importe de la factura' },
  { key: 'currency', label: 'Moneda', hint: 'COP, USD…' },
  { key: 'issuedOn', label: 'Fecha de emisión', hint: 'Fecha de la factura' },
];

const aliases: Record<MappingKey, string[]> = {
  invoiceNumber: ['factura', 'numero', 'número', 'invoice', 'id'],
  issuer: ['emisor', 'proveedor', 'issuer', 'vendor', 'empresa'],
  amount: ['valor', 'monto', 'amount', 'total', 'importe'],
  currency: ['moneda', 'currency', 'divisa'],
  issuedOn: ['fecha', 'emision', 'emisión', 'issued', 'date'],
};

const button =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-sm px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
const select =
  'min-h-10 w-full rounded-sm border border-border-strong bg-surface px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
const noValueOperators = new Set<ActivationConditionOperator>([
  'is_empty',
  'before_today',
  'after_today',
]);

function message(value: unknown, fallback: string) {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') {
    return value.error;
  }
  return fallback;
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('es-CO', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

export function suggestMapping(headers: string[]): InvoiceColumnMapping {
  const used = new Set<number>();
  const output = {} as InvoiceColumnMapping;
  for (const field of fields) {
    const found = headers.findIndex((header, index) => {
      const normalized = header.toLocaleLowerCase('es');
      return !used.has(index) && aliases[field.key].some((alias) => normalized.includes(alias));
    });
    output[field.key] = found;
    if (found >= 0) used.add(found);
  }
  return output;
}

export function groupCandidates(candidates: ActivationCandidate[]) {
  const matchedGroups = new Map<string, ActivationCandidate[]>();
  const unmatched: ActivationCandidate[] = [];
  const invalid: ActivationCandidate[] = [];
  for (const item of candidates) {
    if (item.status === 'matched') {
      const key = item.groupKey ?? `row:${item.rowIndex}`;
      const group = matchedGroups.get(key) ?? [];
      group.push(item);
      matchedGroups.set(key, group);
    } else if (item.status === 'unmatched') unmatched.push(item);
    else invalid.push(item);
  }
  return { matchedGroups, unmatched, invalid };
}

export function resolveInitialSource(sources: ActivationSource[], requested: string | null) {
  return requested && sources.some((source) => source.id === requested) ? requested : '';
}

export function ActivationWorkspace({
  workspaceId,
  organizationName,
  feedHref,
  feedFileHref,
  feedUrlHref,
  feedTextHref,
  feedApiHref,
  managementHref,
  initialSourceId = null,
  initialPrompt = '',
  initialRunId = null,
}: Props) {
  const apiHref = workspaceHref(workspaceId, '/api/activations');
  const plannerHref = workspaceHref(workspaceId, '/api/activations/plan');
  const [data, setData] = useState<ActivationsGetResponse | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [sheetIndex, setSheetIndex] = useState<number | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [preparePrompt, setPreparePrompt] = useState('');
  const [preparingSource, setPreparingSource] = useState(false);
  const [mapping, setMapping] = useState<InvoiceColumnMapping | null>(null);
  const [kind, setKind] = useState<'invoice_duplicates' | 'table_rule'>('table_rule');
  const [rule, setRule] = useState<'duplicates' | 'conditions'>('duplicates');
  const [activationName, setActivationName] = useState('Mi activación');
  const [groupBy, setGroupBy] = useState<number[]>([]);
  const [evidenceColumns, setEvidenceColumns] = useState<number[]>([]);
  const [identityColumns, setIdentityColumns] = useState<number[]>([]);
  const [conditions, setConditions] = useState<Condition[]>([
    { column: -1, operator: 'equals', value: '', uiId: 'condition-1' },
  ]);
  const [match, setMatch] = useState<'all' | 'any'>('all');
  const [caseTitle, setCaseTitle] = useState('Revisar coincidencia en tabla');
  const [caseObjective, setCaseObjective] = useState(
    'Confirmar si los registros requieren atención.',
  );
  const [caseNextAction, setCaseNextAction] = useState(
    'Revisar la evidencia y resolver la coincidencia.',
  );
  const [run, setRun] = useState<ActivationRun | null>(null);
  const [shareConfirmed, setShareConfirmed] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<'simulate' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [planning, setPlanning] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [automationDefaults, setAutomationDefaults] = useState<{
    trigger: 'on_change' | 'scheduled';
    intervalMinutes: number;
  }>({ trigger: 'on_change', intervalMinutes: 360 });
  const restoredRunId = useRef<string | null>(null);
  const requestId = useRef(0);
  const actionId = useRef(0);
  const actionController = useRef<AbortController | null>(null);
  const planId = useRef(0);
  const planController = useRef<AbortController | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const id = ++requestId.current;
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(apiHref, { signal, cache: 'no-store' });
        const body = (await response.json().catch(() => null)) as ActivationsGetResponse | null;
        if (!response.ok || !body)
          throw new Error(message(body, 'No pudimos cargar Activaciones.'));
        if (id !== requestId.current || signal?.aborted) return;
        setData(body);
        setSourceId(resolveInitialSource(body.sources, initialSourceId));
      } catch (cause) {
        if (!signal?.aborted && id === requestId.current) {
          setError(cause instanceof Error ? cause.message : 'No pudimos cargar Activaciones.');
        }
      } finally {
        if (id === requestId.current && !signal?.aborted) setLoading(false);
      }
    },
    [apiHref, initialSourceId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setSourceId('');
    setSheetIndex(null);
    setMapping(null);
    setRun(null);
    setResult(null);
    setShareConfirmed(false);
    void load(controller.signal);
    return () => {
      requestId.current += 1;
      actionId.current += 1;
      actionController.current?.abort();
      planId.current += 1;
      planController.current?.abort();
      controller.abort();
    };
  }, [load]);

  const source = data?.sources.find((item) => item.id === sourceId) ?? null;
  const preparedView = source?.preparedViews.find((item) => item.id === viewId);
  const sheet = preparedView
    ? {
        index: 0,
        name: preparedView.name,
        rowCount: preparedView.rowCount,
        headers: preparedView.headers,
      }
    : (source?.sheets.find((item) => item.index === sheetIndex) ?? null);
  const mappingComplete =
    mapping !== null &&
    fields.every(({ key }) => mapping[key] >= 0) &&
    new Set(Object.values(mapping)).size === fields.length;
  const conditionsComplete =
    conditions.length > 0 &&
    conditions.every(
      (condition) =>
        condition.column >= 0 &&
        (noValueOperators.has(condition.operator) || Boolean(condition.value?.trim())),
    );
  const customComplete =
    Boolean(
      activationName.trim() && caseTitle.trim() && caseObjective.trim() && caseNextAction.trim(),
    ) && (rule === 'duplicates' ? groupBy.length > 0 : conditionsComplete);
  const candidateGroups = groupCandidates(run?.candidates ?? []);
  const matchedRows = [...candidateGroups.matchedGroups.values()].flat();
  const matchedGroups = candidateGroups.matchedGroups.size;

  function cancelAction() {
    actionId.current += 1;
    actionController.current?.abort();
    actionController.current = null;
    setPending(null);
  }

  function cancelPlan() {
    planId.current += 1;
    planController.current?.abort();
    planController.current = null;
    setPlanning(false);
    setPlan(null);
  }

  function chooseSource(id: string) {
    cancelAction();
    setSourceId(id);
    setSheetIndex(null);
    setViewId(null);
    setMapping(null);
    setRun(null);
    setResult(null);
    setShareConfirmed(false);
    setError(null);
    cancelPlan();
  }

  function chooseSheet(index: number) {
    cancelAction();
    const next = source?.sheets.find((item) => item.index === index);
    setSheetIndex(index);
    setViewId(null);
    setMapping(next ? suggestMapping(next.headers) : null);
    setRun(null);
    setResult(null);
    setShareConfirmed(false);
    setError(null);
  }

  async function prepareSelectedSource() {
    if (!source || !preparePrompt.trim()) return;
    setPreparingSource(true);
    setError(null);
    try {
      const response = await fetch(workspaceHref(workspaceId, '/api/activations/prepare-source'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sourceId: source.id, prompt: preparePrompt.trim() }),
      });
      const body = (await response.json().catch(() => null)) as PrepareSourceResponse | null;
      if (!response.ok || !body) throw new Error(message(body, 'No pudimos preparar esta fuente.'));
      if (body.status === 'needs_input') throw new Error(body.questions.join(' '));
      await load();
      if (body.viewId && body.table) {
        setViewId(body.viewId);
        setSheetIndex(0);
        setMapping(suggestMapping(body.table.rows[0]?.map((value) => String(value ?? '')) ?? []));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No pudimos preparar esta fuente.');
    } finally {
      setPreparingSource(false);
    }
  }

  function currentDefinition(): ActivationDefinition | null {
    if (kind === 'invoice_duplicates') {
      if (!mappingComplete || !mapping) return null;
      return {
        version: 1,
        name: activationName.trim() || 'Revisar facturas duplicadas',
        kind,
        mapping,
        caseTitle: caseTitle.trim(),
        caseObjective: caseObjective.trim(),
        caseNextAction: caseNextAction.trim(),
      };
    }
    if (!customComplete) return null;
    return {
      version: 1,
      name: activationName.trim(),
      kind,
      rule,
      conditions:
        rule === 'conditions'
          ? conditions.map(({ column, operator, value }) => ({ column, operator, value }))
          : [],
      match,
      groupBy: rule === 'duplicates' ? groupBy : [],
      evidenceColumns,
      identityColumns: rule === 'conditions' ? identityColumns : undefined,
      caseTitle: caseTitle.trim(),
      caseObjective: caseObjective.trim(),
      caseNextAction: caseNextAction.trim(),
    };
  }

  function applyDefinition(definition: ActivationDefinition) {
    cancelAction();
    setKind(definition.kind);
    setActivationName(definition.name);
    if (definition.kind === 'invoice_duplicates') {
      setMapping(definition.mapping);
      setCaseTitle(definition.caseTitle ?? 'Revisar posible factura duplicada');
      setCaseObjective(
        definition.caseObjective ?? 'Confirmar si los registros corresponden a la misma factura.',
      );
      setCaseNextAction(
        definition.caseNextAction ?? 'Revisar la evidencia y resolver la coincidencia.',
      );
    } else {
      setRule(definition.rule);
      setConditions(
        definition.conditions.length
          ? definition.conditions.map((condition, index) => ({
              ...condition,
              uiId: `condition-${index + 1}-${Date.now()}`,
            }))
          : [{ column: -1, operator: 'equals', value: '', uiId: `condition-1-${Date.now()}` }],
      );
      setMatch(definition.match);
      setGroupBy(definition.groupBy);
      setEvidenceColumns(definition.evidenceColumns ?? []);
      setIdentityColumns(definition.identityColumns ?? []);
      setCaseTitle(definition.caseTitle);
      setCaseObjective(definition.caseObjective);
      setCaseNextAction(definition.caseNextAction);
    }
    setRun(null);
    setResult(null);
    setShareConfirmed(false);
  }

  function applyDraft(draft: NonNullable<PlanResponse['draft']>) {
    const nextSource = data?.sources.find((item) => item.id === draft.sourceId);
    const nextView = draft.viewId
      ? nextSource?.preparedViews.find((item) => item.id === draft.viewId)
      : null;
    const nextSheet =
      nextView ?? nextSource?.sheets.find((item) => item.index === draft.sheetIndex);
    if (!nextSource || !nextSheet) {
      setError(
        'La propuesta usa una fuente o pestaña que ya no está disponible en este workspace.',
      );
      return;
    }
    setSourceId(nextSource.id);
    setSheetIndex(nextView ? 0 : draft.sheetIndex);
    setViewId(nextView?.id ?? null);
    applyDefinition(draft.definition);
    if (draft.trigger && draft.trigger.kind !== 'manual') {
      setAutomationDefaults({
        trigger: draft.trigger.kind === 'on_source_change' ? 'on_change' : 'scheduled',
        intervalMinutes: draft.trigger.intervalMinutes ?? 360,
      });
    }
    setAdvancedOpen(true);
  }

  async function designActivation() {
    if (!prompt.trim() || planning) return;
    planController.current?.abort();
    const id = ++planId.current;
    const controller = new AbortController();
    planController.current = controller;
    setPlanning(true);
    setPlan(null);
    setError(null);
    try {
      const response = await fetch(plannerHref, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ prompt: prompt.trim(), sourceId: sourceId || undefined }),
      });
      const body = (await response.json().catch(() => null)) as PlanResponse | null;
      if (!response.ok || !body)
        throw new Error(message(body, 'No pudimos diseñar la activación.'));
      if (id !== planId.current || controller.signal.aborted) return;
      setPlan(body);
    } catch (cause) {
      if (!controller.signal.aborted && id === planId.current)
        setError(cause instanceof Error ? cause.message : 'No pudimos diseñar la activación.');
    } finally {
      if (id === planId.current) {
        planController.current = null;
        setPlanning(false);
      }
    }
  }

  async function simulate() {
    const definition = currentDefinition();
    if (!source || !sheet || !definition) return;
    cancelAction();
    const id = ++actionId.current;
    const controller = new AbortController();
    actionController.current = controller;
    setPending('simulate');
    setError(null);
    setRun(null);
    setResult(null);
    setShareConfirmed(false);
    try {
      const response = await fetch(apiHref, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          action: 'simulate',
          sourceId: source.id,
          sheetIndex: sheet.index,
          ...(viewId ? { viewId } : {}),
          definition,
        }),
      });
      const body = (await response.json().catch(() => null)) as SimulateActivationResponse | null;
      if (!response.ok || !body) throw new Error(message(body, 'No pudimos simular esta hoja.'));
      if (id !== actionId.current || controller.signal.aborted) return;
      setRun(body.run);
    } catch (cause) {
      if (!controller.signal.aborted && id === actionId.current) {
        setError(cause instanceof Error ? cause.message : 'No pudimos simular esta hoja.');
      }
    } finally {
      if (id === actionId.current) {
        actionController.current = null;
        setPending(null);
      }
    }
  }

  async function commit() {
    if (!run || !shareConfirmed || matchedGroups === 0) return;
    cancelAction();
    const id = ++actionId.current;
    const controller = new AbortController();
    actionController.current = controller;
    setPending('commit');
    setError(null);
    try {
      const response = await fetch(apiHref, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ action: 'commit', runId: run.id, shareConfirmed: true }),
      });
      const body = (await response.json().catch(() => null)) as CommitActivationResponse | null;
      if (!response.ok || !body) throw new Error(message(body, 'No pudimos crear los asuntos.'));
      if (id !== actionId.current || controller.signal.aborted) return;
      setRun(body.run);
      setResult(body);
      setData(
        (current) =>
          current && {
            ...current,
            runs: [body.run, ...current.runs.filter((item) => item.id !== body.run.id)],
          },
      );
    } catch (cause) {
      if (!controller.signal.aborted && id === actionId.current) {
        setError(cause instanceof Error ? cause.message : 'No pudimos crear los asuntos.');
      }
    } finally {
      if (id === actionId.current) {
        actionController.current = null;
        setPending(null);
      }
    }
  }

  const step = result ? 4 : run ? 3 : sheet ? 2 : 1;

  // biome-ignore lint/correctness/useExhaustiveDependencies: Restore a saved run once, without overwriting subsequent edits.
  useEffect(() => {
    if (!initialRunId || !data || restoredRunId.current === initialRunId) return;
    restoredRunId.current = initialRunId;
    const saved = data.runs.find((item) => item.id === initialRunId);
    if (!saved) {
      setError(
        'La simulación guardada ya no está disponible. Revisa la fuente antes de simular otra vez.',
      );
      return;
    }
    applyDefinition(saved.definition);
    setSourceId(saved.sourceId);
    setSheetIndex(saved.sheetIndex);
    setViewId(saved.viewId);
    setRun(saved);
    setResult(
      saved.status === 'committed' ? { run: saved, created: 0, reused: 0, restored: true } : null,
    );
    setAdvancedOpen(true);
  }, [data, initialRunId]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <span className="page-identity mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-border bg-surface text-primary">
            <SearchCheck className="h-5 w-5" aria-hidden />
          </span>
          <div>
            <h1 className="page-heading text-xl font-bold tracking-tight text-ink">Activaciones</h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-ink-muted">
              Describe qué revisar en tus fuentes de Feed y convierte las coincidencias en asuntos
              para {organizationName}. Simula primero y autoriza qué compartir o seguir revisando.
            </p>
          </div>
        </div>
        <SourcePicker
          fileHref={feedFileHref}
          urlHref={feedUrlHref}
          textHref={feedTextHref}
          apiHref={feedApiHref}
        />
      </header>

      <section className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
        <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="min-w-0">
            <label htmlFor="activation-prompt" className="text-base font-bold text-ink">
              ¿Qué quieres que Cortex encuentre?
            </label>
            <textarea
              id="activation-prompt"
              rows={4}
              value={prompt}
              onChange={(event) => {
                setPrompt(event.target.value);
                cancelPlan();
              }}
              placeholder="Ej.: Encuentra productos con inventario menor a 10 y crea un asunto para reponerlos."
              className="mt-3 w-full resize-y rounded-sm border border-border-strong bg-canvas px-4 py-3 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-faint focus-visible:ring-2 focus-visible:ring-primary/50"
            />
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-ink-muted">
              <button
                type="button"
                className="rounded-pill border border-border px-3 py-1.5 hover:bg-surface-2"
                onClick={() => {
                  cancelPlan();
                  setPrompt(
                    'Encuentra productos con inventario menor a 10 y crea un asunto para reponerlos.',
                  );
                }}
              >
                Inventario bajo
              </button>
              <button
                type="button"
                className="rounded-pill border border-border px-3 py-1.5 hover:bg-surface-2"
                onClick={() => {
                  cancelPlan();
                  setPrompt(
                    'Encuentra tareas con fecha vencida y crea un asunto para darles seguimiento.',
                  );
                }}
              >
                Tareas atrasadas
              </button>
              <button
                type="button"
                className="rounded-pill border border-border px-3 py-1.5 hover:bg-surface-2"
                onClick={() => {
                  cancelPlan();
                  setPrompt(
                    'Encuentra registros duplicados usando las columnas que identifican a cada registro.',
                  );
                }}
              >
                Registros duplicados
              </button>
            </div>
          </div>
          <div className="min-w-0 border-t border-border pt-4 lg:border-l lg:border-t-0 lg:pl-5 lg:pt-0">
            <label htmlFor="planner-source" className="text-xs font-semibold text-ink-muted">
              Fuente opcional
            </label>
            <select
              id="planner-source"
              className={`${select} mt-1.5`}
              value={sourceId}
              onChange={(event) => chooseSource(event.target.value)}
            >
              <option value="">Que Cortex proponga una</option>
              {data?.sources.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.filename}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={!prompt.trim() || planning || loading}
              onClick={() => void designActivation()}
              className={`${button} mt-3 w-full bg-primary text-white hover:bg-primary-hover`}
            >
              {planning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <SearchCheck className="h-4 w-4" />
              )}{' '}
              Diseñar activación
            </button>
            <p className="mt-3 text-xs leading-relaxed text-ink-faint">
              Diseñar no ejecuta la activación ni comparte filas. Primero podrás editar y simular la
              propuesta.
            </p>
          </div>
        </div>
        {plan ? (
          <div className="border-t border-border bg-surface-2 px-5 py-4 sm:px-6">
            <p className="text-sm font-semibold text-ink">{plan.explanation}</p>
            {plan.questions.length ? (
              <>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-muted">
                  {plan.questions.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
                <p className="mt-3 text-xs font-semibold text-primary">
                  Añade tus respuestas a la descripción y vuelve a diseñar la activación.
                </p>
              </>
            ) : null}
            {plan.limitations.length ? (
              <p className="mt-2 text-xs text-ink-faint">{plan.limitations.join(' ')}</p>
            ) : null}
            {plan.draft ? (
              <button
                type="button"
                className={`${button} mt-3 border border-border-strong bg-surface text-ink`}
                onClick={() => plan.draft && applyDraft(plan.draft)}
              >
                Usar propuesta y editar <ArrowRight className="h-4 w-4" />
              </button>
            ) : null}
          </div>
        ) : null}
      </section>

      <ol
        className="grid overflow-hidden rounded-card border border-border bg-surface sm:grid-cols-4"
        aria-label="Progreso de la activación"
      >
        {['Fuente', 'Columnas', 'Revisión', 'Resultado'].map((label, index) => {
          const number = index + 1;
          return (
            <li
              key={label}
              aria-current={step === number ? 'step' : undefined}
              className={`flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0 ${step === number ? 'bg-primary-soft' : ''}`}
            >
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${step > number ? 'bg-emerald text-white' : step === number ? 'bg-primary text-white' : 'bg-surface-2 text-ink-faint'}`}
              >
                {step > number ? <Check className="h-3.5 w-3.5" /> : number}
              </span>
              <span
                className={`text-sm font-semibold ${step === number ? 'text-ink' : 'text-ink-muted'}`}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      {error ? (
        <div
          role="alert"
          className="flex items-start justify-between gap-4 rounded-sm border border-rose/25 bg-rose-soft px-4 py-3 text-sm text-ink"
        >
          <span className="flex gap-2">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose" aria-hidden />
            {error}
          </span>
          <button
            type="button"
            className="font-semibold text-primary underline underline-offset-2"
            onClick={() => (data ? setError(null) : void load())}
          >
            Reintentar
          </button>
        </div>
      ) : null}

      {loading ? (
        <div className="grid min-h-[28rem] place-items-center rounded-card border border-border bg-surface">
          <output className="flex items-center gap-2 text-sm text-ink-muted">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Cargando hojas de tu Feed…
          </output>
        </div>
      ) : data && data.sources.length === 0 ? (
        <Empty feedHref={feedHref} />
      ) : data ? (
        <details
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
          className="group overflow-hidden rounded-card border border-border bg-surface shadow-card"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-bold text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
            Configuración manual avanzada
            <span className="flex items-center gap-2 text-xs font-normal text-ink-muted">
              Editable antes de simular{' '}
              <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
            </span>
          </summary>
          <div className="border-t border-border">
            <div className="grid min-w-0 xl:grid-cols-[22rem_minmax(0,1fr)]">
              <aside className="min-w-0 border-b border-border bg-surface-2/50 p-5 xl:border-b-0 xl:border-r">
                <h2 className="text-sm font-bold text-ink">Preparar lectura</h2>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  Usa tablas o prepara una lectura de tus documentos, enlaces y textos de Feed.
                </p>
                <label
                  htmlFor="activation-kind"
                  className="mt-5 block text-xs font-semibold text-ink-muted"
                >
                  Plantilla
                </label>
                <select
                  id="activation-kind"
                  className={`${select} mt-1.5`}
                  value={kind}
                  onChange={(event) => {
                    cancelAction();
                    const next = event.target.value as typeof kind;
                    setKind(next);
                    setActivationName(
                      next === 'invoice_duplicates'
                        ? 'Revisar facturas duplicadas'
                        : 'Mi activación',
                    );
                    setRun(null);
                    setResult(null);
                    setShareConfirmed(false);
                  }}
                >
                  <option value="invoice_duplicates">Facturas duplicadas</option>
                  <option value="table_rule">Personalizada</option>
                </select>
                <label
                  htmlFor="activation-source"
                  className="mt-5 block text-xs font-semibold text-ink-muted"
                >
                  Archivo
                </label>
                <div className="relative mt-1.5">
                  <select
                    id="activation-source"
                    className={`${select} appearance-none pr-9`}
                    value={sourceId}
                    onChange={(event) => chooseSource(event.target.value)}
                  >
                    <option value="">Elige una fuente</option>
                    {data.sources.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.filename}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-ink-faint"
                    aria-hidden
                  />
                </div>
                {source?.canPrepare ? (
                  <div className="mt-4 rounded-sm border border-border bg-surface p-3">
                    <label className="block text-xs font-semibold text-ink">
                      Preparar lectura con Cortex
                      <textarea
                        value={preparePrompt}
                        onChange={(event) => setPreparePrompt(event.target.value)}
                        rows={3}
                        placeholder="Describe qué filas y campos necesitas extraer…"
                        className={`${select} mt-2 py-2`}
                      />
                    </label>
                    <p className="mt-2 text-xs leading-relaxed text-ink-faint">
                      Cortex creará una vista tabular privada y derivada. La fuente original queda
                      intacta.
                    </p>
                    <button
                      type="button"
                      disabled={!preparePrompt.trim() || preparingSource}
                      onClick={() => void prepareSelectedSource()}
                      className={`${button} mt-3 w-full border border-border-strong bg-surface-2 text-ink`}
                    >
                      {preparingSource ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Table2 className="h-4 w-4" />
                      )}{' '}
                      Preparar lectura
                    </button>
                  </div>
                ) : null}
                {source ? (
                  <>
                    <label
                      htmlFor="activation-sheet"
                      className="mt-5 block text-xs font-semibold text-ink-muted"
                    >
                      Pestaña
                    </label>
                    <div className="relative mt-1.5">
                      <select
                        id="activation-sheet"
                        className={`${select} appearance-none pr-9`}
                        value={viewId ? `view:${viewId}` : (sheetIndex ?? '')}
                        onChange={(event) => {
                          if (event.target.value.startsWith('view:')) {
                            const id = event.target.value.slice(5);
                            const next = source?.preparedViews.find((item) => item.id === id);
                            setViewId(id);
                            setSheetIndex(0);
                            setMapping(next ? suggestMapping(next.headers) : null);
                            setRun(null);
                            setResult(null);
                          } else chooseSheet(Number(event.target.value));
                        }}
                      >
                        <option value="">Elige una pestaña</option>
                        {source.sheets.map((item) => (
                          <option key={item.index} value={item.index}>
                            {item.name} · {item.rowCount.toLocaleString('es-CO')} filas
                          </option>
                        ))}
                        {source.preparedViews.map((item) => (
                          <option key={item.id} value={`view:${item.id}`}>
                            Derivada · {item.name} · {item.rowCount.toLocaleString('es-CO')} filas
                          </option>
                        ))}
                      </select>
                      <ChevronDown
                        className="pointer-events-none absolute right-3 top-3 h-4 w-4 text-ink-faint"
                        aria-hidden
                      />
                    </div>
                  </>
                ) : null}
                {sheet && kind === 'invoice_duplicates' && mapping ? (
                  <div className="mt-6 border-t border-border pt-5">
                    <h3 className="text-sm font-bold text-ink">Correspondencia de columnas</h3>
                    <div className="mt-4 space-y-4">
                      {fields.map((field) => (
                        <label key={field.key} className="block">
                          <span className="flex justify-between gap-3 text-xs">
                            <span className="font-semibold text-ink">{field.label}</span>
                            <span className="text-ink-faint">{field.hint}</span>
                          </span>
                          <select
                            className={`${select} mt-1.5`}
                            value={mapping[field.key]}
                            onChange={(event) => {
                              cancelAction();
                              setMapping({ ...mapping, [field.key]: Number(event.target.value) });
                              setRun(null);
                              setResult(null);
                            }}
                          >
                            <option value={-1}>Seleccionar columna</option>
                            {sheet.headers.map((header, index) => (
                              <option key={`${index}:${header}`} value={index}>
                                {header || `Columna ${index + 1}`}
                              </option>
                            ))}
                          </select>
                        </label>
                      ))}
                    </div>
                    {mapping && !mappingComplete ? (
                      <p className="mt-3 text-xs leading-relaxed text-amber">
                        Asigna cinco columnas distintas para continuar.
                      </p>
                    ) : null}
                    <button
                      type="button"
                      disabled={!currentDefinition() || pending !== null}
                      onClick={() => void simulate()}
                      className={`${button} mt-5 w-full bg-primary text-white hover:bg-primary-hover`}
                    >
                      {pending === 'simulate' ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <SearchCheck className="h-4 w-4" />
                      )}{' '}
                      Simular revisión
                    </button>
                  </div>
                ) : sheet && kind === 'table_rule' ? (
                  <CustomBuilder
                    headers={sheet.headers}
                    rule={rule}
                    setRule={setRule}
                    activationName={activationName}
                    setActivationName={setActivationName}
                    groupBy={groupBy}
                    setGroupBy={setGroupBy}
                    evidenceColumns={evidenceColumns}
                    setEvidenceColumns={setEvidenceColumns}
                    identityColumns={identityColumns}
                    setIdentityColumns={setIdentityColumns}
                    conditions={conditions}
                    setConditions={setConditions}
                    match={match}
                    setMatch={setMatch}
                    caseTitle={caseTitle}
                    setCaseTitle={setCaseTitle}
                    caseObjective={caseObjective}
                    setCaseObjective={setCaseObjective}
                    caseNextAction={caseNextAction}
                    setCaseNextAction={setCaseNextAction}
                    invalidate={() => {
                      cancelAction();
                      setRun(null);
                      setResult(null);
                      setShareConfirmed(false);
                    }}
                    canSimulate={Boolean(currentDefinition())}
                    pending={pending}
                    simulate={simulate}
                  />
                ) : null}
              </aside>

              <main className="min-w-0 p-5 sm:p-6">
                {!sheet ? (
                  <Guide />
                ) : !run ? (
                  <Awaiting sheetName={sheet.name} />
                ) : result ? (
                  <ResultView
                    result={result}
                    organizationName={organizationName}
                    managementHref={managementHref}
                  />
                ) : (
                  <Review
                    run={run}
                    matchedGroups={matchedGroups}
                    matchedRows={matchedRows.length}
                    unmatchedCount={candidateGroups.unmatched.length}
                    invalidCount={candidateGroups.invalid.length}
                    shareConfirmed={shareConfirmed}
                    setShareConfirmed={setShareConfirmed}
                    pending={pending}
                    commit={commit}
                  />
                )}
                {run?.status === 'committed' && run.caseIds.length ? (
                  <RunExecution key={run.id} run={run} workspaceId={workspaceId} />
                ) : null}
                {run && matchedGroups > 0 ? (
                  <AutomationPanel
                    apiHref={workspaceHref(workspaceId, '/api/activations/automations')}
                    runId={run.id}
                    canAutomate={
                      run.definition.kind !== 'table_rule' ||
                      run.definition.rule !== 'conditions' ||
                      Boolean(run.definition.identityColumns?.length)
                    }
                    initialTrigger={automationDefaults.trigger}
                    initialInterval={automationDefaults.intervalMinutes}
                  />
                ) : null}
              </main>
            </div>
            <HistoryList
              runs={data.runs}
              onReuse={(historyRun) =>
                applyDraft({
                  sourceId: historyRun.sourceId,
                  sheetIndex: historyRun.sheetIndex,
                  definition: historyRun.definition,
                  trigger: { kind: 'manual' },
                })
              }
            />
          </div>
        </details>
      ) : null}
    </div>
  );
}

function RunExecution({ run, workspaceId }: { run: ActivationRun; workspaceId: string }) {
  const [caseId, setCaseId] = useState(run.caseIds[0] ?? '');
  const [caseNames, setCaseNames] = useState<Record<string, string>>({});
  useEffect(() => {
    const controller = new AbortController();
    const url = workspaceHref(
      workspaceId,
      `/api/activations/operations?runId=${encodeURIComponent(run.id)}`,
    );
    void fetch(url, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json();
        if (!controller.signal.aborted)
          setCaseNames(
            Object.fromEntries(
              (body.cases ?? []).map((item: { id: string; title: string }) => [
                item.id,
                item.title,
              ]),
            ),
          );
      })
      .catch(() => {});
    return () => controller.abort();
  }, [run.id, workspaceId]);

  return (
    <section className="mt-6 border-t border-border pt-5">
      <label htmlFor="operation-case" className="text-sm font-semibold text-ink">
        Continuar con una acción
      </label>
      <p className="mb-3 mt-1 text-xs text-ink-muted">
        Elige un asunto. Revisa la acción y cómo se comprobará antes de aprobarla.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <select
          id="operation-case"
          className={`${select} flex-1`}
          value={caseId}
          onChange={(event) => setCaseId(event.target.value)}
        >
          {run.caseIds.map((id, index) => (
            <option value={id} key={id}>
              {caseNames[id] ?? `Asunto ${index + 1} · ${id.slice(0, 8)}`}
            </option>
          ))}
        </select>
        <Link
          className="text-xs font-semibold text-primary"
          href={workspaceHref(workspaceId, `/management?case=${encodeURIComponent(caseId)}`)}
        >
          Ver asunto y evidencia
        </Link>
      </div>
      <ActivationExecution
        key={caseId}
        workspaceId={workspaceId}
        caseId={caseId}
        runId={run.id}
        className="mt-4"
      />
    </section>
  );
}

function SourcePicker({
  fileHref,
  urlHref,
  textHref,
  apiHref,
}: {
  fileHref: string;
  urlHref: string;
  textHref: string;
  apiHref: string;
}) {
  const options = [
    {
      href: fileHref,
      icon: Upload,
      title: 'Archivo',
      detail: 'PDF, Word, Excel, CSV o texto, hasta 10 MB.',
    },
    {
      href: urlHref,
      icon: Link2,
      title: 'Enlace o Google Sheets',
      detail:
        'Páginas públicas; Sheets requiere la conexión de Google de esta empresa y permiso sobre la hoja.',
    },
    {
      href: textHref,
      icon: Type,
      title: 'Texto',
      detail: 'Pega notas o datos directamente en Feed.',
    },
  ];
  return (
    <details className="group relative z-20">
      <summary
        className={`${button} cursor-pointer list-none border border-border-strong bg-surface text-ink hover:bg-surface-2`}
      >
        <FileSpreadsheet className="h-4 w-4" aria-hidden /> Agregar fuente{' '}
        <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="absolute left-0 top-full mt-2 w-[min(23rem,calc(100vw-2rem))] overflow-hidden rounded-card border border-border bg-surface shadow-card sm:left-auto sm:right-0">
        <div className="p-2">
          {options.map(({ href, icon: Icon, title, detail }) => (
            <Link
              key={title}
              href={href}
              className="flex items-start gap-3 rounded-sm px-3 py-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-surface-2"
            >
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                <Icon className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{title}</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  {detail}
                </span>
              </span>
            </Link>
          ))}
        </div>
        <div className="border-t border-border bg-surface-2 p-3">
          <div className="flex items-start gap-3">
            <Plug className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-semibold text-ink">API o integración</p>
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                Conecta un servicio o prepara una herramienta con su documentación. Conectarlo no
                ejecuta activaciones automáticamente.
              </p>
              <Link
                href={apiHref}
                className="mt-2 inline-block text-xs font-semibold text-primary hover:underline"
              >
                Configurar en Feed
              </Link>
            </div>
          </div>
        </div>
        <p className="border-t border-border px-4 py-3 text-xs leading-relaxed text-ink-faint">
          Las fuentes de Feed son privadas, duran 7 días y no se guardan automáticamente en Brain.
          Las activaciones actuales necesitan una tabla para simular.
        </p>
      </div>
    </details>
  );
}

function CustomBuilder({
  headers,
  rule,
  setRule,
  activationName,
  setActivationName,
  groupBy,
  setGroupBy,
  evidenceColumns,
  setEvidenceColumns,
  identityColumns,
  setIdentityColumns,
  conditions,
  setConditions,
  match,
  setMatch,
  caseTitle,
  setCaseTitle,
  caseObjective,
  setCaseObjective,
  caseNextAction,
  setCaseNextAction,
  invalidate,
  canSimulate,
  pending,
  simulate,
}: {
  headers: string[];
  rule: 'duplicates' | 'conditions';
  setRule: (value: 'duplicates' | 'conditions') => void;
  activationName: string;
  setActivationName: (value: string) => void;
  groupBy: number[];
  setGroupBy: (value: number[]) => void;
  evidenceColumns: number[];
  setEvidenceColumns: (value: number[]) => void;
  identityColumns: number[];
  setIdentityColumns: (value: number[]) => void;
  conditions: Condition[];
  setConditions: (value: Condition[]) => void;
  match: 'all' | 'any';
  setMatch: (value: 'all' | 'any') => void;
  caseTitle: string;
  setCaseTitle: (value: string) => void;
  caseObjective: string;
  setCaseObjective: (value: string) => void;
  caseNextAction: string;
  setCaseNextAction: (value: string) => void;
  invalidate: () => void;
  canSimulate: boolean;
  pending: 'simulate' | 'commit' | null;
  simulate: () => Promise<void>;
}) {
  const change = (fn: () => void) => {
    invalidate();
    fn();
  };
  const operators: Array<[ActivationConditionOperator, string]> = [
    ['equals', 'Es igual a'],
    ['not_equals', 'No es igual a'],
    ['contains', 'Contiene'],
    ['is_empty', 'Está vacía'],
    ['gt', 'Mayor que'],
    ['gte', 'Mayor o igual'],
    ['lt', 'Menor que'],
    ['lte', 'Menor o igual'],
    ['before_today', 'Anterior a hoy'],
    ['after_today', 'Posterior a hoy'],
  ];
  return (
    <div className="mt-6 min-w-0 border-t border-border pt-5">
      <h3 className="text-sm font-bold text-ink">Configuración personalizada</h3>
      <label className="mt-4 block text-xs font-semibold text-ink-muted">
        Nombre
        <input
          value={activationName}
          onChange={(e) => change(() => setActivationName(e.target.value))}
          className={`${select} mt-1.5`}
        />
      </label>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => change(() => setRule('duplicates'))}
          className={`${button} border ${rule === 'duplicates' ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-ink'}`}
        >
          Duplicados
        </button>
        <button
          type="button"
          onClick={() => change(() => setRule('conditions'))}
          className={`${button} border ${rule === 'conditions' ? 'border-primary bg-primary-soft text-primary' : 'border-border bg-surface text-ink'}`}
        >
          Condiciones
        </button>
      </div>
      {rule === 'duplicates' ? (
        <fieldset className="mt-4">
          <legend className="text-xs font-semibold text-ink-muted">
            Columnas que deben coincidir
          </legend>
          <div className="mt-2 max-h-44 space-y-2 overflow-y-auto rounded-sm border border-border bg-surface p-3">
            {headers.map((header, index) => (
              <label
                key={`${index}:${header}`}
                className="flex items-center gap-2 text-sm text-ink"
              >
                <input
                  type="checkbox"
                  checked={groupBy.includes(index)}
                  onChange={(e) =>
                    change(() =>
                      setGroupBy(
                        e.target.checked
                          ? [...groupBy, index]
                          : groupBy.filter((item) => item !== index),
                      ),
                    )
                  }
                  className="h-4 w-4 accent-primary"
                />
                {header || `Columna ${index + 1}`}
              </label>
            ))}
          </div>
        </fieldset>
      ) : (
        <div className="mt-4 space-y-3">
          <label className="block text-xs font-semibold text-ink-muted">
            Coincidir cuando
            <select
              value={match}
              onChange={(e) => change(() => setMatch(e.target.value as 'all' | 'any'))}
              className={`${select} mt-1.5`}
            >
              <option value="all">Se cumplan todas</option>
              <option value="any">Se cumpla cualquiera</option>
            </select>
          </label>
          {conditions.map((condition, index) => (
            <div
              key={condition.uiId}
              className="space-y-2 rounded-sm border border-border bg-surface p-3"
            >
              <select
                aria-label={`Columna condición ${index + 1}`}
                value={condition.column}
                onChange={(e) =>
                  change(() =>
                    setConditions(
                      conditions.map((item, i) =>
                        i === index ? { ...item, column: Number(e.target.value) } : item,
                      ),
                    ),
                  )
                }
                className={select}
              >
                <option value={-1}>Columna</option>
                {headers.map((header, i) => (
                  <option key={`${i}:${header}`} value={i}>
                    {header || `Columna ${i + 1}`}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Operador condición ${index + 1}`}
                value={condition.operator}
                onChange={(e) =>
                  change(() =>
                    setConditions(
                      conditions.map((item, i) =>
                        i === index
                          ? { ...item, operator: e.target.value as ActivationConditionOperator }
                          : item,
                      ),
                    ),
                  )
                }
                className={select}
              >
                {operators.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              {!noValueOperators.has(condition.operator) ? (
                <input
                  aria-label={`Valor condición ${index + 1}`}
                  value={condition.value ?? ''}
                  onChange={(e) =>
                    change(() =>
                      setConditions(
                        conditions.map((item, i) =>
                          i === index ? { ...item, value: e.target.value } : item,
                        ),
                      ),
                    )
                  }
                  placeholder="Valor"
                  className={select}
                />
              ) : null}
              <button
                type="button"
                disabled={conditions.length === 1}
                onClick={() =>
                  change(() => setConditions(conditions.filter((_, i) => i !== index)))
                }
                className="text-xs font-semibold text-rose disabled:opacity-40"
              >
                Eliminar condición
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={() =>
              change(() =>
                setConditions([
                  ...conditions,
                  {
                    column: -1,
                    operator: 'equals',
                    value: '',
                    uiId: `condition-${Date.now()}`,
                  },
                ]),
              )
            }
            className="text-xs font-semibold text-primary"
          >
            + Agregar condición
          </button>
        </div>
      )}
      <fieldset className="mt-4">
        <legend className="text-xs font-semibold text-ink-muted">Columnas de evidencia</legend>
        <p className="mt-1 text-xs leading-relaxed text-ink-faint">
          Solo estas columnas y las usadas por la regla aparecerán en la revisión.
        </p>
        <div className="mt-2 max-h-36 space-y-2 overflow-y-auto rounded-sm border border-border bg-surface p-3">
          {headers.map((header, index) => (
            <label
              key={`evidence:${index}:${header}`}
              className="flex items-center gap-2 text-sm text-ink"
            >
              <input
                type="checkbox"
                checked={evidenceColumns.includes(index)}
                onChange={(event) =>
                  change(() =>
                    setEvidenceColumns(
                      event.target.checked
                        ? [...evidenceColumns, index]
                        : evidenceColumns.filter((item) => item !== index),
                    ),
                  )
                }
                className="h-4 w-4 accent-primary"
              />
              {header || `Columna ${index + 1}`}
            </label>
          ))}
        </div>
      </fieldset>
      {rule === 'conditions' ? (
        <fieldset className="mt-4">
          <legend className="text-xs font-semibold text-ink-muted">
            Clave estable para seguimiento
          </legend>
          <p className="mt-1 text-xs leading-relaxed text-ink-faint">
            Elige columnas que identifican el mismo registro entre versiones. Solo se exige si luego
            activas seguimiento y evita asuntos repetidos.
          </p>
          <div className="mt-2 max-h-32 space-y-2 overflow-y-auto rounded-sm border border-border bg-surface p-3">
            {headers.map((header, index) => (
              <label
                key={`identity:${index}:${header}`}
                className="flex items-center gap-2 text-sm text-ink"
              >
                <input
                  type="checkbox"
                  checked={identityColumns.includes(index)}
                  onChange={(event) =>
                    change(() =>
                      setIdentityColumns(
                        event.target.checked
                          ? [...identityColumns, index]
                          : identityColumns.filter((item) => item !== index),
                      ),
                    )
                  }
                  className="h-4 w-4 accent-primary"
                />
                {header || `Columna ${index + 1}`}
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div className="mt-5 space-y-3 border-t border-border pt-4">
        <p className="text-xs font-semibold text-ink-muted">Asunto que se creará</p>
        <label className="block text-xs text-ink-muted">
          Nombre
          <input
            value={caseTitle}
            onChange={(e) => change(() => setCaseTitle(e.target.value))}
            className={`${select} mt-1`}
          />
        </label>
        <label className="block text-xs text-ink-muted">
          Objetivo
          <textarea
            rows={2}
            value={caseObjective}
            onChange={(e) => change(() => setCaseObjective(e.target.value))}
            className={`${select} mt-1 py-2`}
          />
        </label>
        <label className="block text-xs text-ink-muted">
          Siguiente paso
          <textarea
            rows={2}
            value={caseNextAction}
            onChange={(e) => change(() => setCaseNextAction(e.target.value))}
            className={`${select} mt-1 py-2`}
          />
        </label>
      </div>
      {!canSimulate ? (
        <p className="mt-3 text-xs text-amber">Completa la regla y los datos del asunto.</p>
      ) : null}
      <button
        type="button"
        disabled={!canSimulate || pending !== null}
        onClick={() => void simulate()}
        className={`${button} mt-5 w-full bg-primary text-white hover:bg-primary-hover`}
      >
        {pending === 'simulate' ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <SearchCheck className="h-4 w-4" />
        )}{' '}
        Simular revisión
      </button>
    </div>
  );
}

function Empty({ feedHref }: { feedHref: string }) {
  return (
    <div className="grid min-h-[28rem] place-items-center rounded-card border border-dashed border-border-strong bg-surface p-8 text-center">
      <div>
        <FileSpreadsheet className="mx-auto h-7 w-7 text-primary" aria-hidden />
        <h2 className="mt-3 text-base font-bold text-ink">Añade una tabla a tu Feed</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-ink-muted">
          Activaciones puede leer archivos CSV, XLSX y hojas de Google guardadas en tu Feed
          personal.
        </p>
        <Link href={feedHref} className={`${button} mt-5 bg-primary text-white`}>
          Ir a Feed <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}

function Guide() {
  return (
    <div className="grid min-h-[27rem] place-items-center">
      <div className="max-w-md">
        <Table2 className="h-8 w-8 text-primary" aria-hidden />
        <h2 className="mt-4 text-lg font-bold text-ink">Empieza por la fuente</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          Elige un archivo y una pestaña. Antes de crear asuntos verás cada candidato, sus datos de
          origen y las filas que Cortex excluyó.
        </p>
        <div className="mt-6 flex items-start gap-3 border-l-2 border-amber pl-4">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-amber" />
          <p className="text-xs leading-relaxed text-ink-muted">
            Nada se comparte con la empresa hasta que revises la simulación y lo confirmes
            explícitamente.
          </p>
        </div>
      </div>
    </div>
  );
}
function Awaiting({ sheetName }: { sheetName: string }) {
  return (
    <div className="grid min-h-[27rem] place-items-center text-center">
      <div>
        <SearchCheck className="mx-auto h-7 w-7 text-primary" />
        <h2 className="mt-3 text-base font-bold text-ink">Lista para simular “{sheetName}”</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink-muted">
          Comprueba la correspondencia de columnas. La simulación no crea asuntos ni modifica tu
          archivo.
        </p>
      </div>
    </div>
  );
}

function Review({
  run,
  matchedGroups,
  matchedRows,
  unmatchedCount,
  invalidCount,
  shareConfirmed,
  setShareConfirmed,
  pending,
  commit,
}: {
  run: ActivationRun;
  matchedGroups: number;
  matchedRows: number;
  unmatchedCount: number;
  invalidCount: number;
  shareConfirmed: boolean;
  setShareConfirmed: (value: boolean) => void;
  pending: 'simulate' | 'commit' | null;
  commit: () => Promise<void>;
}) {
  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink">Revisión de candidatos</h2>
          <p className="mt-1 text-sm text-ink-muted">
            {run.sourceName} · {run.sheetName}
          </p>
        </div>
        <div className="flex gap-4 text-sm">
          <span>
            <strong className="stat-num text-ink">{matchedGroups}</strong>{' '}
            <span className="text-ink-muted">
              {matchedGroups === 1 ? 'asunto propuesto' : 'asuntos propuestos'}
            </span>
          </span>
          <span>
            <strong className="stat-num text-ink">{matchedRows}</strong>{' '}
            <span className="text-ink-muted">filas involucradas</span>
          </span>
        </div>
      </div>
      <CandidateTable run={run} />
      {matchedGroups === 0 ? (
        <div className="mt-5 rounded-sm border border-border bg-surface-2 p-4">
          <p className="text-sm font-semibold text-ink">
            No encontramos coincidencias para revisar
          </p>
          <p className="mt-1 text-xs leading-relaxed text-ink-muted">
            {unmatchedCount} {unmatchedCount === 1 ? 'fila quedó' : 'filas quedaron'} sin
            coincidencias y {invalidCount}{' '}
            {invalidCount === 1 ? 'fila fue excluida' : 'filas fueron excluidas'}. No hay asuntos
            por crear.
          </p>
        </div>
      ) : (
        <>
          <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-sm border border-border-strong bg-surface-2 p-4">
            <input
              type="checkbox"
              checked={shareConfirmed}
              onChange={(event) => setShareConfirmed(event.target.checked)}
              className="mt-0.5 h-4 w-4 accent-primary"
            />
            <span>
              <span className="block text-sm font-semibold text-ink">
                Confirmo compartir estos datos relevantes con la empresa
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                Cortex compartirá únicamente la evidencia mostrada en los grupos coincidentes y
                creará un asunto por grupo. Las demás filas no se compartirán.
              </span>
            </span>
          </label>
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              disabled={!shareConfirmed || pending !== null}
              onClick={() => void commit()}
              className={`${button} bg-primary text-white hover:bg-primary-hover`}
            >
              {pending === 'commit' ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Check className="h-4 w-4" />
              )}{' '}
              Crear {matchedGroups} {matchedGroups === 1 ? 'asunto' : 'asuntos'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function CandidateTable({ run }: { run: ActivationRun }) {
  const { matchedGroups: grouped, unmatched, invalid } = groupCandidates(run.candidates);

  return (
    <div className="mt-5 overflow-x-auto rounded-sm border border-border">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="bg-surface-2 text-xs text-ink-muted">
          <tr>
            <th className="px-3 py-2.5 font-semibold">Fila</th>
            <th className="px-3 py-2.5 font-semibold">Evidencia mostrada</th>
            <th className="px-3 py-2.5 font-semibold">Decisión</th>
          </tr>
        </thead>
        {[...grouped.entries()].map(([groupKey, rows], index) => (
          <tbody
            key={groupKey}
            className="divide-y divide-border border-t border-amber/25 first:border-t-0"
          >
            <tr className="bg-amber-soft/60">
              <th colSpan={3} className="px-3 py-2 text-xs font-semibold text-ink">
                Asunto propuesto {index + 1} · {rows.length}{' '}
                {rows.length === 1 ? 'fila coincide' : 'filas coinciden'}
              </th>
            </tr>
            {rows.map((item) => (
              <CandidateRow
                key={`${item.rowIndex}:${item.sourceKey}`}
                item={item}
                decision="Coincide"
              />
            ))}
          </tbody>
        ))}
        {unmatched.length ? (
          <tbody className="divide-y divide-border border-t border-border">
            <tr className="bg-surface-2">
              <th colSpan={3} className="px-3 py-2 text-xs font-semibold text-ink-muted">
                Sin coincidencias · no crean asuntos
              </th>
            </tr>
            {unmatched.map((item) => (
              <CandidateRow
                key={`${item.rowIndex}:${item.sourceKey}`}
                item={item}
                decision="Sin coincidencia"
              />
            ))}
          </tbody>
        ) : null}
        {invalid.length ? (
          <tbody className="divide-y divide-border border-t border-border">
            <tr className="bg-surface-2">
              <th colSpan={3} className="px-3 py-2 text-xs font-semibold text-ink-muted">
                Filas excluidas
              </th>
            </tr>
            {invalid.map((item) => (
              <CandidateRow
                key={`${item.rowIndex}:${item.sourceKey}`}
                item={item}
                decision="Excluida"
              />
            ))}
          </tbody>
        ) : null}
      </table>
    </div>
  );
}

function CandidateRow({ item, decision }: { item: ActivationCandidate; decision: string }) {
  return (
    <tr>
      <td className="px-3 py-3 text-xs text-ink-faint">{item.rowIndex + 1}</td>
      <td className="px-3 py-3">
        <span className="font-semibold text-ink">Fila {item.rowIndex + 1}</span>
        <span className="mt-1 block max-w-[18rem] text-xs text-ink-faint">
          {item.values.map((value) => `${value.header}: ${value.value || 'vacío'}`).join(' · ')}
        </span>
      </td>
      <td className="px-3 py-3">
        <span
          className={`inline-flex rounded-pill px-2 py-1 text-xs font-semibold ${item.status === 'matched' ? 'bg-amber-soft text-amber' : 'bg-surface-2 text-ink-muted'}`}
        >
          {decision}
        </span>
        {item.reasons.length ? (
          <span className="mt-1 block max-w-[14rem] text-xs leading-snug text-ink-muted">
            {item.reasons.join(' · ')}
          </span>
        ) : null}
      </td>
    </tr>
  );
}

type AutomationView = {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'needs_review';
  trigger: 'on_change' | 'scheduled';
  intervalMinutes: number;
  lastCheckedAt: string | null;
  lastResult: string | null;
  nextRunAt: string | null;
  sourceConnectionId: string | null;
};
function AutomationPanel({
  apiHref,
  runId,
  canAutomate,
  initialTrigger,
  initialInterval,
}: {
  apiHref: string;
  runId: string;
  canAutomate: boolean;
  initialTrigger: 'on_change' | 'scheduled';
  initialInterval: number;
}) {
  const [items, setItems] = useState<AutomationView[]>([]);
  const [trigger, setTrigger] = useState<'on_change' | 'scheduled'>(initialTrigger);
  const [intervalMinutes, setInterval] = useState(initialInterval);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const response = await fetch(apiHref, { cache: 'no-store' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    setItems(body.automations ?? []);
  }, [apiHref]);
  useEffect(() => {
    void refresh().catch((error) => setPanelError(error.message));
  }, [refresh]);
  async function act(body: unknown) {
    setBusy(true);
    setPanelError(null);
    try {
      const response = await fetch(apiHref, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      await refresh();
      setConfirmed(false);
    } catch (error) {
      setPanelError(
        error instanceof Error ? error.message : 'No se pudo actualizar el seguimiento.',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="mt-6 rounded-sm border border-border bg-surface-2 p-4">
      <h3 className="text-sm font-bold text-ink">Seguimiento automático</h3>
      <p className="mt-1 text-xs leading-relaxed text-ink-muted">
        Repite esta revisión sobre nuevas versiones de la fuente. Si una fuente preparada cambia y
        requiere interpretación, se pausará para revisión.
      </p>
      {!canAutomate ? (
        <p className="mt-2 text-xs font-semibold text-amber">
          Vuelve a configurar y simular esta regla con una clave estable para activar seguimiento.
        </p>
      ) : null}
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-ink-muted">
          Cuándo
          <select
            value={trigger}
            onChange={(event) => setTrigger(event.target.value as typeof trigger)}
            className={`${select} mt-1`}
          >
            <option value="on_change">Cuando cambie la fuente</option>
            <option value="scheduled">En un horario</option>
          </select>
        </label>
        <label className="text-xs font-semibold text-ink-muted">
          Frecuencia
          <select
            value={intervalMinutes}
            onChange={(event) => setInterval(Number(event.target.value))}
            className={`${select} mt-1`}
          >
            <option value={60}>Cada hora</option>
            <option value={360}>Cada 6 horas</option>
            <option value={1440}>Cada día</option>
            <option value={10080}>Cada semana</option>
          </select>
        </label>
      </div>
      <label className="mt-3 flex items-start gap-2 text-xs leading-relaxed text-ink">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
          className="mt-0.5 accent-primary"
        />
        Autorizo compartir en el futuro únicamente la evidencia coincidente para crear asuntos, con
        esta regla y frecuencia.
      </label>
      <button
        type="button"
        disabled={!canAutomate || !confirmed || busy}
        onClick={() =>
          void act({ action: 'create', runId, trigger, intervalMinutes, shareConfirmed: true })
        }
        className={`${button} mt-3 bg-primary text-white`}
      >
        Activar seguimiento
      </button>
      {panelError ? (
        <p role="alert" className="mt-2 text-xs text-rose">
          {panelError}
        </p>
      ) : null}
      {items.length ? (
        <ul className="mt-4 divide-y divide-border border-t border-border">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-3 py-3 text-xs">
              <span className="font-semibold text-ink">{item.name}</span>
              <span className="text-ink-muted">
                {item.status === 'active'
                  ? 'Activo'
                  : item.status === 'paused'
                    ? 'Pausado'
                    : 'Requiere revisión'}
              </span>
              <span className="min-w-0 flex-1 text-ink-faint">
                {item.lastResult ?? 'Sin ejecuciones todavía'}
              </span>
              {item.status === 'needs_review' ? (
                <span className="font-semibold text-amber">Vuelve a simular y autorizar</span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void act({ action: item.status === 'paused' ? 'resume' : 'pause', id: item.id })
                  }
                  className="font-semibold text-primary"
                >
                  {item.status === 'paused' ? 'Reanudar' : 'Pausar'}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ResultView({
  result,
  organizationName,
  managementHref,
}: {
  result: Result;
  organizationName: string;
  managementHref: string;
}) {
  return (
    <div className="grid min-h-[27rem] place-items-center">
      <div className="max-w-lg text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-emerald-soft text-emerald">
          <Check className="h-6 w-6" />
        </span>
        <h2 className="mt-4 text-xl font-bold text-ink">Revisión aplicada en {organizationName}</h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-muted">
          {result.restored ? (
            'Resultado guardado. Puedes consultar sus asuntos y continuar el seguimiento.'
          ) : (
            <>
              Se crearon {result.created} {result.created === 1 ? 'asunto nuevo' : 'asuntos nuevos'}{' '}
              y se reutilizaron {result.reused} ya existentes. El resultado evita duplicar asuntos
              al reintentar.
            </>
          )}
        </p>
        <p className="mt-4 text-xs text-ink-faint">
          {result.run.caseIds.length} asuntos vinculados ·{' '}
          {formatDate(result.run.committedAt ?? result.run.createdAt)}
        </p>
        <Link
          href={managementHref}
          className={`${button} mt-5 border border-border-strong bg-surface text-ink hover:bg-surface-2`}
        >
          Ver asuntos en Gerencia <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}

function HistoryList({
  runs,
  onReuse,
}: {
  runs: ActivationRun[];
  onReuse: (run: ActivationRun) => void;
}) {
  const committed = useMemo(() => runs.filter((run) => run.status === 'committed'), [runs]);
  return (
    <section className="border-t border-border">
      <details className="group">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary">
          <span className="flex items-center gap-2 text-sm font-bold text-ink">
            <History className="h-4 w-4 text-ink-faint" /> Historial
          </span>
          <span className="flex items-center gap-2 text-xs text-ink-muted">
            {committed.length} ejecuciones{' '}
            <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
          </span>
        </summary>
        <div className="border-t border-border">
          {committed.length === 0 ? (
            <p className="px-5 py-6 text-sm text-ink-muted">
              Las revisiones confirmadas aparecerán aquí.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {committed.map((run) => (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center gap-x-5 gap-y-1 px-5 py-3 text-sm"
                >
                  <span className="min-w-0 flex-1 font-semibold text-ink">
                    {run.sourceName} · {run.sheetName}
                  </span>
                  <span className="text-ink-muted">{run.caseIds.length} asuntos</span>
                  <span className="flex items-center gap-1.5 text-xs text-ink-faint">
                    <Clock3 className="h-3.5 w-3.5" />{' '}
                    {formatDate(run.committedAt ?? run.createdAt)}
                  </span>
                  <button
                    type="button"
                    onClick={() => onReuse(run)}
                    className="text-xs font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    Usar configuración
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </details>
    </section>
  );
}
