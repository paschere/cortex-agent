import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Logger } from '@cortex/core';
import { encryptToken } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it } from 'vitest';
import { classify, decide } from '../../security/policy';
import { createOrgScopedClient } from '../../tenancy/scoped-client';
import { type Row, makeDb } from '../../whatsapp/__tests__/fake-db';
import { canRunFlow } from '../access';
import { classifyFailure, hasLoginSteps } from '../classify';
import { runFlow } from '../execute';
import { REDACTED, enforceSecrets, redactValue, safeInputs } from '../redact';
import { mergeTargets, refineFromDom } from '../refine';
import { STEP_ACTIONS, TARGET_KINDS, stepSchema } from '../types';
import {
  ORG,
  OTHER_ORG,
  PLATE_FLOW_STEPS,
  USER,
  capturingLogger,
  emptySnapshot,
  evidence,
  failedAt,
  forbiddenRepairer,
  makeFlow,
  scriptedTransport,
  step,
  succeeded,
} from './fixtures';

/**
 * The five properties this module has to have, and one that keeps the copied
 * wire types honest.
 *
 * Everything here drives the REAL orchestrator (`execute.runFlow`) through a
 * scripted transport. Nothing asserts that a function was called; every
 * assertion is about a row that was or was not written.
 */

const KEY = 'Ao9v3nQ0ZK7mXn2bR5tY8uI1oP4aS6dF9gH0jK2lM3Q=';

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = KEY;
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://localhost:54321';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service';
  process.env.SUPABASE_DB_URL = 'postgres://localhost:54322/postgres';
  process.env.APP_BASE_URL = 'http://localhost:3000';
  process.env.GOOGLE_CLIENT_ID = 'x';
  process.env.GOOGLE_CLIENT_SECRET = 'x';
  process.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/cb';
});

function db(store: Record<string, Row[]>): SupabaseClient {
  return makeDb(store);
}

const silent = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as Logger;

function baseStore(): Record<string, Row[]> {
  return {
    browser_flows: [],
    browser_flow_versions: [],
    browser_flow_grants: [],
    browser_flow_runs: [],
    browser_flow_run_steps: [],
    browser_credentials: [],
  };
}

// ---------------------------------------------------------------------------
// 1. A replay does not call the model.
// ---------------------------------------------------------------------------

describe('replaying a learned errand', () => {
  it('runs the whole flow without a single model call', async () => {
    const store = baseStore();
    const flow = makeFlow();
    store.browser_flows = [{ id: flow.id, organization_id: ORG }];
    const transport = scriptedTransport([succeeded(flow.steps, { estado: 'ACTIVO' })]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'ABC123' },
      transport,
      logger: silent,
      trigger: 'chat',
      // Anything that reaches the model on a successful replay fails the test
      // here rather than in production.
      repairer: forbiddenRepairer,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.output).toEqual({ estado: 'ACTIVO' });
    expect(outcome.spend.calls).toBe(0);
    expect(outcome.spend.costUsd).toBe(0);

    // And the row says so, which is what the comparison in the ops doc reads.
    const run = (store.browser_flow_runs as Row[])[0] as Row;
    expect(run.mode).toBe('replay');
    expect(run.status).toBe('succeeded');
    expect(run.model_calls).toBe(0);
    expect(run.model_cost_usd).toBe(0);

    // Every step is in the audit trail, in order.
    expect((store.browser_flow_run_steps as Row[]).length).toBe(flow.steps.length);
  });

  it('substitutes the variable rather than replaying the value that was taught', async () => {
    const store = baseStore();
    const flow = makeFlow();
    const transport = scriptedTransport([succeeded(flow.steps)]);

    await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'XYZ789' },
      transport,
      logger: silent,
      trigger: 'manual',
      repairer: forbiddenRepairer,
    });

    // The template travels intact to the service, with the run's inputs beside
    // it -- that is what makes one recording serve every plate.
    expect(transport.calls[0]?.steps[1]?.value).toEqual({ kind: 'template', text: '{{placa}}' });
    expect(transport.calls[0]?.inputs).toEqual({ placa: 'XYZ789' });
  });

  it('absorbs a moved selector by promoting the one that still works, with no model', async () => {
    const store = baseStore();
    const flow = makeFlow();
    // Every step matched on its SECOND candidate: the portal was restyled and
    // the preferred locators stopped resolving.
    const transport = scriptedTransport([succeeded(flow.steps, {}, 1)]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'ABC123' },
      transport,
      logger: silent,
      trigger: 'manual',
      repairer: forbiddenRepairer,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.spend.calls).toBe(0);
    const version = (store.browser_flow_versions as Row[])[0] as Row;
    expect(version.reason).toBe('drifted');
    const fillStep = (version.steps as (typeof PLATE_FLOW_STEPS)[number][])[1];
    expect(fillStep?.targets[0]).toEqual({ kind: 'name', value: 'txtPlaca' });
  });
});

