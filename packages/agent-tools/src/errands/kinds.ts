/**
 * THE THREE THINGS YOU CAN ACTUALLY ENCARGAR, AND THE ONES YOU CANNOT.
 *
 * The temptation with an autonomous engine is to advertise "cualquier cosa" and
 * let the planner sort it out. That is a promise no such system keeps, and a
 * product that makes it spends its life explaining why this particular thing
 * did not work. So the surface offers three shapes, each one chosen because the
 * read-only tool catalogue can genuinely serve it end to end:
 *
 *   research_compare  a question about the world, answered with a comparison
 *   gather_sources    everything we and the internet have on one subject
 *   monitor_change    look again on a cadence, speak up when it changes
 *
 * WHAT WAS CONSIDERED AND DELIBERATELY LEFT OUT, with the reason, because the
 * next person will want to add them and should have to argue past this:
 *
 *   "consígueme un vuelo / reserva / cómpralo"   — the first half (find and
 *     compare fares) is a research_compare and works today. The second half is
 *     the line in boundary.ts and is never crossed by an autonomous run.
 *
 *   "sácame el certificado del portal"           — needs the taught browser
 *     (0087, services/browser), which is still being built and whose flows are
 *     not read-only by construction. See boundary.ts for where it plugs in.
 *
 *   "escríbele a estos diez proveedores"         — outbound. /actions already
 *     does this properly, hash-bound to what a person approved.
 *
 *   "arregla / implementa / haz el cambio"       — that is /dev-work, which has
 *     its own sandbox, its own budget and its own review.
 *
 *   "sigue este proceso que te enseño"           — that is /pipelines. A flow a
 *     person wrote down is not an errand; an errand is one Cortex works out.
 */

import { type Admission, errandToolAllowlist } from './boundary';
import type { ErrandKind } from './shape';

export interface ErrandKindSpec {
  kind: ErrandKind;
  /** Screen name. Colombian Spanish, named for what the person gets. */
  label: string;
  /** One line under the name on the launch form. */
  blurb: string;
  /** The example that goes in the placeholder — a real request, not a slogan. */
  example: string;
  /**
   * What the deliverable must be, handed to the model that writes it. Being
   * specific here is what stops every errand ending as the same wall of prose.
   */
  deliverableBrief: string;
  /** How the objective handed to the orchestrator is framed. */
  objectiveFraming: string;
  /** Legs this kind is allowed by default. See budget.ts for the argument. */
  defaultLegCeiling: number;
  /** Tokens this kind is allowed by default. */
  defaultTokenCeiling: number;
}

