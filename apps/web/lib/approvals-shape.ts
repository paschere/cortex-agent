/**
 * LA COPIA DEL NAVEGADOR DEL VOCABULARIO DE APROBACIONES.
 *
 * Existe por lo mismo que `actions-shape.ts` y `commitments-shape.ts`:
 * importar un VALOR de `@cortex/agent-tools` desde un componente `'use client'`
 * arrastra `node:dns` al bundle y rompe el build de producción mientras el
 * typecheck y las pruebas siguen en verde. Los TIPOS sí viajan —se borran al
 * compilar—, así que aquí sólo se copia lo que es dato.
 *
 * `lib/approvals-parity.test.ts` importa las dos copias en Node y falla en
 * cuanto discrepan. Sin esa prueba esto no sería una copia, sería una segunda
 * fuente de verdad.
 */

/** Dónde se paró la llamada a pedir permiso (migración 0102). */
export const STAGED_VIA = ['mcp', 'google_chat', 'whatsapp', 'web', 'schedule'] as const;
export type StagedVia = (typeof STAGED_VIA)[number];

/**
 * Cómo se nombra cada origen delante de una persona.
 *
 * Nombra la CONVERSACIÓN, no el protocolo: quien dejó algo pendiente anoche
 * hablando con Claude no reconoce «mcp», reconoce dónde estaba.
 */
export const STAGED_VIA_LABEL: Record<StagedVia, string> = {
  mcp: 'tu conversación en Claude',
  google_chat: 'Google Chat',
  whatsapp: 'WhatsApp',
  web: 'este chat',
  schedule: 'una rutina programada',
};