// ---------------------------------------------------------------------------
// 2. A changed site is repaired, and the repair sticks.
// ---------------------------------------------------------------------------

describe('when the portal changes', () => {
  const movedButton = emptySnapshot({
    headings: ['Consulta de vehículos'],
    elements: [
      {
        ref: 'e7',
        role: 'button',
        name: 'Consultar placa',
        tag: 'button',
        type: null,
        targets: [{ kind: 'role', value: 'button', name: 'Consultar placa' }],
        disabled: false,
        value: null,
      },
    ],
  });

  it('finds the element again, finishes the errand and writes a new version', async () => {
    const store = baseStore();
    const flow = makeFlow();
    store.browser_flows = [{ id: flow.id, organization_id: ORG, version: 1 }];

    const transport = scriptedTransport([
      failedAt(
        flow.steps,
        2,
        evidence({
          candidates: [{ kind: 'role', value: 'button[Consultar]', matches: 0 }],
        }),
        movedButton,
      ),
      succeeded(flow.steps, { estado: 'ACTIVO' }),
    ]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'ABC123' },
      transport,
      logger: silent,
      repairer: async () => ({
        targets: [{ kind: 'role', value: 'button', name: 'Consultar placa' }],
        note: 'El botón ahora dice «Consultar placa».',
        spend: { calls: 1, inputTokens: 1_800, outputTokens: 90, costUsd: 0.0068 },
      }),
      trigger: 'manual',
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.repaired).toBe(true);
    expect(outcome.newVersion).toBe(2);

    // The flow itself now carries the fix -- the whole point. A repair that
    // only fixed this one run would be paid for again tomorrow.
    const saved = (store.browser_flows as Row[])[0] as Row;
    expect(saved.version).toBe(2);
    const savedSteps = saved.steps as (typeof PLATE_FLOW_STEPS)[number][];
    expect(savedSteps[2]?.targets[0]?.name).toBe('Consultar placa');

    const version = (store.browser_flow_versions as Row[])[0] as Row;
    expect(version.reason).toBe('repaired');
    expect(version.changed_step).toBe(2);

    // Two run rows: the replay that cost nothing and failed, and the repair
    // that cost something and worked.
    const runs = store.browser_flow_runs as Row[];
    expect(runs).toHaveLength(2);
    expect(runs[0]?.mode).toBe('replay');
    expect(runs[0]?.failure_kind).toBe('site-changed');
    expect(runs[0]?.model_calls).toBe(0);
    expect(runs[1]?.mode).toBe('repair');
    expect(runs[1]?.model_calls).toBe(1);
    expect(runs[1]?.updated_flow).toBe(true);
  });

  it('leaves the flow exactly as it was when the repaired steps still fail', async () => {
    const store = baseStore();
    const flow = makeFlow();
    store.browser_flows = [{ id: flow.id, organization_id: ORG, version: 1, steps: flow.steps }];

    const transport = scriptedTransport([
      failedAt(
        flow.steps,
        2,
        evidence({ candidates: [{ kind: 'role', value: 'x', matches: 0 }] }),
        movedButton,
      ),
      // The model's answer did not survive contact with the site.
      failedAt(
        flow.steps,
        3,
        evidence({ candidates: [{ kind: 'role', value: 'y', matches: 0 }] }),
        movedButton,
      ),
    ]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'ABC123' },
      transport,
      logger: silent,
      repairer: async () => ({
        targets: [{ kind: 'role', value: 'button', name: 'Consultar placa' }],
        note: 'una conjetura',
        spend: { calls: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.0004 },
      }),
      trigger: 'manual',
    });

    expect(outcome.ok).toBe(false);
    // NOT saved. A version written on the strength of the model having answered
    // would leave a wrong flow looking fixed, which is worse than broken.
    expect(store.browser_flow_versions).toHaveLength(0);
    const saved = (store.browser_flows as Row[])[0] as Row;
    expect(saved.version).toBe(1);
    expect(saved.status).toBe('broken');
  });
});

