import { buildToolContext } from '@/lib/agent';
import { PANELS, isPanelId, resolvePanelInput } from '@/lib/panels/shape';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { getTool, runTool } from '@cortex/agent-tools';
import { loadAgent } from '@cortex/agents';
import { CortexError } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * LO QUE ALIMENTA EL PANEL DE AL LADO.
 *
 * ===========================================================================
 * DEL CLIENTE NO VIENE UNA HERRAMIENTA. VIENE UNA PALABRA.
 * ===========================================================================
 * El cuerpo trae `panelId` y, si la superficie es de una entidad, `key`. El
 * `toolId` y la entrada salen de `lib/panels/shape.ts`, aquí, en el servidor.
 * Es la diferencia entre consultas fijas y un ejecutor de herramientas
 * arbitrario con sesión: un cuerpo que pudiera nombrar la herramienta podría
 * nombrar `gmail.send_message`, y la entrada la escribiría quien manda el POST.
 *
 * ===========================================================================
 * SIN `confirmed`, Y CON LA DENY-LIST RECOMPROBADA
 * ===========================================================================
 * `runTool` se llama SIN `confirmed`, así que cualquier puerta —confirmación,
 * riesgo, mandato— dispara igual que dispararía en el chat. Los cinco paneles
 * son de lectura y hoy ninguna puerta les salta; si mañana alguien añade uno
 * que escriba, este archivo no tiene que cambiar para seguir siendo correcto.
 *
 * Y la deny-list de equipo se vuelve a mirar aquí en vez de darse por buena:
 * es el mismo argumento que `runApprovedAction` escribe en
 * `lib/approvals/decide.ts` — «un tool revocado no debe correr sólo porque el
 * botón ya estaba en pantalla». En un panel el botón es una fila del rail, que
 * puede llevar media hora abierta.
 */

const Body = z.object({
  /**
   * `nullish()` y no `optional()` es la regla del repositorio para los cuerpos
   * de petición; aquí el campo es obligatorio, que es la forma más fuerte de
   * las tres: sin panel no hay nada que ejecutar.
   */
  panelId: z.string(),
  /**
   * La clave de una superficie parametrizada (el cliente, no «los clientes»).
   * Nunca un `toolId`. El servidor decide en qué campo de la entrada cae.
   */
  key: z.string().min(1).max(200).nullish(),
});

export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await requireSession();

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || !isPanelId(parsed.data.panelId)) {
    return NextResponse.json({ error: 'Ese panel no existe.' }, { status: 400 });
  }

  const panel = PANELS[parsed.data.panelId];
  const resolved = resolvePanelInput(parsed.data.panelId, parsed.data.key);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.message }, { status: 400 });
  }

  const tool = getTool(panel.toolId);
  if (!tool) {
    // Un panel que apunta a una herramienta que ya no está registrada. Se dice
    // en vez de devolver un panel vacío: vacío y roto se ven igual y significan
    // lo contrario.
    return NextResponse.json(
      { error: 'Esto ya no se puede consultar desde aquí.' },
      { status: 404 },
    );
  }

  const db = getOrgScopedClient(user.organization.id);
  const denied = await deniedToolPatterns(db, user.id);
  if (isToolDenied(panel.toolId, denied)) {
    return NextResponse.json(
      { error: 'Tu equipo no tiene acceso a esto, así que no lo abrí.' },
      { status: 403 },
    );
  }

  const agent = await loadAgent(db, 'cortex');
  const ctx = buildToolContext({
    organizationId: user.organization.id,
    userId: user.id,
    agentId: agent.id,
    // Sin `conversationId` a propósito: abrir un panel no es un turno y no debe
    // aparecer colgando de la conversación que hay al lado.
    surface: 'web',
  });

  try {
    const result = await runTool(tool, resolved.input, ctx);
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof CortexError && err.code === 'NOT_FOUND') {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    const message = err instanceof Error ? err.message : 'No se pudo abrir el panel.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
