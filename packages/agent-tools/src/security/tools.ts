import { evaluate as celEvaluate } from 'cel-js';
import { z } from 'zod';
import { registerTool } from '../index';
import { evaluateActionPolicy, parseActionPolicy } from './action-policy';
import { applyMandate } from './mandate';
import { loadMandates } from './mandate-store';
import {
  type Decision,
  type RiskLevel,
  type Surface,
  classify,
  decide,
  explainBlock,
  explainConfirm,
  explainFlag,
  familyOf,
} from './policy';
import { loadActionPolicy, loadPolicy, resetPolicyCache } from './store';

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
    const [policy, actionPolicy] = await Promise.all([
      loadPolicy(ctx.db, ctx.organizationId),
      loadActionPolicy(ctx.db, ctx.organizationId),
    ]);
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
    const doctrine = decide(classification, policy);

    /**
     * A DRY RUN THAT IGNORES MANDATES IS A DRY RUN THAT LIES.
     *
     * This tool exists so somebody can ask "what would happen if…" and get the
     * real answer. Once a workspace can delegate — «puedes mandar correos a
     * clientes sin preguntarme» — an explanation built from `decide()` alone
     * says «te pediría confirmar» about something that would sail straight
     * through, which is worse than not having the tool: it teaches people that
     * the explanation and the behaviour are two different things.
     *
     * So the same three steps the enforcement path takes, in the same order.
     * The read fails closed exactly as it does there — no mandates read means
     * no mandates, and the answer falls back to the doctrine, which is the
     * conservative direction for an explanation as well as for an action.
     */
    const mandates = await loadMandates(ctx.db, { toolId: input.toolId }).catch(() => []);
    const outcome = applyMandate({
      classification,
      decision: doctrine,
      tool: { id: input.toolId },
      input: payload,
      surface,
      mandates,
    });
    let decision = outcome.decision;
    const delegated = outcome.mandate !== null && doctrine !== decision;

    // Un dry-run que ignora la política CEL es un dry-run que miente — el
    // mismo argumento que con los mandatos, en la otra dirección.
    let policyNote: string | null = null;
    if (actionPolicy) {
      const cel = evaluateActionPolicy(actionPolicy, {
        tool: { id: input.toolId, family: familyOf(input.toolId) },
        surface,
        user: { id: ctx.userId },
        agent: { id: ctx.agentId ?? '' },
        risk: {
          level: classification.riskLevel,
          sensitivity: classification.sensitivity,
          blastRadius: classification.blastRadius,
          signals: classification.signals,
        },
        confirmed: false,
      });
      if (!cel.allowed && cel.mode === 'enforce') {
        decision = 'block';
        policyNote = cel.reason;
      } else if (!cel.allowed) {
        policyNote = `**Policy (dry-run):** rule \`${cel.matched ?? 'default deny'}\` would refuse this once the policy is switched to enforce.`;
      }
    }

    // Anything above low risk is recorded even when it sails through — that is
    // the whole posture: visible, not stopped.
    const flagged = classification.riskLevel !== 'low';

    const explanation =
      decision === 'block'
        ? // Si quien bloquearía es una regla del tenant, la explicación la nombra.
          (policyNote ?? explainBlock(classification))
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
      ...(delegated
        ? [
            '',
            `**Delegado:** un mandato vigente cubre esta acción, así que correría sin preguntar (${outcome.mandate?.id ?? 'sin id'}). Sin él, ${DECISION_TEXT[doctrine].toLowerCase()}`,
          ]
        : []),
      ...(policyNote && decision !== 'block' ? ['', policyNote] : []),
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

