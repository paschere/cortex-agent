import { describe, expect, it } from 'vitest';
// Through the barrel, not through `../../registry`: importing the leaf module
// gives an EMPTY registry (nothing has registered yet), and the collision test
// below would then pass by testing nothing at all.
import { listTools } from '../../index';
import { rankTools, toolFamily } from '../../tool-selection';
import { DefinitionSchema, checkDefinition, confirmationPosture } from '../definition';
import { customToolDef } from '../tool-def';
import { CUSTOM_TOOL_FAMILY, CUSTOM_TOOL_PREFIX } from '../types';
import type { CustomToolRow } from '../types';

function definition(overrides: Record<string, unknown> = {}) {
  return DefinitionSchema.parse({
    slug: 'consultar_guia',
    name: 'Consultar guía',
    description: 'Úsala cuando pregunten por el estado de una guía.',
    fields: [{ name: 'guia', type: 'string', required: true, description: 'Número de guía' }],
    method: 'GET',
    urlTemplate: 'https://erp.example.com/guias/{{guia}}',
    ...overrides,
  });
}

describe('checkDefinition', () => {
  it('accepts a sound definition', () => {
    expect(checkDefinition(definition())).toEqual([]);
  });

  it('catches a placeholder that names no field — the typo nobody finds later', () => {
    const problems = checkDefinition(
      definition({ urlTemplate: 'https://erp.example.com/guias/{{guai}}' }),
    );
    expect(problems.join(' ')).toMatch(/\{\{guai\}\}/);
  });

  it('refuses an internal destination at save time', () => {
    expect(
      checkDefinition(
        definition({ urlTemplate: 'http://localhost:3000/x', allowInsecureHttp: true }),
      ).join(' '),
    ).toMatch(/interno/);
    expect(
      checkDefinition(definition({ urlTemplate: 'https://169.254.169.254/x' })).join(' '),
    ).toMatch(/privada/);
  });

  it('refuses plain http unless it was turned on deliberately', () => {
    expect(
      checkDefinition(definition({ urlTemplate: 'http://erp.example.com/x' })).join(' '),
    ).toMatch(/https/);
    expect(
      checkDefinition(
        definition({ urlTemplate: 'http://erp.example.com/x', allowInsecureHttp: true }),
      ),
    ).toEqual([]);
  });

  it('refuses a variable HOST, which would make the destination check pointless', () => {
    const problems = checkDefinition(
      definition({
        fields: [{ name: 'host', type: 'string', required: true, description: 'Servidor' }],
        urlTemplate: 'https://{{host}}/guias',
      }),
    );
    expect(problems.join(' ')).toMatch(/dominio de la URL no puede tener campos variables/);
  });

  it('refuses reserved and malformed header names', () => {
    expect(checkDefinition(definition({ headers: { Host: 'x' } })).join(' ')).toMatch(/Cortex/);
    expect(checkDefinition(definition({ headers: { 'Bad Name': 'x' } })).join(' ')).toMatch(
      /nombre de cabecera/,
    );
  });

  it('refuses a header value carrying a line break', () => {
    expect(checkDefinition(definition({ headers: { 'X-A': 'a\r\nX-B: c' } })).join(' ')).toMatch(
      /saltos de línea/,
    );
  });

  it('rejects a slug that could collide with a registry family', () => {
    expect(DefinitionSchema.safeParse({ ...definition(), slug: 'gmail.send' }).success).toBe(false);
    expect(DefinitionSchema.safeParse({ ...definition(), slug: 'Guías' }).success).toBe(false);
  });
});

describe('confirmationPosture', () => {
  it('gates a write by default', () => {
    expect(confirmationPosture({ method: 'POST' }).requiresConfirmation).toBe(true);
    expect(confirmationPosture({ method: 'DELETE' }).requiresConfirmation).toBe(true);
  });

  it('leaves a read ungated by default', () => {
    expect(confirmationPosture({ method: 'GET' }).requiresConfirmation).toBe(false);
  });

  it('lets an admin turn it off, and says out loud what that means', () => {
    const posture = confirmationPosture({ method: 'POST', requiresConfirmation: false });
    expect(posture.requiresConfirmation).toBe(false);
    expect(posture.warning).toMatch(/SIN confirmación/);
    expect(posture.warning).toMatch(/rutinas programadas/);
  });
});

describe('the reserved namespace', () => {
  it('no registry tool may live under custom.', () => {
    const collisions = listTools().filter((t) => t.id.startsWith(CUSTOM_TOOL_PREFIX));
    expect(collisions.map((t) => t.id)).toEqual([]);
  });

  it('no registry family is called "custom", so the AI SDK names cannot collide either', () => {
    const families = new Set(listTools().map((t) => t.id.split('.')[0]));
    expect(families.has(CUSTOM_TOOL_FAMILY)).toBe(false);
  });
});

describe('reachability without a deploy', () => {
  const row = {
    id: 'ct-1',
    organization_id: 'org-1',
    slug: 'consultar_guia',
    name: 'Consultar guía',
    description: 'Úsala cuando pregunten por el estado de una guía.',
    input_schema: { fields: [] },
    http_method: 'GET',
    url_template: 'https://erp.example.com/g',
    headers: {},
    body_encoding: 'none',
    body_template: null,
    auth_type: 'none',
    auth_header_name: null,
    auth_username: null,
    auth_secret_encrypted: null,
    response_path: null,
    response_max_chars: 8000,
    timeout_ms: 5000,
    allow_insecure_http: false,
    follow_redirects: false,
    requires_confirmation: false,
    rate_limit_per_minute: 20,
    enabled: true,
  } satisfies CustomToolRow;

  it('reports the custom family to tool selection', () => {
    const tool = customToolDef(row);
    expect(toolFamily({ id: tool.id, description: tool.description })).toBe(CUSTOM_TOOL_FAMILY);
  });

  it('a tool created minutes ago, with no vector yet, is still offered to the model', () => {
    // The property tool-selection promises and this feature depends on: a tool
    // nobody has embedded is UNRANKABLE, not irrelevant, so it travels while
    // the backfill catches up. Without it a company would define a tool and
    // find the agent could not see it until some background job had run.
    const tool = customToolDef(row);
    const others = Array.from({ length: 12 }, (_, i) => ({
      id: `gmail.tool_${i}`,
      description: 'correo',
    }));
    const ranked = rankTools({
      tools: [
        { id: tool.id, description: tool.description, family: CUSTOM_TOOL_FAMILY },
        ...others,
      ],
      queryVector: [1, 0],
      // Everything else is indexed; the custom tool is not.
      vectors: new Map(others.map((o) => [o.id, [0, 1] as readonly number[]])),
      alwaysFamilies: new Set<string>(),
    });
    expect(ranked.unrankedFamilies).toContain(CUSTOM_TOOL_FAMILY);
    expect(ranked.tools.map((t) => t.id)).toContain(tool.id);
  });
});
