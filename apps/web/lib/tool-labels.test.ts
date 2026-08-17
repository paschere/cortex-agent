import { TOOL_LABELS, humanizeToolId, toolDisplayName } from '@/lib/tool-labels';
import { listTools } from '@cortex/agent-tools';
import * as lucide from 'lucide-react';
import { describe, expect, it } from 'vitest';

/**
 * EL CATÁLOGO ES UNA COPIA A MANO DEL REGISTRO, Y LAS COPIAS SE QUEDAN ATRÁS EN
 * SILENCIO. Ese es el problema entero que este archivo cierra.
 *
 * Cuando una herramienta no está en `TOOL_LABELS`, no falla nada: `toolLabel`
 * cae a `humanizeToolId` y la pantalla dibuja «Kb · Context», «Payments ·
 * Receivables», «Inbox · Due Digests». Todo funciona, nada se rompe, y el
 * resultado fue que ciento once de las ciento cincuenta y una herramientas
 * registradas —la cartera, la nómina, los vencimientos, los informes— se
 * anunciaban en el chat con el identificador de su función partido en dos
 * palabras en inglés. Eso no es una etiqueta: es el nombre interno enseñado a
 * quien no lo escribió.
 *
 * Se importa `@cortex/agent-tools` a propósito y se puede: esta prueba corre en
 * Node, no se empaqueta para el navegador. Lo que NO se puede es importarlo
 * desde `lib/tool-labels.ts` —lo consume `'use client'` y arrastraría
 * `node:dns` al bundle, con typecheck y pruebas en verde— y por eso el catálogo
 * es una copia y por eso hace falta esto. Está contado en
 * `lib/notifications-shape.ts` y en `lib/reports-shape.ts`, que ya lo vivieron.
 */

/** Lo que de verdad puede aparecer en un renglón de la conversación. */
const REGISTERED = listTools()
  .map((tool) => tool.id)
  .filter((id) => !id.startsWith('test.'))
  .sort();

describe('el catálogo de nombres contra el registro real', () => {
  it('ninguna herramienta registrada cae al fallback', () => {
    const fallback = REGISTERED.filter((id) => !TOOL_LABELS[id.replace(/\./g, '_')]);
    expect(
      fallback,
      'Estas herramientas se dibujan como «Familia · Acción» en el chat, en la ' +
        'cola de aprobaciones y en el registro de auditoría. Escríbeles su frase ' +
        'en español en `TOOL_LABELS` (y el mismo texto en `TOOL_LABEL_TEXT`, en ' +
        'packages/agent-tools/src/approvals/summary.ts).',
    ).toEqual([]);
  });

  it('la clave es el id con puntos cambiados por guión bajo', () => {
    // El registro declara `kb.context`; la AI SDK y MCP persisten `kb_context`.
    // Una clave escrita con punto no la encuentra nadie y no falla nada.
    const conPunto = Object.keys(TOOL_LABELS).filter((key) => key.includes('.'));
    expect(conPunto).toEqual([]);
  });

  it('cada nombre está en español y en la voz del resto del mapa', () => {
    // Dos cosas que sólo pasan cuando alguien pegó el id en vez de escribir la
    // frase: guiones bajos dentro del texto, o el separador `·` del fallback.
    const sospechosos = Object.entries(TOOL_LABELS)
      .filter(([, { label }]) => label.includes('_') || label.includes('·'))
      .map(([key]) => key);
    expect(sospechosos).toEqual([]);
  });

  it('los iconos existen de verdad en lucide-react', () => {
    // Un nombre inventado no revienta la pantalla: los mapas de iconos caen a
    // `Wrench`, así que una herramienta mal bautizada se dibuja con una llave
    // inglesa para siempre y nadie se entera. Misma trampa que cubre
    // `tool-taxonomy.test.ts` para las dos pantallas de capacidades.
    const inventados = [
      ...new Set(
        Object.values(TOOL_LABELS)
          .map(({ icon }) => icon)
          .filter((icon) => !(icon in lucide)),
      ),
    ];
    expect(inventados).toEqual([]);
  });
});

describe('lo que se dibuja cuando no hay nombre curado', () => {
  it('una herramienta propia del espacio o de un MCP sigue cayendo al fallback', () => {
    // Y tiene que seguir cayendo: esas no salen del registro, las nombra quien
    // las creó, y no hay ninguna lista donde escribirlas de antemano.
    expect(toolDisplayName('custom.radicar_dian')).toBe('Custom · Radicar Dian');
    expect(humanizeToolId('mcp_x_do_thing')).toBe('Mcp · X Do Thing');
  });

  it('nunca devuelve el id en bruto', () => {
    expect(toolDisplayName('thing')).toBe('Thing');
  });
});