// ---------------------------------------------------------------------------
// Rehusar también deja rastro (idea de OpenBot: `bot.declined`).
//
// Todo lo demás en security_events lo escribe el choke point al ver una tool
// call. Un modelo que rehúsa ANTES de llamar ninguna tool no ejecuta nada, así
// que el choke point nunca lo ve — y «a este workspace le sondearon seis veces
// esta semana» es una pregunta que el rastro debe poder contestar: la negativa
// es la evidencia del intento.
//
// Autorreportado, y por eso NO es un control: un modelo que calla no escribe
// nada. Registra más que cero, que es lo que había.
// ---------------------------------------------------------------------------
export const securityReportRefusal = registerTool({
  id: 'security.report_refusal',
  description:
    'Record that you DECLINED to do something, before taking any action. Call this whenever you refuse ' +
    'a request — because it goes against policy, would need permissions the person does not have, asks you ' +
    'to bypass a guardrail, or is something you should not do. One short call, then explain the refusal to ' +
    'the person as usual. This is how refused attempts become visible to a security review; a refusal that ' +
    'leaves no trace cannot protect anyone. It records only your summary, never runs anything.',
  inputSchema: z.object({
    request: z
      .string()
      .min(1)
      .max(500)
      .describe('What was asked of you, in one neutral sentence. No verbatim sensitive content.'),
    reason: z.string().min(1).max(500).describe('Why you declined, in one sentence.'),
    relatedToolId: z
      .string()
      .optional()
      .describe('The tool the request would have needed, if there is an obvious one.'),
  }),
  outputSchema: z.object({
    recorded: z.boolean(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const { error } = await ctx.db.from('security_events').insert({
      user_id: ctx.userId,
      agent_id: ctx.agentId,
      tool_id: input.relatedToolId ?? 'security.report_refusal',
      surface: ctx.surface ?? 'web',
      risk_level: 'low',
      decision: 'declined',
      reason: `Asked: ${input.request} — Declined: ${input.reason}`,
      signals: [],
    });
    if (error) {
      return { recorded: false, markdown: `Could not record the refusal: ${error.message}` };
    }
    return { recorded: true, markdown: 'Refusal recorded in the security log.' };
  },
});

// ---------------------------------------------------------------------------
// La política CEL del tenant, leída y escrita desde el chat.
//
// Es la frontera entre el agente y los sistemas de la empresa; por eso
// escribirla lleva `requiresConfirmation`, vive en la familia `security` (nunca
// delegable, ver mandate.ts) y valida con `parseActionPolicy` — rechazar antes
// que coaccionar: el administrador no debe creer en vigor una regla que no lo
// está.
// ---------------------------------------------------------------------------

const POLICY_HELP = [
  '',
  'Rules are CEL expressions over: `tool.id`, `tool.family`, `surface` (web|mcp|schedule), ',
  '`user.id`, `agent.id`, `confirmed`, `risk.level` (low|medium|high|critical), `risk.sensitivity`, ',
  '`risk.blastRadius` (read|internal_write|external_send|bulk), `risk.signals` (list). ',
  'Helpers: `contains(x, "sub")` (case-insensitive, works on lists), `matches(x, "^regex$")`. ',
  'Examples: `tool.family == "payments"` · `risk.blastRadius == "external_send" && surface == "schedule"` ',
  '· `contains(risk.signals, "compensation-in-payload")`.',
].join('');

export const securityGetActionPolicy = registerTool({
  id: 'security.get_action_policy',
  description:
    'Read the workspace action policy — the CEL deny/allow rules evaluated on every tool call, on top of ' +
    'the built-in guardrails. Shows the mode (dry-run records what WOULD be refused without stopping ' +
    'anything; enforce refuses) and every rule. Returns null when the workspace has not written one.',
  inputSchema: z.object({}),
  outputSchema: z.object({
    policy: z
      .object({ mode: z.enum(['dry-run', 'enforce']), deny: z.array(z.string()), allow: z.array(z.string()) })
      .nullable(),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 20 },
  handler: async (_input, ctx) => {
    const { data, error } = await ctx.db
      .from('security_policies')
      .select('value, updated_at')
      .eq('key', 'action_policy')
      .maybeSingle();
    if (error) return { policy: null, markdown: `Could not read the policy: ${error.message}` };
    if (!data) {
      return {
        policy: null,
        markdown:
          'This workspace has no action policy: only the built-in guardrails apply. ' +
          'Write one with security.set_action_policy — start in dry-run mode.' +
          POLICY_HELP,
      };
    }
    const parsed = parseActionPolicy(data.value);
    if (!parsed.ok) {
      return {
        policy: null,
        markdown: `The stored policy is malformed and is being IGNORED (${parsed.error}). Rewrite it with security.set_action_policy.`,
      };
    }
    const p = parsed.policy;
    return {
      policy: p,
      markdown: [
        `### Action policy — mode: **${p.mode}**`,
        p.mode === 'dry-run'
          ? '_Dry-run: decisions are recorded in the security log but nothing is refused yet._'
          : '_Enforce: a deny match refuses the call outright._',
        '',
        `**Deny** (${p.deny.length}):`,
        ...(p.deny.length ? p.deny.map((r) => `- \`${r}\``) : ['- (none)']),
        `**Allow** (${p.allow.length}):`,
        ...p.allow.map((r) => `- \`${r}\``),
      ].join('\n'),
    };
  },
});

export const securitySetActionPolicy = registerTool({
  id: 'security.set_action_policy',
  description:
    'Write the workspace action policy: CEL deny/allow rules evaluated on every tool call, plus a mode. ' +
    'ALWAYS start new rules in "dry-run" — decisions get recorded in the security log without refusing ' +
    'anything, so the admin can read what would have been blocked before switching to "enforce". ' +
    'Deny beats allow; a broken rule fails closed (denies) in enforce mode. Omitting allow means allow ' +
    'everything not denied.' +
    POLICY_HELP,
  inputSchema: z.object({
    mode: z.enum(['dry-run', 'enforce']),
    deny: z.array(z.string().min(1)).max(50).default([]),
    allow: z.array(z.string().min(1)).max(50).optional(),
  }),
  outputSchema: z.object({
    saved: z.boolean(),
    policy: z
      .object({ mode: z.enum(['dry-run', 'enforce']), deny: z.array(z.string()), allow: z.array(z.string()) })
      .nullable(),
    /** Reglas que no evaluaron limpio contra un contexto de prueba — typos probables. */
    warnings: z.array(z.string()),
    markdown: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 5 },
  handler: async (input, ctx) => {
    const parsed = parseActionPolicy(input);
    if (!parsed.ok) {
      return { saved: false, policy: null, warnings: [], markdown: `Rejected: ${parsed.error}` };
    }
    const policy = parsed.policy;

    // Cada expresión se prueba contra un contexto de muestra. Un typo no impide
    // guardar — el motor falla cerrado igual — pero avisar aquí evita descubrirlo
    // como un workspace que rechaza todo.
    const sample = {
      tool: { id: 'gmail.send_message', family: 'gmail' },
      surface: 'web' as const,
      user: { id: ctx.userId },
      agent: { id: ctx.agentId ?? '' },
      risk: {
        level: 'medium' as const,
        sensitivity: 'client' as const,
        blastRadius: 'external_send' as const,
        signals: ['external-recipient'],
      },
      confirmed: false,
    };
    const warnings: string[] = [];
    for (const rule of [...policy.deny, ...policy.allow]) {
      try {
        celEvaluate(rule, sample as unknown as Record<string, unknown>, {
          contains: () => false,
          matches: () => false,
        });
      } catch (err) {
        warnings.push(`\`${rule}\` — ${String(err).slice(0, 140)}`);
      }
    }

    const { error } = await ctx.db
      .from('security_policies')
      .upsert(
        { key: 'action_policy', value: policy, updated_by: ctx.userId, updated_at: new Date().toISOString() },
        { onConflict: 'organization_id,key' },
      );
    if (error) {
      return { saved: false, policy: null, warnings, markdown: `Could not save the policy: ${error.message}` };
    }
    // Que rija YA en este proceso; otros procesos la recogen al expirar su caché (≤60s).
    resetPolicyCache();

    return {
      saved: true,
      policy,
      warnings,
      markdown: [
        `Action policy saved in **${policy.mode}** mode — ${policy.deny.length} deny, ${policy.allow.length} allow.`,
        policy.mode === 'dry-run'
          ? 'Nothing is refused yet: matches land in the security log. Review them with security.recent_events, then switch to enforce.'
          : 'Deny matches now refuse the call. Other running instances pick this up within a minute.',
        ...(warnings.length
          ? ['', '⚠️ These rules did not evaluate cleanly against a sample call (probable typo — they will fail CLOSED in enforce):', ...warnings.map((w) => `- ${w}`)]
          : []),
      ].join('\n'),
    };
  },
});

export type { RiskLevel };
