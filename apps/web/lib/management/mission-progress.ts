import type { ActivationRun, ActivationSource } from '@/lib/activations/types';
import type { ManagementActivationEvidence, ManagementCase, ManagementState } from './shape';

/**
 * The first mission is a projection over data that already has an owner and a
 * tenant boundary. It deliberately does not introduce a second workflow
 * state machine: a simulation is an `activation_run`, a result is a committed
 * run with its management cases, and closure is the existing reviewed case
 * state.
 */
export const MISSION_PHASES = ['objective', 'source', 'simulation', 'result'] as const;
export type MissionPhase = (typeof MISSION_PHASES)[number];
export type MissionPhaseState = 'pending' | 'ready' | 'review' | 'verified' | 'unknown';

export type MissionPhaseView = {
  id: MissionPhase;
  label: string;
  state: MissionPhaseState;
  detail: string;
  href: string;
};

export type MissionSource = {
  id: string;
  name: string;
  kind: ActivationSource['kind'];
  expiresAt: string;
  sheets: number;
  rows: number;
};

export type MissionCaseSummary = {
  id: string;
  title: string;
  state: ManagementState;
  ownerId: string | null;
  dueOn: string;
  nextAction: string;
  hasEvidence: boolean;
  href: string;
};

/**
 * A result whose private activation run has already expired or been deleted.
 * This is deliberately not an ActivationRun: it cannot be resumed, and the
 * source is not reconstructed from the immutable case provenance.
 */
export type MissionHistory = {
  runId: string;
  sourceId: string | null;
  sourceName: string | null;
  createdAt: string | null;
  objective: string | null;
  cases: MissionCaseSummary[];
  results: {
    created: number;
    readyForReview: number;
    verified: number;
  };
};

export type MissionProgress = {
  phases: MissionPhaseView[];
  latestRun: ActivationRun | null;
  committedRun: ActivationRun | null;
  history: MissionHistory | null;
  sources: MissionSource[];
  sourceCount: number | null;
  runs: { simulated: number; committed: number };
  cases: MissionCaseSummary[];
  results: {
    created: number;
    readyForReview: number;
    verified: number;
  };
  objective: string | null;
  resumeHref: string | null;
  complete: boolean;
  errors: string[];
};

type Inputs = {
  sources: ActivationSource[];
  sourceCount?: number | null;
  runs: ActivationRun[];
  selectedRunId?: string | null;
  cases: ManagementCase[];
  historicalCases?: ManagementCase[];
  historyAvailable?: boolean;
  runsAvailable?: boolean;
  casesAvailable?: boolean;
  errors?: string[];
};

function definitionObjectiveFromDefinition(
  definition: ActivationRun['definition'] | null | undefined,
): string | null {
  if (!definition) return null;
  if (definition.kind === 'invoice_duplicates') {
    return definition.caseObjective?.trim() || definition.name.trim() || null;
  }
  return definition.caseObjective.trim() || definition.name.trim() || null;
}

function definitionObjective(run: ActivationRun | null): string | null {
  return definitionObjectiveFromDefinition(run?.definition);
}

function activationPrompt(run: ActivationRun): string {
  const definition = run.definition;
  if (definition.kind === 'invoice_duplicates') {
    return [definition.name, definition.caseObjective, definition.caseNextAction]
      .filter(Boolean)
      .join('. ');
  }
  return [definition.name, definition.caseObjective, definition.caseNextAction]
    .filter(Boolean)
    .join('. ');
}

function sourceView(source: ActivationSource): MissionSource {
  return {
    id: source.id,
    name: source.filename,
    kind: source.kind,
    expiresAt: source.expiresAt,
    sheets: source.sheets.length + source.preparedViews.length,
    rows:
      source.sheets.reduce((total, sheet) => total + sheet.rowCount, 0) +
      source.preparedViews.reduce((total, view) => total + view.rowCount, 0),
  };
}

