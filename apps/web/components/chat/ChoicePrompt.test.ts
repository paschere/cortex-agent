import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChoicePrompt } from './ChoicePrompt';

const opciones = [
  { label: 'Transportes del Valle SAS', detail: 'NIT 900.123.456 · Cali' },
  { label: 'Transportes del Valle Ltda', detail: 'NIT 830.998.112 · Bogotá' },
];

function render(props: Parameters<typeof ChoicePrompt>[0]): string {
  return renderToStaticMarkup(createElement(ChoicePrompt, props));
}

describe('la tarjeta de decidir', () => {
  const viva = { question: '¿Cuál de los dos es?', options: opciones, live: true };

  it('enseña la pregunta, las opciones y lo que las distingue', () => {
    const html = render(viva);
    expect(html).toContain('¿Cuál de los dos es?');
    expect(html).toContain('Transportes del Valle SAS');
    expect(html).toContain('NIT 830.998.112 · Bogotá');
  });

  it('siempre deja una salida en texto libre', () => {
    // Tres botones y ninguno es el que quieres es una trampa. El modelo tiene
    // prohibido añadir una opción «otra» justamente porque ésta existe siempre.
    expect(render(viva)).toContain('Ninguna — te digo yo');
  });

  it('anuncia a un lector de pantalla que hay algo esperando', () => {
    const html = render(viva);
    // `<output>` tiene rol implícito `status`, así que la región activa no hace
    // falta declararla — y declararla además sería la clase de redundancia que
    // algunos lectores leen dos veces.
    expect(html).toContain('<output');
    expect(html).toContain('Cortex está esperando que decidas');
    expect(html).toContain('aria-label="Cortex necesita que decidas"');
  });

  it('no se pinta de ámbar, que es el color de una acción con consecuencias', () => {
    // Si esta tarjeta se pintara como la confirmación, la gente aprendería que
    // ámbar significa «hay un botón» — y la de verdad, la que sí manda el
    // correo, llegaría ya despachada de antemano. Ver la cabecera del
    // componente y ConfirmationPrompt.
    const html = render(viva);
    expect(html).not.toMatch(/amber/);
    expect(html).toContain('primary-soft');
  });

  it('contestada se queda en una línea que sigue diciendo qué se preguntó', () => {
    const html = render({ ...viva, live: false });
    expect(html).toContain('¿Cuál de los dos es?');
    // Ni botones ni campo: la respuesta ya está en el hilo, en su burbuja.
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Ninguna — te digo yo');
  });
});
