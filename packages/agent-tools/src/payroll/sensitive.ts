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
 * What the payroll service does and does not know.
 *
 * It used to be one of two systems answering "who works here, where are they
 * placed, what do they cost" — the HR system of record held the other half, and
 * this note existed to stop the model reconciling the two on its own. That
 * second system is gone, so the note now states the narrower thing that is
 * still true and still trips people up: payroll knows what was PAID, not what
 * the client is CHARGED.
 */
export const PAYROLL_SOURCE_NOTE =
  'SOURCE: the internal payroll service. It holds what people were actually paid and what they expensed — NOT the bill rate charged to the client, not the margin on an account, and not time-off balances. Cortex has no system for those any more, so do not estimate them: say plainly that the figure is not something you can look up.';