// ---------------------------------------------------------------------------
// 3. A legitimate failure never reaches the model.
// ---------------------------------------------------------------------------

describe('when the errand simply fails', () => {
  const cases: {
    name: string;
    ev: ReturnType<typeof evidence>;
    snapshot?: ReturnType<typeof emptySnapshot>;
  }[] = [
    {
      name: 'the plate does not exist',
      ev: evidence({
        alertText: 'No se encontró información para la placa consultada.',
        candidates: [{ kind: 'role', value: 'table', matches: 0 }],
      }),
    },
    {
      name: 'the password was rejected',
      ev: evidence({
        alertText: 'Usuario o contraseña incorrectos.',
        candidates: [{ kind: 'role', value: 'link', matches: 0 }],
      }),
    },
    {
      name: 'the session expired and we are back at the login form',
      ev: evidence({
        landmarksPresent: 0,
        candidates: [{ kind: 'role', value: 'button', matches: 0 }],
      }),
      snapshot: emptySnapshot({
        title: 'Ingreso',
        elements: [
          {
            ref: 'e1',
            role: 'textbox',
            name: 'Contraseña',
            tag: 'input',
            type: 'password',
            targets: [{ kind: 'label', value: 'Contraseña' }],
            disabled: false,
            value: '***',
          },
        ],
      }),
    },
    {
      name: 'the portal is down for maintenance',
      ev: evidence({
        bodyTextSample: 'El servicio se encuentra en mantenimiento. Intente más tarde.',
        candidates: [{ kind: 'role', value: 'button', matches: 0 }],
      }),
    },
    {
      name: 'the server threw a 502',
      ev: evidence({
        httpStatus: 502,
        candidates: [{ kind: 'role', value: 'button', matches: 0 }],
      }),
    },
  ];

  for (const testCase of cases) {
    it(`does not repair the flow when ${testCase.name}`, async () => {
      const store = baseStore();
      const flow = makeFlow();
      store.browser_flows = [{ id: flow.id, organization_id: ORG, version: 1, status: 'ready' }];

      const transport = scriptedTransport([
        failedAt(flow.steps, 2, testCase.ev, testCase.snapshot ?? emptySnapshot()),
      ]);

      const outcome = await runFlow({
        db: db(store),
        organizationId: ORG,
        actor: { id: USER, role: 'member' },
        flow,
        inputs: { placa: 'ABC123' },
        transport,
        logger: silent,
        // If the classifier gets this wrong, the model is called and this
        // throws. That is the assertion.
        repairer: forbiddenRepairer,
        trigger: 'manual',
      });

      expect(outcome.ok).toBe(false);
      expect(outcome.failureKind).not.toBe('site-changed');
      expect(outcome.spend.calls).toBe(0);
      // Only one attempt was made, and the flow was not touched.
      expect(transport.calls).toHaveLength(1);
      expect(store.browser_flow_versions).toHaveLength(0);
      const saved = (store.browser_flows as Row[])[0] as Row;
      expect(saved.version).toBe(1);
      expect(saved.status).toBe('ready');
    });
  }

  it('names the rule it used, so a wrong verdict is debuggable', () => {
    expect(
      classifyFailure({
        evidence: evidence({ alertText: 'No existe el documento' }),
        snapshot: emptySnapshot(),
        step: step({ label: 'Consultar' }),
      }).rule,
    ).toBe('refusal-text');

    expect(
      classifyFailure({
        evidence: evidence({ candidates: [{ kind: 'role', value: 'b', matches: 0 }] }),
        snapshot: emptySnapshot(),
        step: step({ label: 'Consultar' }),
      }),
    ).toMatchObject({ kind: 'site-changed', rule: 'element-moved' });

    // A login step failing against a login page is the credential being wrong,
    // and must NOT be read as "we bounced to login".
    expect(
      classifyFailure({
        evidence: evidence({ candidates: [{ kind: 'label', value: 'Clave', matches: 0 }] }),
        snapshot: emptySnapshot({
          elements: [
            {
              ref: 'e1',
              role: 'textbox',
              name: 'Clave',
              tag: 'input',
              type: 'password',
              targets: [],
              disabled: false,
              value: '***',
            },
          ],
        }),
        step: step({ label: 'Escribir la clave', value: { kind: 'secret', field: 'clave' } }),
      }).kind,
    ).toBe('site-changed');
  });
});

