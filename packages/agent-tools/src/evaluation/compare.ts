/**
 * Did this change make it better or worse — with a number.
 *
 * THE ONE RULE THIS FILE ENFORCES. Two runs are comparable only if they were
 * asked the same thing. `suiteDigest` covers the corpus bytes, every question,
 * every group and every gold document, so a mismatch means somebody edited the
 * suite between the two runs and the deltas would be measuring their edit. That
 * returns `comparable: false` and no numbers at all. It would have been easy to
 * return the deltas with a warning attached; a warning next to two numbers is
 * read as decoration, and this is the one place where being unhelpful is the
 * feature.
 *
 * WHAT A REGRESSION IS. Any of the four headline numbers falling, or either of
 * the two error counts rising. `missedByFloor` and `overclaimed` are checked
 * separately from the ratios on purpose: a change can hold `grounding` steady
 * while turning three near-misses into three overclaims, and only the counts
 * show it.
 *
 * WHY THE ANSWER LAYER IS COMPARED SEPARATELY AND CAUTIOUSLY. It is not exactly
 * reproducible — the chat model takes no temperature on this account — so a
 * single case flipping is noise. It is reported, it is never the reason a
 * comparison is called a regression, and if either run's judge failed its own
 * calibration the answer deltas are withheld entirely rather than printed with
 * an asterisk.
 */

import type { EvalRun } from './types';

export interface Delta {
  label: string;
  before: number;
  after: number;
  change: number;
  /** True when the change is in the wrong direction, by more than `epsilon`. */
  worse: boolean;
}

export interface Comparison {
  comparable: boolean;
  /** Why not, in es-CO, when it is not. */
  reason: string | null;
  /** Configuration differences between the two runs — usually the point. */
  changed: Array<{ field: string; before: string; after: string }>;
  retrieval: Delta[];
  selection: Delta[];
  answers: Delta[];
  /** True when any tracked number moved the wrong way. */
  regression: boolean;
  /** Anything that has to be said before the numbers above are believed. */
  caveats: string[];
}

/**
 * Ratios below this are the same ratio. One case out of twenty-two is 0.045, so
 * anything smaller than half a case cannot be a real move — it is a rounding
 * artefact, and treating it as a regression teaches people to ignore the alarm.
 */
const EPSILON = 0.001;

function up(label: string, before: number, after: number): Delta {
  return { label, before, after, change: after - before, worse: after < before - EPSILON };
}

function down(label: string, before: number, after: number): Delta {
  return { label, before, after, change: after - before, worse: after > before + EPSILON };
}

export function compareRuns(before: EvalRun, after: EvalRun): Comparison {
  if (before.identity.suiteDigest !== after.identity.suiteDigest) {
    return {
      comparable: false,
      reason: `Las dos corridas no respondieron el mismo cuestionario: la huella del conjunto es ${before.identity.suiteDigest} y ${after.identity.suiteDigest}. Alguien cambió el corpus o las preguntas entre una y otra, así que restar los puntajes no compara nada. Vuelve a correr la línea base con el conjunto de hoy.`,
      changed: [],
      retrieval: [],
      selection: [],
      answers: [],
      regression: false,
      caveats: [],
    };
  }

  const changed: Comparison['changed'] = [];
  const note = (field: string, a: string | null, b: string | null) => {
    if ((a ?? '—') !== (b ?? '—')) changed.push({ field, before: a ?? '—', after: b ?? '—' });
  };
  note('modelo de embeddings', before.identity.embeddingModel, after.identity.embeddingModel);
  note('corte fuerte', String(before.identity.calibration.strongMatch), String(after.identity.calibration.strongMatch));
  note('piso débil', String(before.identity.calibration.weakFloor), String(after.identity.calibration.weakFloor));
  note('modelo de chat', before.identity.chatModel, after.identity.chatModel);
  note('modelo del juez', before.identity.judgeModel, after.identity.judgeModel);
  note('prompt de respuesta', before.identity.answerPromptDigest, after.identity.answerPromptDigest);
  note('prompt del juez', before.identity.judgePromptDigest, after.identity.judgePromptDigest);

  const retrieval = [
    up('fundamento', before.retrieval.grounding, after.retrieval.grounding),
    up('prudencia', before.retrieval.restraint, after.retrieval.restraint),
    up('primer lugar', before.retrieval.top1, after.retrieval.top1),
    down('descartados por el piso', before.retrieval.missedByFloor, after.retrieval.missedByFloor),
    down('respondidos de más', before.retrieval.overclaimed, after.retrieval.overclaimed),
  ];

  const selection = [up('alcance de herramientas', before.selection.reach, after.selection.reach)];

  const caveats: string[] = [];
  let answers: Delta[] = [];
  if (before.answers && after.answers) {
    const trusted = before.answers.judge.trusted && after.answers.judge.trusted;
    if (!trusted) {
      caveats.push(
        'No se comparan las respuestas: el juez no pasó su propia calibración en al menos una de las dos corridas, así que sus puntajes no significan nada todavía.',
      );
    } else {
      answers = [
        up('fundamento (respuesta)', before.answers.grounding, after.answers.grounding),
        up('prudencia (respuesta)', before.answers.restraint, after.answers.restraint),
      ];
      caveats.push(
        'La capa de respuestas no es exactamente reproducible: el modelo de chat no acepta temperatura en esta cuenta. Un caso de diferencia sobre veintidós es ruido, no una regresión.',
      );
    }
  }

  for (const run of [before, after]) {
    if (run.selection.staleTools > 0) {
      caveats.push(
        `Una de las corridas calificó la selección con ${run.selection.staleTools} herramienta(s) cuya descripción cambió después de medir.`,
      );
      break;
    }
  }

  return {
    comparable: true,
    reason: null,
    changed,
    retrieval,
    selection,
    answers,
    // Answers deliberately do not vote: see the header.
    regression: [...retrieval, ...selection].some((d) => d.worse),
    caveats,
  };
}

