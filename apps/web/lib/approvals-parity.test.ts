import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STAGED_VIA, STAGED_VIA_LABEL } from '@/lib/approvals-shape';
import { TOOL_LABELS, confirmationSummary } from '@/lib/tool-labels';
import * as tools from '@cortex/agent-tools';
import { describe, expect, it } from 'vitest';

/**
 * LA FRASE QUE LEE UNA PERSONA Y LA FRASE QUE LE CUENTA EL MODELO TIENEN QUE
 * SER LA MISMA FRASE.
 *
 * ===========================================================================
 * POR QUÉ HAY DOS COPIAS QUE COMPARAR
 * ===========================================================================
 * `confirmationSummary` vive en `lib/tool-labels.ts` porque la usan
 * `ConfirmationPrompt` y la tarjeta de aprobaciones, que son `'use client'`:
 * importar `@cortex/agent-tools` desde ahí arrastra `node:dns` al bundle y
 * rompe el build de producción con el typecheck y las pruebas en verde.
 * `pendingSummary` vive en el paquete porque la usa `approvals.list`, que corre
 * dentro de él y no puede importar nada de `apps/web` — la dependencia va al
 * revés. Ninguna de las dos se puede borrar.
 *
 * Así que la duplicación se queda y lo que se prueba es que no se separe. No es
 * cosmético: la tarjeta del chat enseña la frase que vino en el resultado de la
 * herramienta, y `/approvals` la calcula del payload que ya tiene. Si divergen,
 * dos superficies describen la misma acción de dos maneras distintas y una de
 * las dos está mintiéndole a quien va a pulsar «Aprobar y ejecutar».
 */

const WEB_LABELS = Object.fromEntries(
  Object.entries(TOOL_LABELS).map(([id, { label }]) => [id, label]),
);

describe('el catálogo de nombres es el mismo a los dos lados', () => {
  it('tiene las mismas herramientas con los mismos nombres', () => {
    expect(WEB_LABELS).toEqual(tools.TOOL_LABEL_TEXT);
  });

  it('cae al mismo texto para una herramienta que no está en el catálogo', () => {
    // El default de `confirmationSummary` pasa por el catálogo, así que un id
    // desconocido es donde las dos implementaciones podrían separarse sin que
    // ninguna tabla lo delate.
    for (const id of ['custom.radicar_dian', 'mcp_x_do_thing', 'thing']) {
      expect(tools.pendingSummary(id, {})).toBe(confirmationSummary(id, {}));
    }
  });
});

/**
 * Un caso por rama de la frase. La última prueba del bloque comprueba que no se
 * quede ninguna fuera cuando alguien añada una.
 */
const CASES: Array<{ toolId: string; input: Record<string, unknown> }> = [
  { toolId: 'hubspot.update_deal', input: { dealstage: 'Negociación', amount: 12_400_000 } },
  { toolId: 'hubspot_update_deal', input: {} },
  { toolId: 'hubspot.create_deal', input: { dealname: 'Coltrans', dealstage: 'Propuesta' } },
  {
    toolId: 'hubspot.create_contact',
    input: { firstName: 'Daniela', lastName: 'Ríos', email: 'd@acme.co' },
  },
  {
    toolId: 'hubspot.log_activity',
    input: {
      type: 'call',
      subject: 'Seguimiento',
      associatedObjectType: 'deal',
      associatedObjectId: '9',
    },
  },
  { toolId: 'browser.submit_flow', input: { flow: 'RUT' } },
  { toolId: 'gmail.send_draft', input: { draftId: 'r-99' } },
  { toolId: 'gmail.send_message', input: { to: ['a@b.co'], subject: 'S', body: 'B' } },
  { toolId: 'gcal.create_event', input: { summary: 'Comité', start: '2026-08-20T15:00' } },
  { toolId: 'gsheets.append_row', input: { spreadsheetId: 'NOMINA-2026-08' } },
  {
    toolId: 'schedule.create',
    input: { name: 'Cartera', scheduleKind: 'cron', cron: '0 7 * * 1', timezone: 'America/Bogota' },
  },
  {
    toolId: 'schedule.create',
    input: {
      name: 'Cierre',
      scheduleKind: 'once',
      runAt: '2026-09-01T09:00',
      allowUnattendedWrites: true,
    },
  },
  { toolId: 'vehicles.register', input: { plate: 'ABC123' } },
  {
    toolId: 'goals.set',
    input: { metricKey: 'receivables_days', cadence: 'month', targetValue: 45, label: 'Cartera' },
  },
  // Sin etiqueta, que es como llega cuando nadie la bautiza: la frase cae a la
  // clave de la métrica en los dos lados o no cae en ninguno.
  {
    toolId: 'goals.set',
    input: { metricKey: 'commitments_on_time', cadence: 'week', targetValue: 95 },
  },
  { toolId: 'slack.post_message', input: { channel: '#general', text: 'hola' } },
];

describe('la frase que describe una llamada parada', () => {
  it.each(CASES)('dice lo mismo en el navegador y en el paquete: $toolId', ({ toolId, input }) => {
    expect(tools.pendingSummary(toolId, input)).toBe(confirmationSummary(toolId, input));
  });

  it('cubre todas las ramas que tiene la copia del navegador', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./tool-labels.ts', import.meta.url)),
      'utf8',
    );
    const branches = [...source.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1] as string);
    const covered = new Set(CASES.map((c) => c.toolId.replace(/\./g, '_')));
    expect(
      branches.filter((id) => !covered.has(id)),
      'Estas ramas de `confirmationSummary` no están en CASES, así que nada comprueba ' +
        'que la copia del paquete diga lo mismo. Añade un caso con un payload de ejemplo.',
    ).toEqual([]);
  });
});

describe('de dónde salió lo que espera permiso', () => {
  it('los orígenes y sus nombres son los mismos a los dos lados', () => {
    expect([...STAGED_VIA]).toEqual([...tools.STAGED_VIA]);
    expect(STAGED_VIA_LABEL).toEqual(tools.STAGED_VIA_LABEL);
  });
});