// ---------------------------------------------------------------------------
// 3b. A bot check is not a redesign.
//
// This block exists because of a real, reproduced, recurring bill. Google
// answers an automated browser with /sorry/index; that page carries none of the
// flow's elements, so every stored candidate reports zero matches — the exact
// signature of `element-moved`. The flow was filed as `site-changed`, which is
// the only verdict that lets a model rewrite a flow, so Cortex paid for a
// repair against a captcha page, every run, forever.
// ---------------------------------------------------------------------------

describe('a portal asking whether we are a robot', () => {
  /** What the real /sorry/index page says, verbatim. */
  const GOOGLE_SORRY =
    'Acerca de esta página Nuestros sistemas han detectado tráfico inusual procedente de tu red ' +
    'de ordenadores. En esta página se comprueba si eres tú quien envía las solicitudes en lugar ' +
    'de un robot.';

  /** Everything a bot check looks like from the outside: nothing matches. */
  const nothingMatched = { candidates: [{ kind: 'role' as const, value: 'combobox', matches: 0 }] };

  it('is never site-changed, so no model is ever let near the flow', () => {
    const verdict = classifyFailure({
      evidence: evidence({
        ...nothingMatched,
        url: 'https://www.google.com/sorry/index?continue=https://www.google.com/search',
        bodyTextSample: GOOGLE_SORRY,
      }),
      snapshot: emptySnapshot(),
      step: step({ label: 'Presionar Enter para buscar' }),
    });
    expect(verdict.kind).toBe('needs-human');
    expect(verdict.kind).not.toBe('site-changed');
  });

  it('is recognised by the widget, by the address and by the words, separately', () => {
    // The widget alone — a page in a language we do not list, or an image with
    // no text at all.
    expect(
      classifyFailure({
        evidence: evidence({ ...nothingMatched, challengeFrames: 1, bodyTextSample: '' }),
        snapshot: emptySnapshot(),
        step: step({ label: 'Consultar' }),
      }).rule,
    ).toBe('bot-check:widget');

    // The address alone — Cloudflare's interstitial.
    expect(
      classifyFailure({
        evidence: evidence({
          ...nothingMatched,
          url: 'https://portal.test/cdn-cgi/challenge-platform/h/b/orchestrate',
          bodyTextSample: '',
        }),
        snapshot: emptySnapshot(),
        step: step({ label: 'Consultar' }),
      }).rule,
    ).toBe('bot-check:url');

    // The words alone.
    expect(
      classifyFailure({
        evidence: evidence({ ...nothingMatched, bodyTextSample: GOOGLE_SORRY }),
        snapshot: emptySnapshot(),
        step: step({ label: 'Consultar' }),
      }).rule,
    ).toBe('bot-check:text');
  });

  it('does not steal the case where somebody typed a captcha wrong', () => {
    // "captcha incorrecto" is an ordinary refusal: the flow is fine, the answer
    // was no, and nothing needs a person to come and unlock anything. This is
    // why the phrase list never contains a bare "captcha".
    const verdict = classifyFailure({
      evidence: evidence({ alertText: 'El captcha incorrecto, intente de nuevo' }),
      snapshot: emptySnapshot(),
      step: step({ label: 'Consultar' }),
    });
    expect(verdict.kind).toBe('legitimate');
    expect(verdict.rule).toBe('refusal-text');
  });

  it('still believes a site that says it is down', () => {
    // Rule 3 stays above this one: "en mantenimiento" is transient and retrying
    // is right, even on a page that also happens to carry a challenge widget.
    expect(
      classifyFailure({
        evidence: evidence({
          ...nothingMatched,
          challengeFrames: 1,
          bodyTextSample: 'El portal está en mantenimiento.',
        }),
        snapshot: emptySnapshot(),
        step: step({ label: 'Consultar' }),
      }).kind,
    ).toBe('transient');
  });

  it('an ordinary missing element is still site-changed', () => {
    // The guard in the other direction: this rule must not swallow the case
    // repair exists for.
    expect(
      classifyFailure({
        evidence: evidence(nothingMatched),
        snapshot: emptySnapshot(),
        step: step({ label: 'Consultar' }),
      }),
    ).toMatchObject({ kind: 'site-changed', rule: 'element-moved' });
  });
});

// ---------------------------------------------------------------------------
// 4. A credential never appears anywhere it should not.
// ---------------------------------------------------------------------------