/** One block of plain text, for a terminal or a pull-request comment. */
export function formatRun(run: EvalRun): string {
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const lines = [
    `Evaluación ${run.identity.suiteId} · ${run.tier} · ${run.vectorSource}`,
    `Embeddings: ${run.identity.embeddingModel} (corte ${run.identity.calibration.strongMatch} / piso ${run.identity.calibration.weakFloor})`,
    '',
    `Recuperación   fundamento ${pct(run.retrieval.grounding)}   prudencia ${pct(run.retrieval.restraint)}   primer lugar ${pct(run.retrieval.top1)}`,
    `               descartados por el piso ${run.retrieval.missedByFloor}   respondidos de más ${run.retrieval.overclaimed}`,
    `Selección      alcance ${pct(run.selection.reach)} sobre ${run.selection.cases} casos`,
  ];
  if (run.answers) {
    lines.push(
      `Respuestas     fundamento ${pct(run.answers.grounding)}   prudencia ${pct(run.answers.restraint)}`,
      `Juez           ${run.answers.judge.trusted ? 'calibrado' : `NO CONFIABLE (indulgencia ${run.answers.judge.leniency.toFixed(2)}, severidad ${run.answers.judge.severity.toFixed(2)})`}`,
    );
  }
  lines.push('', `${(run.elapsedMs / 1000).toFixed(1)} s · USD ${run.costUsd.toFixed(4)}`);
  const failed = run.retrieval.results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push('', 'Recuperación, casos que fallaron:');
    for (const f of failed) {
      lines.push(
        `  ${f.caseId} (${f.group}) «${f.query}» → ${f.coverage}${f.missedByFloor ? ', descartado por el piso' : ''}${f.overclaimed ? ', respondido de más' : ''}${f.goldScore !== null ? `, mejor coseno del documento correcto ${f.goldScore.toFixed(3)}` : ''}`,
      );
    }
  }
  const missed = run.selection.results.filter((r) => !r.passed);
  if (missed.length > 0) {
    lines.push('', 'Selección, familias que no llegaron al modelo:');
    for (const m of missed) {
      lines.push(`  ${m.caseId} «${m.query}» → falta ${m.needsFamily} (puntaje ${m.familyScore?.toFixed(3) ?? 'sin medir'})`);
    }
  }
  // The answer layer prints its failures in FULL — the criterion that failed and
  // the sentence that failed it. A run of this tier costs a quarter of an hour
  // and a third of a dollar, and a report that said only "42%" would leave the
  // only question worth asking — is the system wrong or is the rubric wrong? —
  // answerable solely by spending it again.
  const wrong = (run.answers?.results ?? []).filter((r) => !r.passed);
  if (wrong.length > 0) {
    lines.push('', 'Respuestas que no cumplieron sus criterios:');
    for (const w of wrong) {
      lines.push('', `  ${w.caseId} (${w.group}) «${w.query}»`);
      for (const l of w.literals.filter((x) => !x.passed)) {
        lines.push(`    · ${l.kind === 'contains' ? 'falta' : 'sobra'} «${l.needle}»`);
      }
      for (const r of w.rubric.filter((x) => !x.passed)) {
        lines.push(`    · ${r.id}: se esperaba ${r.expect ? 'sí' : 'no'} y el juez dijo ${r.verdict ? 'sí' : 'no'}${r.evidence ? ` («${r.evidence}»)` : ''}`);
      }
      lines.push(`    respuesta: ${w.answer.replaceAll(/\s+/g, ' ').slice(0, 400)}`);
    }
  }
  if (run.warnings.length > 0) lines.push('', ...run.warnings.map((w) => `Ojo: ${w}`));
  return lines.join('\n');
}
