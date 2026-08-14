'use client';

import { DeclaredTable } from '@/components/chat/results/DeclaredTable';
import { StructuralResult } from '@/components/chat/results/StructuralResult';
import { resolveView } from '@/components/chat/results/registry';
import { PANELS, type PanelId } from './shape';

/**
 * CÓMO SE PINTA UN PANEL: CON EL MISMO COMPONENTE QUE EL CHAT.
 *
 * Este archivo es corto y esa es toda su tesis. No hay un mapa de `panelId` a
 * una vista escrita para el panel, porque una vista escrita para el panel sería
 * una segunda versión de algo que ya existe, y dos versiones divergen — no si
 * alguien se descuida, sino en cuanto una de las dos se arregla.
 *
 * Lo que hay es una traducción: `panelId` → `toolId` (en `shape.ts`, la misma
 * tabla que usa el servidor) → `resolveView(toolId)`, que es LITERALMENTE la
 * función que `MessageBubble` llama para decidir qué dibuja el chat cuando esa
 * herramienta contesta. Las tres capas del registro caen aquí solas:
 *
 *   RICH        una vista propia → la tarjeta que ya existe, tal cual.
 *   TABLE       una tabla declarada → `DeclaredTable`, la misma.
 *   estructural nada declarado → `StructuralResult`, que mira la FORMA del
 *               resultado y hace una tabla o una lista de campos sin que nadie
 *               le haya dicho nada de esta herramienta.
 *
 * Esa última fila es la que hace que los cinco paneles funcionen HOY, con el
 * registro casi vacío: la capa estructural no necesita que nadie la alimente. Y
 * el día que alguien añada `payments_receivables` a `RICH`, este panel empieza a
 * dibujar esa tarjeta sin que se toque una línea de aquí — igual que el chat.
 *
 * El precedente es `components/actions/ProposedActionCard.tsx`, que se monta en
 * el chat y en `/actions` y explica en su cabecera por qué es uno solo.
 *
 * REGLA QUE NO SE ROMPE: este árbol es `'use client'`, así que de
 * `@cortex/agent-tools` sólo pueden entrar TIPOS, nunca valores. Ese barril
 * alcanza `node:dns` y un valor importado desde aquí compila en local, pasa el
 * typecheck y rompe el build de producción. Aquí no entra ni una cosa ni la
 * otra: lo único que se importa del paquete es una CADENA con el id, y viene de
 * `shape.ts`.
 */
export function PanelResult({
  panelId,
  result,
  onSettled,
}: {
  panelId: PanelId;
  result: unknown;
  /** Refrescar cuando la tarjeta cambió algo (aprobar, descartar). */
  onSettled?: () => void;
}) {
  const resolved = resolveView(PANELS[panelId].toolId);

  if (resolved.as === 'rich') {
    const View = resolved.View;
    // El `toolCallId` es lo que una tarjeta usa para saber a qué llamada
    // pertenece. Aquí no hay turno, así que se nombra la colocación: es
    // estable mientras el panel esté abierto y no puede chocar con el id que
    // acuña el AI SDK.
    return <View result={result} toolCallId={`panel:${panelId}`} onSettled={onSettled} />;
  }

  if (resolved.as === 'table') {
    return <DeclaredTable spec={resolved.spec} result={result} />;
  }

  return <StructuralResult result={result} />;
}