describe('credentials', () => {
  const SECRET = 'Sup3r-S3creta-2026';

  it('reaches the browser service and nothing else', async () => {
    const store = baseStore();
    const loginStep = step({
      action: 'fill',
      label: 'Contraseña',
      targets: [{ kind: 'label', value: 'Contraseña' }],
      value: { kind: 'secret', field: 'clave' },
    });
    const steps = [PLATE_FLOW_STEPS[0] as (typeof PLATE_FLOW_STEPS)[number], loginStep];
    const flow = makeFlow({ steps, credentialId: 'cred-1' });

    store.browser_credentials = [
      {
        id: 'cred-1',
        organization_id: ORG,
        label: 'Portal',
        host: 'https://portal.test',
        field_names: ['clave'],
        secret_encrypted: encryptToken(JSON.stringify({ clave: SECRET })),
      },
    ];
    store.browser_flows = [{ id: flow.id, organization_id: ORG }];

    const captured = capturingLogger();
    const transport = scriptedTransport([succeeded(steps)]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'admin' },
      flow,
      // A caller trying to smuggle the password in as a variable is filtered
      // out too: `clave` is not a declared variable of this flow.
      inputs: { placa: 'ABC123', clave: SECRET },
      transport,
      logger: captured.logger as Logger,
      trigger: 'manual',
      repairer: forbiddenRepairer,
    });
    expect(outcome.ok).toBe(true);

    // Where it IS: exactly one place, the request to the service.
    expect(transport.calls[0]?.secrets).toEqual({ clave: SECRET });

    // Where it is NOT: every row this run wrote, and every log line.
    const everythingPersisted = JSON.stringify([
      store.browser_flows,
      store.browser_flow_runs,
      store.browser_flow_run_steps,
      store.browser_flow_versions,
    ]);
    expect(everythingPersisted).not.toContain(SECRET);
    expect(captured.lines.join('\n')).not.toContain(SECRET);

    // The trace shows a fixed marker, not a mask of the real value -- a length
    // is a leak too.
    const traced = (store.browser_flow_run_steps as Row[]).find((r) => r.label === 'Contraseña');
    expect(traced?.value_preview).toBe('***');

    // And the run's recorded inputs kept only the declared variable.
    expect((store.browser_flow_runs as Row[])[0]?.inputs).toEqual({ placa: 'ABC123' });
  });

  it('refuses to unlock a login for a different site than the flow opens', async () => {
    const store = baseStore();
    const flow = makeFlow({
      credentialId: 'cred-1',
      startUrl: 'https://evil.test/x',
      host: 'https://evil.test',
    });
    store.browser_credentials = [
      {
        id: 'cred-1',
        organization_id: ORG,
        host: 'https://portal.test',
        secret_encrypted: encryptToken(JSON.stringify({ clave: SECRET })),
      },
    ];
    const transport = scriptedTransport([succeeded(flow.steps)]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'admin' },
      flow,
      inputs: { placa: 'ABC123' },
      transport,
      logger: silent,
      trigger: 'manual',
      repairer: forbiddenRepairer,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('otro sitio');
    // Nothing ran at all.
    expect(transport.calls).toHaveLength(0);
  });

  it('redacts by constant, never by transformation', () => {
    expect(redactValue({ kind: 'secret', field: 'clave' }, {})).toBe(REDACTED);
    expect(REDACTED).not.toContain(SECRET.slice(0, 1));
    expect(safeInputs({ placa: 'ABC', clave: SECRET }, ['placa'])).toEqual({ placa: 'ABC' });
  });

  it('rewrites a credential field the extractor transcribed anyway', () => {
    const { steps, redacted } = enforceSecrets([
      step({ action: 'fill', label: 'Contraseña', value: { kind: 'literal', text: SECRET } }),
      step({
        action: 'fill',
        label: 'Número de placa',
        value: { kind: 'template', text: '{{placa}}' },
      }),
    ]);
    expect(redacted).toBe(1);
    expect(steps[0]?.value).toEqual({ kind: 'secret', field: 'contrasena' });
    expect(JSON.stringify(steps)).not.toContain(SECRET);
    // And it left the ordinary field alone.
    expect(steps[1]?.value).toEqual({ kind: 'template', text: '{{placa}}' });
  });
});

// ---------------------------------------------------------------------------
// 5. One workspace cannot run another's errand.
// ---------------------------------------------------------------------------

