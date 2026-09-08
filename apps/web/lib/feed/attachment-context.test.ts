import { describe, expect, it } from 'vitest';
import { renderTurnAttachmentBlock } from '../chat-attachments';
it('carries source coverage and routing separately from an excerpt limit', () => {
  const block = renderTurnAttachmentBlock([
    {
      id: 'a',
      filename: 'Fuente',
      text: 'Extracto',
      truncated: true,
      sourcePartial: true,
      tables: [
        {
          name: 'Clientes',
          rows: [
            ['Nombre', 'Correo'],
            ['Ana', 'ana@example.test'],
          ],
        },
      ],
    },
  ]);
  expect(block).toContain('"sourcePartial":true');
  expect(block).toContain('"kind":"contacts"');
  expect(block).toContain('Una captura parcial no representa el documento original completo');
  expect(block).toContain('hace falta una petición explícita');
});
