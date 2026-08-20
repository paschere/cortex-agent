import { describe, expect, it } from 'vitest';
import {
  type ActionPolicyContext,
  evaluateActionPolicy,
  parseActionPolicy,
} from '../action-policy';
import { actionPolicyFromRows } from '../store';

/**
 * El motor CEL fijado por sus tres promesas: deny gana a allow, una expresión
 * rota falla cerrado en la dirección segura de su lista, y dry-run decide y
 * registra pero deja pasar todo.
 */

const CTX: ActionPolicyContext = {
  tool: { id: 'gmail.send_message', family: 'gmail' },
  surface: 'web',
  user: { id: 'user-1' },
  agent: { id: 'agent-1' },
  risk: {
    level: 'medium',
    sensitivity: 'client',
    blastRadius: 'external_send',
    signals: ['external-recipient'],
  },
  confirmed: false,
};

describe('evaluateActionPolicy', () => {
  it('deny gana a allow, siempre', () => {
    const d = evaluateActionPolicy(
      { mode: 'enforce', deny: ['tool.family == "gmail"'], allow: ['true'] },
      CTX,
    );
    expect(d.allowed).toBe(false);
    expect(d.source).toBe('deny');
    expect(d.forward).toBe(false);
    expect(d.matched).toBe('tool.family == "gmail"');
  });

  it('allow explícito permite lo no denegado', () => {
    const d = evaluateActionPolicy(
      { mode: 'enforce', deny: ['tool.family == "payments"'], allow: ['true'] },
      CTX,
    );
    expect(d.allowed).toBe(true);
    expect(d.forward).toBe(true);
    expect(d.source).toBe('allow');
  });

  it('sin allow que case aplica el suelo: rechazada', () => {
    const d = evaluateActionPolicy(
      { mode: 'enforce', deny: [], allow: ['tool.family == "kb"'] },
      CTX,
    );
    expect(d.allowed).toBe(false);
    expect(d.source).toBe('default');
    expect(d.forward).toBe(false);
  });

  it('dry-run decide igual pero deja pasar (forward true)', () => {
    const denied = evaluateActionPolicy(
      { mode: 'dry-run', deny: ['tool.family == "gmail"'], allow: ['true'] },
      CTX,
    );
    expect(denied.allowed).toBe(false);
    expect(denied.forward).toBe(true);

    const floor = evaluateActionPolicy({ mode: 'dry-run', deny: [], allow: ['false'] }, CTX);
    expect(floor.allowed).toBe(false);
    expect(floor.forward).toBe(true);
  });

  it('un deny roto sigue negando; un allow roto no concede', () => {
    const broken = 'this is not CEL ((';
    const viaDeny = evaluateActionPolicy({ mode: 'enforce', deny: [broken], allow: ['true'] }, CTX);
    expect(viaDeny.allowed).toBe(false);
    expect(viaDeny.source).toBe('deny');

    const viaAllow = evaluateActionPolicy({ mode: 'enforce', deny: [], allow: [broken] }, CTX);
    expect(viaAllow.allowed).toBe(false);
    expect(viaAllow.source).toBe('default');
  });

  it('el contexto de riesgo es expresable: señales, radio, superficie', () => {
    const rule =
      'risk.blastRadius == "external_send" && contains(risk.signals, "external-recipient") && surface == "web"';
    const d = evaluateActionPolicy({ mode: 'enforce', deny: [rule], allow: ['true'] }, CTX);
    expect(d.allowed).toBe(false);
  });

  it('contains es case-insensitive y matches acepta regex', () => {
    expect(
      evaluateActionPolicy(
        { mode: 'enforce', deny: ['contains(tool.id, "SEND_MESSAGE")'], allow: ['true'] },
        CTX,
      ).allowed,
    ).toBe(false);
    expect(
      evaluateActionPolicy(
        { mode: 'enforce', deny: ['matches(tool.id, "^gmail[.]")'], allow: ['true'] },
        CTX,
      ).allowed,
    ).toBe(false);
  });

  it('un regex imparseable en deny falla cerrado', () => {
    const d = evaluateActionPolicy(
      { mode: 'enforce', deny: ['matches(tool.id, "([")'], allow: ['true'] },
      CTX,
    );
    expect(d.allowed).toBe(false);
  });
});

describe('parseActionPolicy', () => {
  it('allow ausente equivale a ["true"] — un primer deny no inutiliza el workspace', () => {
    const r = parseActionPolicy({ mode: 'dry-run', deny: ['tool.family == "payments"'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.policy.allow).toEqual(['true']);
  });

  it('rechaza en vez de coaccionar: modo inválido, listas no-string, vacíos', () => {
    expect(parseActionPolicy({ mode: 'observar', deny: [] }).ok).toBe(false);
    expect(parseActionPolicy({ mode: 'enforce', deny: [42] }).ok).toBe(false);
    expect(parseActionPolicy({ mode: 'enforce', deny: ['  '] }).ok).toBe(false);
    expect(parseActionPolicy(null).ok).toBe(false);
    expect(parseActionPolicy(['enforce']).ok).toBe(false);
  });
});

describe('actionPolicyFromRows', () => {
  it('sin fila action_policy el motor queda apagado (null)', () => {
    expect(actionPolicyFromRows([{ key: 'block_critical', value: true }])).toBeNull();
    expect(actionPolicyFromRows(null)).toBeNull();
  });

  it('una fila malformada (editada por SQL) también es null, no una política a medias', () => {
    expect(actionPolicyFromRows([{ key: 'action_policy', value: { mode: 'yes' } }])).toBeNull();
  });

  it('una fila válida enciende el motor', () => {
    const p = actionPolicyFromRows([
      { key: 'action_policy', value: { mode: 'enforce', deny: ['tool.family == "payments"'] } },
    ]);
    expect(p).toEqual({ mode: 'enforce', deny: ['tool.family == "payments"'], allow: ['true'] });
  });
});