describe('isolation', () => {
  it('cannot even see a flow that belongs to another workspace', async () => {
    const store = baseStore();
    store.browser_flows = [
      { id: 'flow-acme', organization_id: ORG, slug: 'consulta-placa', steps: [], variables: [] },
      {
        id: 'flow-globex',
        organization_id: OTHER_ORG,
        slug: 'consulta-placa',
        steps: [],
        variables: [],
      },
    ];

    const acme = createOrgScopedClient(db(store), ORG);
    const { getFlow, getFlowBySlug, listFlows } = await import('../store');

    expect(await getFlow(acme, 'flow-globex')).toBeNull();
    expect((await listFlows(acme)).map((f) => f.id)).toEqual(['flow-acme']);
    // The slug is the same on both rows on purpose: a lost filter returns
    // something plausible rather than nothing, which is how this bug survives.
    expect((await getFlowBySlug(acme, 'consulta-placa'))?.id).toBe('flow-acme');
  });

  it('stamps a run with the workspace that started it, not the one passed in', async () => {
    const store = baseStore();
    const flow = makeFlow();
    const scoped = createOrgScopedClient(db(store), ORG);

    await runFlow({
      db: scoped,
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'ABC123' },
      transport: scriptedTransport([succeeded(flow.steps)]),
      logger: silent,
      trigger: 'manual',
      repairer: forbiddenRepairer,
    });

    expect((store.browser_flow_runs as Row[])[0]?.organization_id).toBe(ORG);
  });
});

// ---------------------------------------------------------------------------
// Who may spend a company login
// ---------------------------------------------------------------------------

