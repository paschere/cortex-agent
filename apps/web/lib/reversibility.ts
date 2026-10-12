import { riskOfTool } from '@/lib/risk';

/**
 * ¿SE PUEDE DESHACER LO QUE SE VA A APROBAR?
 *
 * Un mapa chico y honesto. «Reversible» sólo para lo que `lib/activity/undo.ts`
 * sabe revertir (hay botón Deshacer de verdad); «irreversible» para lo que sale
 * de la empresa o mueve plata (el riesgo «alto» de `risk.ts`); lo demás no
 * promete nada en ningún sentido.
 */
export type Reversibility = 'reversible' | 'irreversible' | 'unknown';

const REVERSIBLE = new Set(['trackers.upsert', 'views.create', 'views.archive']);

export function reversibilityOf(toolId: string): Reversibility {
  if (REVERSIBLE.has(toolId)) return 'reversible';
  return riskOfTool(toolId).level === 'alto' ? 'irreversible' : 'unknown';
}

export const REVERSIBILITY_LABEL: Record<Exclude<Reversibility, 'unknown'>, string> = {
  reversible: 'Se puede deshacer',
  irreversible: 'No se puede deshacer',
};
