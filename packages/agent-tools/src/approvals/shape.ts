import { z } from 'zod';

/**
 * LA FORMA DE UNA APROBACIÓN PENDIENTE, DICHA DE MODO QUE NO PUEDA LLEVAR EL
 * PAYLOAD.
 *
 * ===========================================================================
 * ESTE ESQUEMA ES EL GUARDARRAÍL, NO UNA DESCRIPCIÓN DEL GUARDARRAÍL
 * ===========================================================================
 * `mcp_pending_actions.input` es la llamada entera y validada que se ejecutará
 * si alguien dice que sí: los destinatarios de un correo, el cuerpo redactado,
 * las filas de una exportación de nómina. Meter eso en el contexto del modelo
 * cada vez que alguien pregunta «¿qué me espera?» es exactamente lo que la
 * matriz de riesgo existe para evitar — y sería, además, la manera más tonta de
 * hacerlo: sin que nadie lo pidiera y en la respuesta a una pregunta inocente.
 *
 * Por eso la defensa no es una revisión de código ni una bandera: es que la
 * salida DECLARADA no tiene sitio donde meterlo. `.strict()` es deliberado y es
 * la mitad importante — sin él, zod se limitaría a podar la clave de más en
 * silencio, que también evita la fuga pero deja el intento sin testigos. Con
 * él, un `input` que se colara devuelve un error de validación de salida en
 * `runTool` y la herramienta se cae entera. Fallar ruidosamente es lo correcto
 * aquí: una fuga de contexto que sólo se poda es una fuga que vuelve a
 * intentarse mañana desde otro sitio.
 *
 * `apps/web/lib/approvals-leak.test.ts` y
 * `packages/agent-tools/src/approvals/__tests__/tools.test.ts` lo prueban por
 * los dos lados: que el esquema rechaza el payload, y que ninguna cadena del
 * payload aparece en lo que la herramienta devuelve.
 *
 * ===========================================================================
 * QUIÉN SÍ VE EL PAYLOAD
 * ===========================================================================
 * La persona, y por otro camino: la tarjeta lo pide con
 * `GET /api/approvals/[id]` al desplegar «ver lo que se va a enviar». Es una
 * ruta con sesión que sólo devuelve filas de quien pregunta. Resultado: la
 * persona ve el payload; el modelo nunca.
 */

/** Dónde se paró la llamada a pedir permiso. Nulo = no consta (migración 0102). */
export const STAGED_VIA = ['mcp', 'google_chat', 'whatsapp', 'web', 'schedule'] as const;
export type StagedVia = (typeof STAGED_VIA)[number];

/** Cómo se nombra cada origen delante de una persona. */
export const STAGED_VIA_LABEL: Record<StagedVia, string> = {
  mcp: 'tu conversación en Claude',
  google_chat: 'Google Chat',
  whatsapp: 'WhatsApp',
  web: 'este chat',
  schedule: 'una rutina programada',
};

export const pendingApprovalSchema = z
  .object({
    /** El id de la fila. Es lo que el botón manda a POST /api/approvals/[id]. */
    id: z.string(),
    /** Qué herramienta está parada. Un id, no su payload. */
    toolId: z.string(),
    /** Una frase en español que describe la llamada. Ver approvals/summary.ts. */
    summary: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    via: z.enum(STAGED_VIA).nullable(),
  })
  .strict();

export type PendingApproval = z.infer<typeof pendingApprovalSchema>;

/** Lo que `approvals.list` devuelve. Ver arriba por qué `.strict()`. */
export const approvalsListOutputSchema = z
  .object({
    pending: z.array(pendingApprovalSchema),
    summary: z.string(),
  })
  .strict();

export type ApprovalsListOutput = z.infer<typeof approvalsListOutputSchema>;

/** Normaliza el valor de la columna: cualquier cosa que no reconozcamos es «no consta». */
export function stagedViaOf(value: unknown): StagedVia | null {
  return typeof value === 'string' && (STAGED_VIA as readonly string[]).includes(value)
    ? (value as StagedVia)
    : null;
}