export const ERRAND_KIND_SPECS: Record<ErrandKind, ErrandKindSpec> = {
  research_compare: {
    kind: 'research_compare',
    label: 'Investigar y comparar',
    blurb:
      'Sale a buscar, contrasta lo que encuentra y te devuelve un cuadro comparativo con las fuentes de cada dato.',
    example:
      'Investiga qué operadores logísticos manejan carga refrigerada en Buenaventura y arma un cuadro comparativo.',
    deliverableBrief:
      'A COMPARISON. Lead with a markdown table whose rows are the options and whose columns are the ' +
      'dimensions that actually decide between them — never a generic "name / description" table. ' +
      'Every cell that is a claim about the world carries a bracketed source marker like [1] pointing ' +
      'at the source ledger. Follow the table with a short reading of it: what the table shows, where ' +
      'the options genuinely differ, and what is still unknown. Say plainly which dimensions you could ' +
      'not fill and why.',
    objectiveFraming:
      'Research the subject below and gather, for each option you find, the concrete facts a person ' +
      "would compare them on. Prefer primary sources — the operator's own site, a registry, a filing " +
      '— over aggregator pages. Record the URL of everything you use.',
    defaultLegCeiling: 3,
    defaultTokenCeiling: 400_000,
  },

  gather_sources: {
    kind: 'gather_sources',
    label: 'Reunir información',
    blurb:
      'Junta lo que hay sobre un tema dentro de la empresa y fuera de ella, y te lo entrega ordenado y con procedencia.',
    example:
      'Reúne todo lo que tenemos sobre Coltrans: correos, actas de reunión, documentos y lo que se diga por fuera.',
    deliverableBrief:
      'A DOSSIER. Organised by subject, not by where each piece came from — a reader wants "lo que ' +
      'sabemos del contrato", not "lo que dijo Gmail". Under each heading, the concrete facts with a ' +
      'bracketed source marker each. End with two short sections: "Lo que no cuadra" for anything two ' +
      'sources disagree about, and "Lo que no encontramos" for what was looked for and is missing. ' +
      'A gap named is useful; a gap papered over is not.',
    objectiveFraming:
      'Collect everything available about the subject below, from what the workspace already holds ' +
      '(Brain Knowledge, mail, documents, meetings, clients) AND from the open internet. Quote the ' +
      'concrete facts rather than summarising them away, and record where each one came from.',
    defaultLegCeiling: 3,
    defaultTokenCeiling: 400_000,
  },

  monitor_change: {
    kind: 'monitor_change',
    label: 'Vigilar y avisar',
    blurb:
      'Toma una lectura ahora, vuelve a mirar cada tanto y te avisa apenas cambie algo que importe.',
    example:
      'Vigila las tarifas publicadas de flete marítimo Cartagena–Miami y avísame cuando alguna se mueva.',
    deliverableBrief:
      'A READING, written so the NEXT reading can be compared against it mechanically. State each ' +
      'observed value as its own line: what it is, what it says today, and where it was read, with a ' +
      'bracketed source marker. No narrative, no hedging, no "aproximadamente" — a reading that is ' +
      'vague cannot be compared, and a comparison that cannot be made is a monitor that never fires.',
    objectiveFraming:
      'Take a reading of the subject below as it stands RIGHT NOW. Find the current values, from the ' +
      'most authoritative source available, and record each with its URL and the moment you read it.',
    // A monitor spends its budget across many looks, so each look gets one leg.
    defaultLegCeiling: 2,
    defaultTokenCeiling: 600_000,
  },
};

export const ERRAND_KIND_LIST: ErrandKindSpec[] = [
  ERRAND_KIND_SPECS.research_compare,
  ERRAND_KIND_SPECS.gather_sources,
  ERRAND_KIND_SPECS.monitor_change,
];

/**
 * Cadences offered for a monitor. A short list rather than a number field: the
 * useful cadences are few, and a person typing "5" into a minutes box would
 * create a job that re-reads the same page 288 times a day and bills for it.
 */
export const MONITOR_CADENCES: Array<{ minutes: number; label: string }> = [
  { minutes: 60, label: 'Cada hora' },
  { minutes: 6 * 60, label: 'Cada 6 horas' },
  { minutes: 24 * 60, label: 'Una vez al día' },
  { minutes: 7 * 24 * 60, label: 'Una vez por semana' },
];

export const DEFAULT_MONITOR_CADENCE_MINUTES = 24 * 60;

export function isMonitorCadence(minutes: number): boolean {
  return MONITOR_CADENCES.some((c) => c.minutes === minutes);
}

/**
 * The toolset a leg of this kind may draw from.
 *
 * Every kind gets the same read-only allow-list today, and that is a decision
 * rather than an omission: narrowing per kind would mean maintaining three
 * lists that drift, and the thing that actually keeps the promise is that the
 * list contains nothing that can send. What differs between kinds is the BRIEF,
 * which is where the difference belongs.
 *
 * `admission` widens it by exactly two ids, and only for a workspace that has
 * marked at least one trámite as safe to run unattended. It is a property of
 * the WORKSPACE and not of the kind, which is why it is a parameter here
 * rather than a fourth column of the specs above — a workspace that has taught
 * Cortex to pull a certificate wants that available to every kind of errand,
 * and a workspace that has not gets what it always got.
 */
export function toolsFor(_kind: ErrandKind, admission?: Admission): string[] {
  return errandToolAllowlist(admission);
}
