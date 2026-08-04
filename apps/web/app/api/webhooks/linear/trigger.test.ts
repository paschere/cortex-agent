import { describe, expect, it } from "vitest";
import {
  type LinearWebhookBody,
  type TriggerConfig,
  evaluateTrigger,
  linearEventKey,
  parseRepoDirective,
  parseRepoLabel,
  triggerConfigFromEnv,
} from "./trigger";

const CORTEX_ID = "11111111-2222-3333-4444-555555555555";

const assigneeConfig: TriggerConfig = {
  mode: "assignee",
  cortexUserId: CORTEX_ID,
  cortexUserEmail: "cortex@example.com",
  label: "cortex",
};

function issueEvent(
  overrides: Partial<LinearWebhookBody> = {},
): LinearWebhookBody {
  const { data, ...rest } = overrides;
  return {
    action: "update",
    type: "Issue",
    webhookTimestamp: Date.now(),
    ...rest,
    data: {
      id: "issue-uuid",
      identifier: "ENG-1",
      title: "Fix the thing",
      state: { type: "unstarted" },
      ...(data ?? {}),
    },
  };
}

describe("triggerConfigFromEnv", () => {
  it('defaults to assignee mode and the "cortex" label', () => {
    const config = triggerConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(config.mode).toBe("assignee");
    expect(config.label).toBe("cortex");
    expect(config.cortexUserId).toBeNull();
  });

  it("falls back to assignee mode when the variable is nonsense", () => {
    const env = {
      LINEAR_TRIGGER_MODE: "whatever",
    } as unknown as NodeJS.ProcessEnv;
    expect(triggerConfigFromEnv(env).mode).toBe("assignee");
  });

  it("reads label mode and normalises casing", () => {
    const env = {
      LINEAR_TRIGGER_MODE: "LABEL",
      LINEAR_TRIGGER_LABEL: "Cortex-Please",
      LINEAR_CORTEX_USER_EMAIL: "Cortex@Example.com",
    } as unknown as NodeJS.ProcessEnv;
    const config = triggerConfigFromEnv(env);
    expect(config.mode).toBe("label");
    expect(config.label).toBe("cortex-please");
    expect(config.cortexUserEmail).toBe("cortex@example.com");
  });
});

describe("evaluateTrigger — assignee mode", () => {
  it("fires when the issue is assigned to Cortex in this event", () => {
    const event = issueEvent({
      data: {
        id: "issue-uuid",
        assigneeId: CORTEX_ID,
        state: { type: "unstarted" },
      },
      updatedFrom: { assigneeId: null },
    });
    expect(evaluateTrigger(event, assigneeConfig)).toEqual({
      accepted: true,
      via: "assignee",
    });
  });

  it("fires on create when the issue is born assigned to Cortex", () => {
    const event = issueEvent({
      action: "create",
      data: {
        id: "issue-uuid",
        assignee: { id: CORTEX_ID },
        state: { type: "backlog" },
      },
    });
    expect(evaluateTrigger(event, assigneeConfig)).toEqual({
      accepted: true,
      via: "assignee",
    });
  });

  it("does NOT re-fire when an already-assigned issue is edited", () => {
    const event = issueEvent({
      data: {
        id: "issue-uuid",
        assigneeId: CORTEX_ID,
        state: { type: "started" },
      },
      updatedFrom: { description: "old text" },
    });
    expect(evaluateTrigger(event, assigneeConfig).accepted).toBe(false);
  });

  it("ignores an assignment to somebody else", () => {
    const event = issueEvent({
      data: {
        id: "issue-uuid",
        assigneeId: "someone-else",
        state: { type: "unstarted" },
      },
      updatedFrom: { assigneeId: null },
    });
    expect(evaluateTrigger(event, assigneeConfig).accepted).toBe(false);
  });

  it("ignores an issue that is already completed or cancelled", () => {
    for (const type of ["completed", "canceled"]) {
      const event = issueEvent({
        data: { id: "issue-uuid", assigneeId: CORTEX_ID, state: { type } },
        updatedFrom: { assigneeId: null },
      });
      expect(evaluateTrigger(event, assigneeConfig).accepted).toBe(false);
    }
  });

  it("refuses to fire when no Cortex identity is configured", () => {
    const event = issueEvent({
      data: {
        id: "issue-uuid",
        assigneeId: CORTEX_ID,
        state: { type: "unstarted" },
      },
      updatedFrom: { assigneeId: null },
    });
    const unconfigured: TriggerConfig = {
      ...assigneeConfig,
      cortexUserId: null,
      cortexUserEmail: null,
    };
    expect(evaluateTrigger(event, unconfigured)).toEqual({
      accepted: false,
      reason: "assignee trigger is not configured",
    });
  });

  it("ignores a label in assignee mode", () => {
    const event = issueEvent({
      data: {
        id: "issue-uuid",
        labels: [{ name: "Cortex" }],
        state: { type: "unstarted" },
      },
      updatedFrom: { labelIds: [] },
    });
    expect(evaluateTrigger(event, assigneeConfig).accepted).toBe(false);
  });

  it.each([
    ["a comment", { type: "Comment" }],
    ["a project update", { type: "Project" }],
    ["a deletion", { type: "Issue", action: "remove" }],
  ])("ignores %s", (_label, overrides) => {
    const event = issueEvent({
      ...overrides,
      data: {
        id: "issue-uuid",
        assigneeId: CORTEX_ID,
        state: { type: "unstarted" },
      },
      updatedFrom: { assigneeId: null },
    });
    expect(evaluateTrigger(event, assigneeConfig).accepted).toBe(false);
  });
});

