import { z } from 'zod';
import { registerTool } from '../index';
import { type PendingApproval, approvalsListOutputSchema, stagedViaOf } from './shape';
import { describePendingCall } from './summary';

/** Cuántas caben en una respuesta sin que deje de leerse como una respuesta. */
const DEFAULT_LIMIT = 10;

/**
 * LA COLA QUE EL CHAT NO PODÍA VER, Y LA HERRAMIENTA QUE NO EXISTE.
 *
 * ===========================================================================
 * EL AGUJERO
 * ===========================================================================
 * Todo el producto se sostiene sobre «Cortex propone, tú apruebas», y aprobar
 * era lo único que no se podía hacer hablando. No por falta de un botón: el
 * chat web nunca escribe en `mcp_pending_actions`. Cuando una llamada se para
 * (`ConfirmationRequiredError`), `/api/chat` la convierte en el centinela
 * `__requires_confirmation` y la resuelve en el mismo turno. Los únicos que
 * llenan esa tabla son MCP, Google Chat y el puente de WhatsApp — así que lo
 * que dejó pendiente una rutina, una conversación en Claude o un mensaje de
 * WhatsApp era invisible desde el sitio donde la gente pregunta las cosas.
 *
 * `approvals.list` es esa cola, leída en voz alta. Nada más.
 *
 * ===========================================================================
 * `approvals.decide` NO EXISTE. NUNCA.
 * ===========================================================================
 * El modelo no puede aprobar porque no hay herramienta con la que aprobar. No
 * es una comprobación que pueda fallar, ni una bandera que alguien invierta al
 * refactorizar: es la AUSENCIA de una superficie. El botón de la tarjeta es un
 * `fetch` a `POST /api/approvals/[id]` desde un componente de cliente, que el
 * modelo no puede invocar de ninguna manera.
 *
 * Es literalmente la arquitectura de `actions.propose` (ver `actions/tools.ts`,
 * que ya la argumenta por escrito: la puerta está donde le toca). Aquí el
 * argumento es aún más simple, porque esta herramienta no escribe nada en
 * absoluto.
 *
 * Y hay un segundo argumento, independiente del primero, que conviene dejar
 * dicho porque explica por qué no vale con «bueno, el guardarraíl lo pararía»:
 * NO LO PARARÍA. `FAMILY_SENSITIVITY` en `../security/policy.ts` no tiene
 * entrada `approvals`, así que un hipotético `approvals.decide` caería en el
 * default `client`, y `decide` con blast radius `internal_write` da `medium` →
 * `allow`. La matriz lo clasificaría como una escritura interna cualquiera —
 * como crear una fila — cuando lo que estaría haciendo es levantar TODAS las
 * demás puertas de golpe. Añadir la familia al mapa tampoco lo arreglaría:
 * ninguna casilla de esa matriz describe «esto ejecuta una llamada que ya se
 * había parado». El guardarraíl no puede defender un agujero con forma de
 * herramienta legítima; lo que lo defiende es que la herramienta no exista.
 *
 * ===========================================================================
 * Y NO DEVUELVE EL PAYLOAD
 * ===========================================================================
 * Ver la cabecera de `./shape.ts`. El esquema de salida lo hace imposible, no
 * lo desaconseja.
 */
export const approvalsList = registerTool({
  id: 'approvals.list',
  description:
    'List the actions that are PARKED waiting for this user to approve them — tool calls Cortex stopped mid-flight and has NOT run, staged from a scheduled routine, from the user\'s Claude conversation, or from WhatsApp. Use it to answer "what is waiting on me", "what needs my approval", "did anything get stuck". READ-ONLY, and there is no companion tool to approve or decline: only the person can, with the buttons on the card this result renders as. So report what is waiting and stop there — never claim you approved anything, and never ask the user to paste an id. It deliberately does NOT return the payload of each call (the person can expand the card to see it), so do not describe recipients, amounts or bodies you have not been given.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(25).default(DEFAULT_LIMIT),
  }),
  outputSchema: approvalsListOutputSchema,
  handler: async (input, ctx) => {
    const nowIso = new Date().toISOString();
    const { data, error } = await ctx.db
      .from('mcp_pending_actions')
      // `input` viaja hasta aquí porque la frase de `summary` se escribe con
      // él, y de aquí no pasa: se convierte en una oración dentro de este
      // handler y el objeto que se devuelve se construye campo por campo, nunca
      // con un spread de la fila. Lo que impide que salga no es esta línea sino
      // el esquema de salida — ver ./shape.ts.
      .select('id, tool_id, created_at, expires_at, staged_via, input')
      .eq('user_id', ctx.userId)
      .is('decision', null)
      .gt('expires_at', nowIso)
      // Lo más viejo primero: el TTL es constante, así que es también lo que
      // está a punto de vencerse, que es lo urgente.
      .order('created_at', { ascending: true })
      // El `??` no es defensa contra el esquema —`.default()` lo rellena— sino
      // contra su tipo de ENTRADA, donde el campo sigue siendo opcional.
      .limit(input.limit ?? DEFAULT_LIMIT);

    if (error) {
      throw new Error(
        `No se pudo leer lo que espera tu permiso: ${error.message}. Suele ser una migración sin aplicar en esta base de datos.`,
      );
    }

    const rows = (data ?? []) as Array<{
      id: string;
      tool_id: string;
      created_at: string;
      expires_at: string;
      staged_via: string | null;
      input: unknown;
    }>;

    const pending: PendingApproval[] = rows.map((row) => ({
      id: row.id,
      toolId: row.tool_id,
      summary: describePendingCall(row.tool_id, row.input),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      via: stagedViaOf(row.staged_via),
    }));

    return {
      pending,
      summary:
        pending.length === 0
          ? 'No hay nada esperando tu permiso ahora mismo.'
          : `Hay ${pending.length} ${pending.length === 1 ? 'acción parada esperando' : 'acciones paradas esperando'} tu permiso. ${pending.length === 1 ? 'No se ha ejecutado' : 'No se ha ejecutado ninguna'}: cada una corre sólo cuando la apruebas tú desde la tarjeta.`,
    };
  },
});
