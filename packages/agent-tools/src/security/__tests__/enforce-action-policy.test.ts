import { describe, expect, it } from 'vitest';
import type { ActionPolicyDecision } from '../action-policy';
import { type SecurityEvaluation, blockExplanation, isIncident } from '../enforce';
import { DEFAULT_POLICY } from '../policy';

/**
 * El cableado de la política CEL en el veredicto: un deny en dry-run deja fila
 * aunque la llamada sea inocua, y un bloqueo por regla se explica nombrando la
 * regla, no con la genérica de la matriz.
 */

function evaluation(overrides: Partial<SecurityEvaluation> = {}): SecurityEvaluation {
  return {
    classification: {
      riskLevel: 'low',
      reason: 'nada raro',
      signals: [],
      sensitivity: 'internal',
      blastRadius: 'read',
    },
    decision: 'allow',
    mandate: null,
    doctrine: 'allow',
    policy: DEFAULT_POLICY,
    surface: 'web',
    actionPolicy: null,
    ...overrides,
  };
}

const DRY_RUN_DENY: ActionPolicyDecision = {
  allowed: false,
  mode: 'dry-run',
  matched: 'tool.family == "kb"',
  source: 'deny',
  forward: true,
  reason: 'blocked by rule',
};

describe('isIncident con política CEL', () => {
  it('una llamada inocua NO deja fila… hasta que un deny en dry-run la toca', () => {
    expect(isIncident(evaluation())).toBe(false);
    expect(isIncident(evaluation({ actionPolicy: DRY_RUN_DENY }))).toBe(true);
  });

  it('un allow de la política no crea incidente por sí solo', () => {
    expect(
      isIncident(
        evaluation({
          actionPolicy: { ...DRY_RUN_DENY, allowed: true, source: 'allow', reason: 'ok' },
        }),
      ),
    ).toBe(false);
  });
});

describe('blockExplanation', () => {
  it('nombra la regla cuando el bloqueo vino de la política del tenant', () => {
    const ev = evaluation({
      decision: 'block',
      actionPolicy: {
        ...DRY_RUN_DENY,
        mode: 'enforce',
        forward: false,
        reason: 'la regla X manda',
      },
    });
    expect(blockExplanation(ev)).toBe('la regla X manda');
  });

  it('cae a la explicación de la matriz cuando no hay política de por medio', () => {
    const ev = evaluation({ decision: 'block' });
    expect(blockExplanation(ev)).toContain("I can't run that one");
  });
});