describe("evaluateTrigger — label and either mode", () => {
  const labelConfig: TriggerConfig = { ...assigneeConfig, mode: "label" };

  it("fires when the trigger label is applied in this event", () => {
    const event = issueEvent({
      data: {
        id: "issue-uuid",
        labels: [{ name: "Cortex" }],
        state: { type: "unstarted" },
      },
      updatedFrom: { labelIds: ["old"] },
    });
    expect(evaluateTrigger(event, labelConfig)).toEqual({
      accepted: true,
      via: "label",
    });
  });

  it("does NOT re-fire when an already-labelled issue is edited", () => {
    const event = issueEvent({
      data: {
        id: "issue-uuid",
        labels: [{ name: "cortex" }],
        state: { type: "started" },
      },
      updatedFrom: { title: "old" },
    });
    expect(evaluateTrigger(event, labelConfig).accepted).toBe(false);
  });

  it("ignores an assignment in label mode", () => {
    const event = issueEvent({
      data: {
        id: "issue-uuid",
        assigneeId: CORTEX_ID,
        state: { type: "unstarted" },
      },
      updatedFrom: { assigneeId: null },
    });
    expect(evaluateTrigger(event, labelConfig).accepted).toBe(false);
  });

  it("either mode accepts whichever signal arrives", () => {
    const either: TriggerConfig = { ...assigneeConfig, mode: "either" };
    const byLabel = issueEvent({
      data: {
        id: "issue-uuid",
        labels: [{ name: "cortex" }],
        state: { type: "unstarted" },
      },
      updatedFrom: { labelIds: [] },
    });
    const byAssignee = issueEvent({
      data: {
        id: "issue-uuid",
        assigneeId: CORTEX_ID,
        state: { type: "unstarted" },
      },
      updatedFrom: { assigneeId: null },
    });
    expect(evaluateTrigger(byLabel, either)).toEqual({
      accepted: true,
      via: "label",
    });
    expect(evaluateTrigger(byAssignee, either)).toEqual({
      accepted: true,
      via: "assignee",
    });
  });
});

describe("linearEventKey", () => {
  it("is stable for identical bytes and different for anything else", () => {
    const raw = '{"a":1,"webhookTimestamp":1770000000000}';
    expect(linearEventKey(raw)).toBe(linearEventKey(raw));
    expect(linearEventKey(raw)).not.toBe(linearEventKey(`${raw} `));
    expect(linearEventKey(raw)).toHaveLength(64);
  });
});

describe("repository hints", () => {
  it.each([
    ["Repo: payroll", "payroll"],
    ["**Repo:** payroll", "payroll"],
    ["- repo = acme-matcher", "acme-matcher"],
    ["Repository: CORTEX-AGENT", "cortex-agent"],
    ["repo: acme/payroll", "payroll"],
    ["repo: payroll.git", "payroll"],
  ])("reads %s", (line, expected) => {
    expect(parseRepoDirective(`Some context\n\n${line}\n\nMore text`)).toBe(
      expected,
    );
  });

  it("takes the first directive when an issue contradicts itself", () => {
    expect(parseRepoDirective("Repo: payroll\nRepo: cortex-agent")).toBe(
      "payroll",
    );
  });

  it.each([
    ["no directive", "Please fix the login page"],
    ["a mention inside prose", "The repo: is wherever the payroll code lives"],
    ["nothing at all", null],
  ])("returns null for %s", (_label, description) => {
    expect(parseRepoDirective(description)).toBeNull();
  });

  it("reads a repo:<key> label", () => {
    expect(
      parseRepoLabel({ labels: [{ name: "bug" }, { name: "Repo:Payroll" }] }),
    ).toBe("payroll");
    expect(parseRepoLabel({ labels: [{ name: "bug" }] })).toBeNull();
    expect(parseRepoLabel({})).toBeNull();
  });
});
