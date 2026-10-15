import { describe, expect, it } from 'vitest';
import { firstRealRequest, looksBadTitle, titleFromText } from './conversation-title';

describe('títulos de conversación', () => {
  it('detecta títulos en inglés, con markdown o de control', () => {
    for (const t of [
      'Approved, already executed, continue forward',
      'Check SIIGO for these invoi…',
      'Go ahead, come in',
      '**Continue the conversatio…',
      'Aprobé y ya se ejecutó',
    ]) {
      expect(looksBadTitle(t)).toBe(true);
    }
    expect(looksBadTitle('Guías sin factura de Merflex')).toBe(false);
  });
  it('salta mensajes de control y triviales', () => {
    expect(
      firstRealRequest([
        { role: 'user', content: 'sigue' },
        { role: 'user', content: 'Aprobé y ya se ejecutó la acción' },
        { role: 'user', content: '**Revisa** las facturas de Siigo' },
      ]),
    ).toBe('Revisa las facturas de Siigo');
  });
  it('recorta sin markdown', () => {
    expect(
      titleFromText(
        '¿Cuánto nos deben los clientes de la costa en cartera vencida este trimestre?',
        30,
      ),
    ).toMatch(/…$/);
  });
});
