import { describe, expect, it } from 'vitest';
import {
  APPROVAL_ACTION,
  APPROVAL_DECISION_PARAM,
  APPROVAL_ID_PARAM,
  buildApprovalCard,
  buildResolvedCard,
} from './approval-card';

const APPROVAL = '44444444-4444-4444-8444-444444444444';

function cardJson(card: unknown): string {
  return JSON.stringify(card);
}

function buttonsOf(card: { card: Record<string, unknown> }): Array<Record<string, unknown>> {
  const sections = card.card.sections as Array<{ widgets?: Array<Record<string, unknown>> }>;
  const out: Array<Record<string, unknown>> = [];
  for (const section of sections) {
    for (const widget of section.widgets ?? []) {
      const list = widget.buttonList as { buttons?: Array<Record<string, unknown>> } | undefined;
      if (list?.buttons) out.push(...list.buttons);
    }
  }
  return out;
}

describe('buildApprovalCard', () => {
  const base = {
    approvalId: APPROVAL,
    toolId: 'gmail.send_draft',
    input: { draftId: 'r-99', to: 'cliente@example.com' },
    expiresAt: new Date('2026-07-27T19:47:00Z'),
    origin: 'mcp' as const,
    timeZone: 'America/Bogota',
  };

  it('carries only the id and the decision on its buttons — never the payload', () => {
    const card = buildApprovalCard(base);
    const decisionButtons = buttonsOf(card).filter(
      (b) => 'onClick' in b && (b.onClick as { action?: unknown }).action,
    );

    expect(decisionButtons).toHaveLength(2);
    for (const button of decisionButtons) {
      const action = (
        button.onClick as {
          action: { function: string; parameters: Array<{ key: string; value: string }> };
        }
      ).action;
      expect(action.function).toBe(APPROVAL_ACTION);
      // Exactly two parameters: the pointer, and which button it was. An
      // earlier design put the whole validated input in the token and it got
      // truncated in transit — the payload must stay on the server.
      expect(action.parameters.map((p) => p.key).sort()).toEqual(
        [APPROVAL_DECISION_PARAM, APPROVAL_ID_PARAM].sort(),
      );
      const id = action.parameters.find((p) => p.key === APPROVAL_ID_PARAM);
      expect(id?.value).toBe(APPROVAL);
    }
    const decisions = decisionButtons.map(
      (b) =>
        (
          b.onClick as { action: { parameters: Array<{ key: string; value: string }> } }
        ).action.parameters.find((p) => p.key === APPROVAL_DECISION_PARAM)?.value,
    );
    expect(decisions).toEqual(['approve', 'decline']);
  });

  it('never puts a raw tool id in front of the person', () => {
    const json = cardJson(buildApprovalCard(base));
    expect(json).not.toContain('gmail.send_draft');
    expect(json).toContain('Send Email Draft');
  });

  it('escapes a payload that tries to bring its own markup', () => {
    const card = buildApprovalCard({
      ...base,
      input: { body: '<a href="https://evil.example">click me</a>' },
    });
    const json = cardJson(card);
    expect(json).not.toContain('<a href=');
    expect(json).toContain('&lt;a href=');
  });

  it('keeps the payload in a section that starts closed', () => {
    const sections = buildApprovalCard(base).card.sections as Array<Record<string, unknown>>;
    const payloadSection = sections.find((s) => s.header === 'Exactly what will run');
    expect(payloadSection?.collapsible).toBe(true);
    expect(payloadSection?.uncollapsibleWidgetsCount).toBe(0);
  });

  it('shows the expiry in the person’s own timezone', () => {
    const json = cardJson(buildApprovalCard(base));
    // 19:47 UTC is 14:47 in Bogota.
    expect(json).toContain('Expires at 14:47');
  });
});

describe('buildResolvedCard', () => {
  it('has no buttons left to press', () => {
    const card = buildResolvedCard({
      approvalId: APPROVAL,
      toolId: 'gmail.send_draft',
      title: 'Approved',
      headline: 'Approved by you · 14:32',
      detail: 'Done ⚡',
    });
    expect(buttonsOf(card)).toHaveLength(0);
    expect(cardJson(card)).not.toContain(APPROVAL_ACTION);
  });

  it('reuses the approval’s card id so the message is replaced, not stacked', () => {
    const pending = buildApprovalCard({
      approvalId: APPROVAL,
      toolId: 'gmail.send_draft',
      input: {},
      expiresAt: new Date(),
      origin: 'chat',
      timeZone: 'UTC',
    });
    const resolved = buildResolvedCard({
      approvalId: APPROVAL,
      toolId: 'gmail.send_draft',
      title: 'Declined',
      headline: 'Declined by you · 14:32',
    });
    expect(resolved.cardId).toBe(pending.cardId);
  });
});