describe('access to a flow that carries a credential', () => {
  it('is open to everyone when there is no credential', async () => {
    const store = baseStore();
    const verdict = await canRunFlow(
      db(store),
      { id: USER, role: 'member' },
      {
        id: 'f',
        name: 'Consulta',
        credentialId: null,
      },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('is administrators only until somebody says otherwise', async () => {
    const store = baseStore();
    const flow = { id: 'f', name: 'Radicar', credentialId: 'cred-1' };
    expect((await canRunFlow(db(store), { id: USER, role: 'member' }, flow)).allowed).toBe(false);
    expect((await canRunFlow(db(store), { id: USER, role: 'admin' }, flow)).allowed).toBe(true);
  });

  it('opens to exactly the people and roles named', async () => {
    const store = baseStore();
    store.browser_flow_grants = [
      { id: 'g1', flow_id: 'f', subject_type: 'user', user_id: 'ana', role: null },
      { id: 'g2', flow_id: 'f', subject_type: 'role', user_id: null, role: 'contador' },
    ];
    const flow = { id: 'f', name: 'Radicar', credentialId: 'cred-1' };
    expect((await canRunFlow(db(store), { id: 'ana', role: 'member' }, flow)).allowed).toBe(true);
    expect((await canRunFlow(db(store), { id: 'ben', role: 'contador' }, flow)).allowed).toBe(true);
    expect((await canRunFlow(db(store), { id: 'ben', role: 'member' }, flow)).allowed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. A door nobody recorded is a question, not a defect.
// ---------------------------------------------------------------------------

describe('a trámite that was taught from inside a session', () => {
  const loginWall = emptySnapshot({
    title: 'Ingreso al portal',
    text: 'Debe iniciar sesión para continuar.',
    elements: [
      {
        ref: 'e1',
        role: 'textbox',
        name: 'Contraseña',
        tag: 'input',
        type: 'password',
        targets: [{ kind: 'label', value: 'Contraseña' }],
        disabled: false,
        value: '***',
      },
    ],
  });
  const atTheDoor = evidence({
    landmarksPresent: 0,
    bodyTextSample: 'Ingreso al portal. Debe iniciar sesión para continuar.',
    candidates: [{ kind: 'role', value: 'link', matches: 0 }],
  });

  it('asks for the account instead of reporting a failure, and never marks it broken', async () => {
    const store = baseStore();
    // No login steps anywhere: the recording began after the door.
    const flow = makeFlow({ status: 'draft' });
    store.browser_flows = [{ id: flow.id, organization_id: ORG, version: 1, status: 'draft' }];

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'ABC123' },
      transport: scriptedTransport([failedAt(flow.steps, 1, atTheDoor, loginWall)]),
      logger: silent,
      // A login form is the single most dangerous thing to hand a repairer: it
      // would rewrite a good errand to fill in a username box.
      repairer: forbiddenRepairer,
      trigger: 'verify',
      verifying: true,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.failureKind).toBe('needs-login');
    expect(outcome.pendingQuestion).toBe('credential');
    // It names what to do, including the part nobody guesses.
    expect(outcome.message).toContain('cerrando sesión primero');

    const saved = (store.browser_flows as Row[])[0] as Row;
    expect(saved.login_required).toBe(true);
    // Not broken, not demoted: it is propuesto and it is waiting for an answer.
    expect(saved.status).toBe('draft');
    expect(store.browser_flow_versions).toHaveLength(0);
    expect((store.browser_flow_runs as Row[])[0]?.failure_kind).toBe('needs-login');
  });

  it('does not open a browser at all once it knows the credential is missing', async () => {
    const store = baseStore();
    const flow = makeFlow({ loginRequired: true, credentialId: null });
    const transport = scriptedTransport([succeeded(flow.steps)]);

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'ABC123' },
      transport,
      logger: silent,
      trigger: 'chat',
      repairer: forbiddenRepairer,
    });

    expect(outcome.failureKind).toBe('needs-login');
    expect(transport.calls).toHaveLength(0);
    // And no run row: nothing was attempted, so there is nothing to audit.
    expect(store.browser_flow_runs).toHaveLength(0);
  });

  it('still calls a rejected credential a refusal when the flow DOES know how to log in', () => {
    const withLogin = [
      step({
        action: 'fill',
        label: 'Contraseña',
        value: { kind: 'secret', field: 'clave' },
      }),
      step({ action: 'click', label: 'Consultar' }),
    ];
    const verdict = classifyFailure({
      evidence: atTheDoor,
      snapshot: loginWall,
      step: step({ label: 'Consultar' }),
      flow: { hasCredential: true, hasLoginSteps: hasLoginSteps(withLogin) },
    });
    // The flow tried and was turned away. That is the portal answering, and the
    // old rule -- do not touch the flow -- still governs it.
    expect(verdict.kind).toBe('legitimate');
  });
});

// ---------------------------------------------------------------------------
// 7. The DOM has the last word on what things are called.
// ---------------------------------------------------------------------------

describe('refining a flow against the live page', () => {
  it('ranks by how well a locator survives, with the page winning ties', () => {
    const merged = mergeTargets(
      [
        { kind: 'name', value: 'txtPlaca' },
        { kind: 'label', value: 'Número de placa' },
        { kind: 'css', value: '#form > input' },
      ],
      [
        { kind: 'label', value: 'Numero de placa' },
        { kind: 'role', value: 'textbox', name: 'Placa' },
      ],
    );
    // role before label before name before css, regardless of who proposed it.
    expect(merged.map((t) => t.kind)).toEqual(['role', 'label', 'label', 'name', 'css']);
    // And within `label`, the page's own spelling leads.
    expect(merged[1]).toEqual({ kind: 'label', value: 'Número de placa' });
  });

  it('leaves a step that never resolved exactly as it was', () => {
    const steps = [step({ label: 'Consultar' })];
    const refined = refineFromDom(steps, [
      {
        index: 0,
        action: 'click',
        label: 'Consultar',
        url: 'u',
        matchedTarget: null,
        matchedRank: null,
        valuePreview: null,
        ok: false,
        durationMs: 1,
        observedTargets: [{ kind: 'testid', value: 'no-deberia-usarse' }],
      },
    ]);
    expect(refined.changed).toEqual([]);
    expect(refined.steps[0]?.targets).toEqual(steps[0]?.targets);
  });

  it('rewrites the flow after the proving run and keeps the proof', async () => {
    const store = baseStore();
    const flow = makeFlow({ status: 'draft', verifiedAt: null });
    store.browser_flows = [{ id: flow.id, organization_id: ORG, version: 1, status: 'draft' }];

    const outcome = await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'ABC123' },
      transport: scriptedTransport([
        succeeded(flow.steps, { estado: 'ACTIVO' }, 0, (s) =>
          s.action === 'goto' ? undefined : [{ kind: 'testid', value: `qa-${s.action}` }],
        ),
      ]),
      logger: silent,
      repairer: forbiddenRepairer,
      trigger: 'verify',
      verifying: true,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.spend.calls).toBe(0);
    expect(outcome.newVersion).toBe(2);

    const version = (store.browser_flow_versions as Row[])[0] as Row;
    expect(version.reason).toBe('refined');
    const saved = (store.browser_flows as Row[])[0] as Row;
    const savedSteps = saved.steps as (typeof PLATE_FLOW_STEPS)[number][];
    // A `data-testid` cannot be photographed; it can only come from the page.
    expect(savedSteps[1]?.targets[0]).toEqual({ kind: 'testid', value: 'qa-fill' });
    // The model's reading is kept underneath rather than thrown away.
    expect(savedSteps[1]?.targets.some((t) => t.kind === 'label')).toBe(true);
    // The verification survives: these locators came off the run that proved it.
    expect(saved.status).toBe('ready');
    expect(saved.verified_at).toBeTruthy();
  });

  it('does not rewrite an ordinary run, only the one that is still a hypothesis', async () => {
    const store = baseStore();
    const flow = makeFlow();
    await runFlow({
      db: db(store),
      organizationId: ORG,
      actor: { id: USER, role: 'member' },
      flow,
      inputs: { placa: 'ABC123' },
      transport: scriptedTransport([
        succeeded(flow.steps, {}, 0, () => [{ kind: 'testid', value: 'qa' }]),
      ]),
      logger: silent,
      repairer: forbiddenRepairer,
      trigger: 'chat',
    });
    expect(store.browser_flow_versions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8. Two things answering to one description is not a retry.
// ---------------------------------------------------------------------------

describe('when several elements match', () => {
  it('calls it site-changed so a repair can make the step specific', () => {
    const verdict = classifyFailure({
      evidence: evidence({
        // Five rows, five links that read the same. `resolveTarget` refuses to
        // guess, and no amount of waiting changes the page.
        candidates: [{ kind: 'text', value: 'Ver detalle', matches: 5 }],
        visibleButBlocked: true,
      }),
      snapshot: emptySnapshot(),
      step: step({ label: 'Abrir el detalle de la factura' }),
    });
    expect(verdict).toMatchObject({ kind: 'site-changed', rule: 'ambiguous' });
    expect(verdict.reason).toContain('5');
  });
});

// ---------------------------------------------------------------------------
// The gate, and the copy of the wire types
// ---------------------------------------------------------------------------

describe('the approval boundary', () => {
  it('classifies submitting to a third party as leaving the company', () => {
    const submit = classify({
      tool: { id: 'browser.submit_flow', description: '', requiresConfirmation: true } as never,
      input: { flow: 'radicar' },
    });
    expect(submit.blastRadius).toBe('external_send');
    // A consult still acts as the company on somebody else's system, so it is
    // a write rather than the read its verb would imply.
    const run = classify({
      tool: { id: 'browser.run_flow', description: '' } as never,
      input: { flow: 'consulta' },
    });
    expect(run.blastRadius).toBe('internal_write');
    expect(decide(run)).toBe('allow');
  });
});

describe('a step posted back from a browser', () => {
  // `JSON.stringify` omits an undefined property and serialises a null one, so
  // a form that keeps a cleared field as null — which is what a React input
  // does — sends nulls. Plain `.optional()` rejects those with a 400. That
  // mismatch has cost this repo two bugs already, one of which made the setup
  // interview fail on the first sentence of every single conversation.
  it('accepts null for every optional field, and reads it as absent', () => {
    const parsed = stepSchema.parse({
      action: 'fill',
      label: 'Número de placa',
      targets: [{ kind: 'role', value: 'textbox', name: null }],
      value: null,
      url: null,
      expect: null,
      optional: null,
      extractAs: null,
      landmarks: [],
    });

    // Normalised to undefined rather than kept as null, so the rest of the
    // module keeps reading the shape it already reads.
    expect(parsed.value).toBeUndefined();
    expect(parsed.url).toBeUndefined();
    expect(parsed.expect).toBeUndefined();
    expect(parsed.optional).toBeUndefined();
    expect(parsed.extractAs).toBeUndefined();
    expect(parsed.targets[0]?.name).toBeUndefined();
  });

  it('still accepts the fields being missing altogether', () => {
    const parsed = stepSchema.parse({ action: 'click', label: 'Consultar', targets: [] });
    expect(parsed.value).toBeUndefined();
    expect(parsed.optional).toBeUndefined();
  });
});

describe('the wire types copied into services/browser', () => {
  it('still lists the same actions and target kinds as agent-tools', () => {
    const wire = readFileSync(
      join(__dirname, '..', '..', '..', '..', '..', 'services', 'browser', 'src', 'types.ts'),
      'utf8',
    );
    // The service holds a hand-written copy so its Docker image does not have
    // to install the whole tool registry. This is what keeps the copy honest.
    for (const action of STEP_ACTIONS) expect(wire).toContain(`| '${action}'`);
    const kinds = wire.match(/export type TargetKind =([^;]+);/)?.[1] ?? '';
    for (const kind of TARGET_KINDS) expect(kinds).toContain(`'${kind}'`);
  });
});
