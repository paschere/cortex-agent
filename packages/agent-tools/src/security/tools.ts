import { z } from 'zod';
import { registerTool } from '../index';
import {
  type Decision,
  type RiskLevel,
  type Surface,
  classify,
  decide,
  explainBlock,
  explainConfirm,
  explainFlag,
} from './policy';
import { loadPolicy } from './store';

const SURFACES = ['web', 'mcp', 'schedule'] as const;
const LEVELS = ['low', 'medium', 'high', 'critical'] as const;

const DECISION_TEXT: Record<Decision, string> = {
  allow: 'Would run.',
  confirm: 'Would run after you confirm.',
  block: 'Would be refused.',
};

/** Flag-first: most risky-but-legitimate work runs and is recorded, not stopped. */
const DECISION_TEXT_FLAGGED = 'Would run, and be flagged in the audit log.';

/**
 * Dry-run the guardrails. This is an EXPLANATION tool, not the enforcement
 * path — enforcement happens unconditionally inside runTool. This exists so
 * the model can warn a user before attempting something, and so a human can
 * ask "what would happen if…" without anything happening.
 */
export const securityReviewAction = registerTool({
  id: 'security.review_action',
  description:
    'Check what the security guardrails would do with an action BEFORE attempting it. ' +
    'Give the tool id you are considering (e.g. "gmail.send_draft") plus a summary of the input ' +
    '(recipients, whether it carries pay/rate data, how many records). ' +
    'Returns the risk level, the signals that fired, and whether the action would run, need confirmation, or be refused — and why. ' +
    'It NEVER performs the action. Use it to explain risk to a user, or to answer "what would happen if we did X".',
  inputSchema: z.object({
    toolId: z.string().describe('The tool id being considered, e.g. "payroll.employee_profile".'),
    summary: z
      .string()
      .optional()
      .describe('Free-text description of the input: recipients, data involved, volume.'),
    input: z
      .record(z.any())
      .optional()
      .describe('The actual arguments you would pass, if you have them.'),
    surface: z
      .enum(SURFACES)
      .optional()
      .describe('Where it would run. "schedule" means unattended (no human in the loop).'),
  }),
  outputSchema: z.object({
    toolId: z.string(),
    riskLevel: z.enum(LEVELS),
    sensitivity: z.string(),
    blastRadius: z.string(),
    signals: z.array(z.string()),
    reason: z.string(),
    decision: z.enum(['allow', 'confirm', 'block']),
    /** True when the action runs but lands in the security log for review. */
    flagged: z.boolean(),
    explanation: z.string(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const policy = await loadPolicy(ctx.db);
    const surface = (input.surface ?? ctx.surface ?? 'web') as Surface;
    const payload = {
      ...(input.input ?? {}),
      ...(input.summary ? { summary: input.summary } : {}),
    };

    const classification = classify({
      tool: { id: input.toolId },
      input: payload,
      surface,
    });
    const decision = decide(classification, policy);

    // Anything above low risk is recorded even when it sails through — that is
    // the whole posture: visible, not stopped.
    const flagged = classification.riskLevel !== 'low';

    const explanation =
      decision === 'block'
        ? explainBlock(classification)
        : decision === 'confirm'
          ? explainConfirm(classification)
          : flagged
            ? explainFlag(classification)
            : `This would run normally (${classification.riskLevel} risk), nothing unusual about it.`;

    const decisionText =
      decision === 'allow' && flagged ? DECISION_TEXT_FLAGGED : DECISION_TEXT[decision];

    const markdown = [
      `### Guardrail review — \`${input.toolId}\``,
      `**Risk:** ${classification.riskLevel} · **Decision:** ${decisionText}`,
      `**Data:** ${classification.sensitivity} · **Blast radius:** ${classification.blastRadius}`,
      classification.signals.length
        ? `**Signals:** ${classification.signals.map((s) => `\`${s}\``).join(', ')}`
        : '**Signals:** none',
      '',
      classification.reason,
      '',
      explanation,
    ].join('\n');

    return {
      toolId: input.toolId,
      riskLevel: classification.riskLevel,
      sensitivity: classification.sensitivity,
      blastRadius: classification.blastRadius,
      signals: classification.signals as string[],
      reason: classification.reason,
      decision,
      flagged,
      explanation,
      markdown,
    };
  },
});

interface SecurityEventRow {
  id: string;
  user_id: string | null;
  agent_id: string | null;
  tool_id: string;
  surface: string | null;
  risk_level: string;
  decision: string;
  reason: string;
  signals: unknown;
  created_at: string;
}

/** What the guardrails actually caught — for admins reviewing the log. */
export const securityRecentEvents = registerTool({
  id: 'security.recent_events',
  description:
    'List recent security events — the tool calls the guardrails flagged, gated or refused. ' +
    'Filter by user, risk level, decision or time window. Read-only; use it to answer ' +
    '"has anything risky been attempted", "what got blocked this week", or to review a specific person\'s activity.',
  inputSchema: z.object({
    userId: z.string().uuid().optional().describe('Restrict to one user.'),
    level: z.enum(LEVELS).optional().describe('Minimum risk level to include.'),
    decision: z
      .enum(['blocked', 'confirm_required', 'flagged'])
      .optional()
      .describe('Restrict to one kind of outcome.'),
    days: z.number().int().min(1).max(90).default(7).describe('How far back to look.'),
    limit: z.number().int().min(1).max(100).default(25),
  }),
  outputSchema: z.object({
    events: z.array(
      z.object({
        id: z.string(),
        toolId: z.string(),
        userId: z.string().nullable(),
        surface: z.string().nullable(),
        riskLevel: z.string(),
        decision: z.string(),
        reason: z.string(),
        signals: z.array(z.string()),
        createdAt: z.string(),
      }),
    ),
    total: z.number(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const days = input.days ?? 7;
    const limit = input.limit ?? 25;
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    let q = ctx.db
      .from('security_events')
      .select(
        'id, user_id, agent_id, tool_id, surface, risk_level, decision, reason, signals, created_at',
      )
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(limit);

    if (input.userId) q = q.eq('user_id', input.userId);
    if (input.decision) q = q.eq('decision', input.decision);
    if (input.level) {
      const idx = LEVELS.indexOf(input.level);
      q = q.in('risk_level', LEVELS.slice(idx) as unknown as string[]);
    }

    const { data, error } = await q;
    if (error) {
      return {
        events: [],
        total: 0,
        markdown: `Could not read the security log: ${error.message}`,
      };
    }

    const rows = (data ?? []) as SecurityEventRow[];
    const events = rows.map((r) => ({
      id: r.id,
      toolId: r.tool_id,
      userId: r.user_id,
      surface: r.surface,
      riskLevel: r.risk_level,
      decision: r.decision,
      reason: r.reason,
      signals: Array.isArray(r.signals) ? (r.signals as string[]) : [],
      createdAt: r.created_at,
    }));

    const byDecision = events.reduce<Record<string, number>>((acc, e) => {
      acc[e.decision] = (acc[e.decision] ?? 0) + 1;
      return acc;
    }, {});

    const parts: string[] = [`### Security events — last ${days} day${days === 1 ? '' : 's'}`];
    if (!events.length) {
      parts.push('Nothing flagged, gated or blocked in this window.');
      return { events, total: 0, markdown: parts.join('\n') };
    }
    parts.push(
      Object.entries(byDecision)
        .map(([d, n]) => `**${d}**: ${n}`)
        .join(' · '),
    );
    parts.push('');
    parts.push('| When | Tool | Level | Outcome | Signals |');
    parts.push('|---|---|---|---|---|');
    for (const e of events) {
      parts.push(
        `| ${e.createdAt.slice(0, 16).replace('T', ' ')} | \`${e.toolId}\` | ${e.riskLevel} | ${e.decision} | ${e.signals.join(', ') || '—'} |`,
      );
    }

    return { events, total: events.length, markdown: parts.join('\n') };
  },
});

export type { RiskLevel };
