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
