'use client';

import { ProposedActionCard } from '@/components/actions/ProposedActionCard';
import type { ActionView } from '@/lib/actions-shape';
import type { ResultViewProps } from './registry';

/**
 * `actions.propose` — el borrador, con el botón puesto.
 *
 * Esto es una junta de tres líneas, no una vista: la tarjeta es la MISMA que se
 * monta en `/actions`, y su cabecera explica por qué eso no es negociable — dos
 * dibujos del mismo borrador es exactamente cómo el texto que está en pantalla
 * y el que sale por correo empiezan a diferir.
 *
 * Lo único que se hace aquí es volver a comprobar la forma. Lo que llega cruzó
 * un stream y, en una conversación reabierta, una fila de la base; una tarjeta
 * sin `id` o sin sello no es una tarjeta con un botón roto, es una que no se
 * dibuja. El registro ya lo filtró antes de llegar (`RICH_NEEDS`), y aun así se
 * comprueba: el que valida es quien va a usar el dato.
 */
export function ProposedAction({ result, onSettled }: ResultViewProps) {
  const action = actionOf(result);
  if (!action) return null;
  return <ProposedActionCard action={action} dense onSettled={onSettled} />;
}

function actionOf(result: unknown): ActionView | null {
  if (!result || typeof result !== 'object' || '__error' in result) return null;
  const action = (result as { action?: unknown }).action;
  if (!action || typeof action !== 'object') return null;
  const a = action as Record<string, unknown>;
  return typeof a.id === 'string' && typeof a.contentHash === 'string'
    ? (action as ActionView)
    : null;
}
