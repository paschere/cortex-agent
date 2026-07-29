/**
 * Shared confidentiality warning appended to every payroll tool description
 * that can surface compensation, pay rates or per-person cost data.
 *
 * It is written for the model, not for a human reader: it must be explicit
 * enough that the model refuses to paste salary figures into Slack, an email
 * draft, a shared doc or any other external destination without the user
 * saying so in that turn.
 */
export const COMP_SENSITIVITY_NOTE =
  'SENSITIVE: this returns confidential compensation data (pay rates, per-person cost, payroll totals). ' +
  'Share it only with the person who asked, in this conversation. ' +
  'Never post it to Slack, email, a shared document, a client, or any other external destination ' +
  'unless the user explicitly confirms that exact action first.';

/**
 * The counterpart of bamboo/shape.ts PAYROLL_BOUNDARY_NOTE.
 *
 * Both families answer "who works here, where are they placed, what do they
 * cost" from different databases. Merging them would hide a discrepancy that
 * somebody needs to see, so instead every overlapping tool says which system it
 * read and refuses to reconcile the two on its own.
 */
export const BAMBOO_BOUNDARY_NOTE =
  'SOURCE: the internal payroll service, which is a different system from BambooHR. BambooHR (bamboo.*) is the HR system of record for the roster, the placement and the bill rate charged to the client; payroll holds what was actually paid and expensed. The two can hold different figures for the same person. If you have numbers from both and they disagree, give both and say which came from where — never average them or silently pick one.';
