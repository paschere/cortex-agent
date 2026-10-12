import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MODULES } from '@cortex/agent-tools/src/modules/catalog';
import { describe, expect, it } from 'vitest';
import { grantedForAgent, grantedToolIdsFor } from './granted-tools';

const ALL_MODULES = new Set(MODULES.map((m) => m.key));
const ROOT = join(__dirname, '..');

describe('lo concedido a una superficie', () => {
  const base = {
    allowedTools: ['research.*', 'kb.*', 'web.*'],
    denied: [],
    modulesOn: ALL_MODULES,
  };

  it('incluye research.parallel cuando el agente tiene la familia', () => {
    const ids = grantedToolIdsFor(base);
    expect(ids).toContain('research.parallel');
    expect(ids.length).toBeGreaterThan(2);
  });

  it('el agente que no tiene research no concede research.parallel', () => {
    expect(grantedToolIdsFor({ ...base, allowedTools: ['kb.*'] })).not.toContain(
      'research.parallel',
    );
  });

  it('los denegados de los equipos restan (patrón de familia o herramienta exacta)', () => {
    expect(grantedToolIdsFor({ ...base, denied: ['research.*'] })).not.toContain(
      'research.parallel',
    );
    expect(grantedToolIdsFor({ ...base, denied: ['research.parallel'] })).not.toContain(
      'research.parallel',
    );
    expect(grantedToolIdsFor({ ...base, denied: ['research.parallel'] })).toContain(
      'kb.search',
    );
  });

  it('las familias silenciadas y el techo de la superficie sólo restan', () => {
    const muted = grantedToolIdsFor({ ...base, mutedFamilies: new Set(['research']) });
    expect(muted).not.toContain('research.parallel');
    const ceiling = grantedToolIdsFor({ ...base, extraFilter: (t) => !t.id.startsWith('kb.') });
    expect(ceiling.some((id) => id.startsWith('kb.'))).toBe(false);
    expect(ceiling).toContain('research.parallel');
  });

  it('MCP: lo concedido se acota al agente que atribuye la llamada', () => {
    const entries = [
      { agentId: 'cortex', tool: { id: 'research.parallel' } },
      { agentId: 'cortex', tool: { id: 'kb.search' } },
      { agentId: 'ventas', tool: { id: 'crm.lookup' } },
    ];
    expect(grantedForAgent(entries, 'cortex')).toEqual(['research.parallel', 'kb.search']);
    expect(grantedForAgent(entries, 'ventas')).toEqual(['crm.lookup']);
    expect(grantedForAgent(entries, 'otro')).toEqual([]);
  });
});

/**
 * Cada superficie que corre al agente con herramientas tiene que entregarle a
 * `runTool` su `grantedToolIds`; si una se olvida, research.parallel queda sin
 * herramientas ahí (falla cerrado) y nadie lo nota. Se comprueba leyendo el
 * código, como `tenancy.test.ts`: la lista de superficies es la que existe hoy.
 * `chat/global` NO está: sólo ofrece lecturas fijas y nunca research.parallel.
 */
describe('cada superficie pasa grantedToolIds a runTool', () => {
  const SURFACES: Array<[string, string]> = [
    ['chat web', 'app/api/chat/route.ts'],
    ['MCP', 'app/api/mcp/route.ts'],
    ['rutinas y programaciones', 'inngest/functions/schedule-run.ts'],
    ['tareas en segundo plano', 'lib/background-tasks/run.ts'],
    ['Chat de Google y WhatsApp', 'app/api/chat-app/google/turn.ts'],
    ['automatizaciones de aplicaciones', 'lib/apps/automation-ask-cortex.ts'],
    ['orquestador', 'lib/orchestrator/executor.ts'],
  ];
  for (const [name, file] of SURFACES) {
    it(name, () => {
      const src = readFileSync(join(ROOT, file), 'utf8');
      expect(src).toMatch(/grantedToolIds/);
      // No se calcula con una lista fija: sale de lo filtrado por la propia superficie.
      expect(src).not.toMatch(/grantedToolIds:\s*\[\s*['"]/);
    });
  }
});