function latestFirst(a: ActivationRun, b: ActivationRun) {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

function caseSummary(item: ManagementCase): MissionCaseSummary {
  return {
    id: item.id,
    title: item.data.title,
    state: item.data.state,
    ownerId: item.data.ownerId,
    dueOn: item.data.dueOn,
    nextAction: item.data.nextAction,
    hasEvidence: Boolean(item.data.evidence),
    href: `/management?case=${encodeURIComponent(item.id)}`,
  };
}

function activationEvidence(item: ManagementCase): ManagementActivationEvidence | null {
  const evidence = item.data.activationEvidence;
  if (!evidence || typeof evidence !== 'object') return null;
  if (typeof evidence.runId !== 'string' || !Array.isArray(evidence.rows)) return null;
  return evidence;
}

function resultCounts(cases: MissionCaseSummary[]) {
  return {
    created: cases.length,
    readyForReview: cases.filter((item) => item.state === 'review').length,
    verified: cases.filter((item) => item.state === 'verified' && item.hasEvidence).length,
  };
}

function historyFromCases(items: ManagementCase[]): MissionHistory | null {
  const groups = new Map<string, ManagementCase[]>();
  for (const item of items) {
    const evidence = activationEvidence(item);
    if (!evidence) continue;
    const group = groups.get(evidence.runId) ?? [];
    group.push(item);
    groups.set(evidence.runId, group);
  }
  if (groups.size === 0) return null;

  const [runId, cases] = [...groups.entries()].sort(([, left], [, right]) => {
    const leftAt = Math.max(
      ...left.map((item) => Date.parse(item.updated_at || item.created_at) || 0),
    );
    const rightAt = Math.max(
      ...right.map((item) => Date.parse(item.updated_at || item.created_at) || 0),
    );
    return rightAt - leftAt;
  })[0] ?? [null, []];
  if (!runId || cases.length === 0) return null;

  const firstCase = cases[0];
  if (!firstCase) return null;
  const firstEvidence = activationEvidence(firstCase);
  const summaries = cases
    .sort((a, b) => a.data.dueOn.localeCompare(b.data.dueOn) || a.id.localeCompare(b.id))
    .map(caseSummary);
  const results = resultCounts(summaries);
  return {
    runId,
    sourceId: firstEvidence?.sourceId ?? null,
    sourceName: firstEvidence?.sourceName ?? null,
    createdAt: cases.reduce(
      (latest, item) => {
        const value = item.updated_at || item.created_at;
        return !latest || value > latest ? value : latest;
      },
      null as string | null,
    ),
    objective: definitionObjectiveFromDefinition(firstEvidence?.definition),
    cases: summaries,
    results,
  };
}

export function buildMissionProgress(input: Inputs): MissionProgress {
  const runs = [...input.runs].sort(latestFirst);
  const latestRun =
    (input.selectedRunId ? runs.find((run) => run.id === input.selectedRunId) : null) ??
    runs[0] ??
    null;
  // Follow one run from objective through result. An older committed run must
  // never make a newer simulation look resolved.
  const committedRun = latestRun?.status === 'committed' ? latestRun : null;
  const committedCaseIds = new Set(committedRun?.caseIds ?? []);
  const cases = input.cases
    .filter((item) => committedCaseIds.has(item.id))
    .sort((a, b) => a.data.dueOn.localeCompare(b.data.dueOn) || a.id.localeCompare(b.id))
    .map(caseSummary);
  const history =
    (input.historyAvailable ?? true) && input.historicalCases
      ? historyFromCases(input.historicalCases)
      : null;
  const currentResults = resultCounts(cases);
  const historicalResults = !latestRun ? (history?.results ?? null) : null;
  const displayCases = latestRun ? cases : (history?.cases ?? []);
  const displayResults = historicalResults ?? currentResults;
  const verified = displayResults.verified;
  const readyForReview = displayResults.readyForReview;
  const sourceCount = input.sourceCount === undefined ? input.sources.length : input.sourceCount;
  const selectedSource = latestRun
    ? input.sources.find((source) => source.id === latestRun.sourceId)
    : null;
  const objective = latestRun ? definitionObjective(latestRun) : (history?.objective ?? null);
  const resumeHref = latestRun
    ? `/activations?run=${encodeURIComponent(latestRun.id)}&source=${encodeURIComponent(latestRun.sourceId)}&sourceId=${encodeURIComponent(latestRun.sourceId)}&prompt=${encodeURIComponent(activationPrompt(latestRun))}`
    : null;
  const runsAvailable = input.runsAvailable ?? true;
  const casesAvailable = input.casesAvailable ?? true;

  const phases: MissionPhaseView[] = [
    {
      id: 'objective',
      label: 'Objetivo',
      state: latestRun || history?.objective ? 'ready' : runsAvailable ? 'pending' : 'unknown',
      detail: latestRun
        ? (objective ?? 'Objetivo guardado en la simulación.')
        : history?.objective
          ? 'Objetivo recuperado del resultado histórico conservado en Gerencia.'
          : 'Describe un resultado acotado que puedas comprobar.',
      href: '/management/mission',
    },
    {
      id: 'source',
      label: 'Fuente',
      state: selectedSource
        ? 'ready'
        : latestRun
          ? sourceCount === null
            ? 'unknown'
            : 'pending'
          : history
            ? 'unknown'
            : sourceCount === null
              ? 'unknown'
              : sourceCount > 0
                ? 'ready'
                : 'pending',
      detail: selectedSource
        ? `${selectedSource.filename} · fuente privada con ${selectedSource.sheets.length} hoja${selectedSource.sheets.length === 1 ? '' : 's'}.`
        : latestRun
          ? 'La fuente de esta misión ya no está disponible. Añade una versión vigente para simular otra vez.'
          : history
            ? 'La fuente privada original ya no está disponible; el resultado histórico permanece en Gerencia.'
            : sourceCount === null
              ? 'No se pudo comprobar Feed. Reintenta antes de continuar.'
              : sourceCount > 0
                ? `${sourceCount} fuente${sourceCount === 1 ? '' : 's'} disponible${sourceCount === 1 ? '' : 's'} en Feed.`
                : 'Añade un archivo, texto, enlace o conexión en Feed.',
      href: '/feed',
    },
    {
      id: 'simulation',
      label: 'Simulación',
      state: latestRun ? 'ready' : history ? 'unknown' : runsAvailable ? 'pending' : 'unknown',
      detail: latestRun
        ? `Simulación ${latestRun.status === 'committed' ? 'compartida' : 'guardada'} el ${latestRun.createdAt.slice(0, 10)}.`
        : history
          ? 'La simulación original ya no está disponible para retomar; sus asuntos conservan el resultado compartido.'
          : 'La simulación conserva las filas y la regla antes de compartir asuntos.',
      href: resumeHref ?? '/activations',
    },
    {
      id: 'result',
      label: 'Primer resultado',
      state: committedRun
        ? verified > 0
          ? 'verified'
          : readyForReview > 0
            ? 'review'
            : cases.length > 0
              ? 'ready'
              : 'unknown'
        : history
          ? verified > 0
            ? 'verified'
            : readyForReview > 0
              ? 'review'
              : displayCases.length > 0
                ? 'ready'
                : 'unknown'
          : casesAvailable
            ? runsAvailable
              ? 'pending'
              : 'unknown'
            : 'unknown',
      detail: committedRun
        ? verified > 0
          ? `${verified} resultado${verified === 1 ? '' : 's'} cerrado${verified === 1 ? '' : 's'} con evidencia revisada.`
          : cases.length > 0
            ? `${cases.length} asunto${cases.length === 1 ? '' : 's'} creado${cases.length === 1 ? '' : 's'}; falta la revisión humana del resultado.`
            : 'La simulación se compartió, pero todavía no se pudo leer su resultado.'
        : history
          ? verified > 0
            ? `${verified} resultado${verified === 1 ? '' : 's'} histórico${verified === 1 ? '' : 's'} cerrado${verified === 1 ? '' : 's'} con evidencia revisada.`
            : displayCases.length > 0
              ? `${displayCases.length} asunto${displayCases.length === 1 ? '' : 's'} histórico${displayCases.length === 1 ? '' : 's'} conservado${displayCases.length === 1 ? '' : 's'} en Gerencia.`
              : 'Se conservó la referencia histórica, pero no se pudo leer un asunto asociado.'
          : 'Comparte los hallazgos sólo después de revisar la simulación.',
      href: displayCases[0]?.href ?? '/management',
    },
  ];

  return {
    phases,
    latestRun,
    committedRun,
    history,
    sources: input.sources.map(sourceView),
    sourceCount,
    runs: {
      simulated: runs.length,
      committed: runs.filter((run) => run.status === 'committed').length,
    },
    cases: displayCases,
    results: displayResults,
    objective,
    resumeHref,
    // A committed run is an output to review, not a completed mission. Keep
    // this flag tied to the existing human-reviewed case state.
    complete: verified > 0,
    errors: [...new Set(input.errors ?? [])],
  };
}
