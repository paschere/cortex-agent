import { describe, expect, it } from 'vitest';
import {
  SIIGO_WEBHOOK_TOPICS,
  siigoWebhookSignature,
  siigoWebhookUrl,
  verifySiigoWebhook,
  webhookShouldRunNow,
} from './webhook';

const ENV = { ACCOUNTING_WEBHOOK_SECRET: 'un-secreto-del-servidor-bien-largo' };

describe('avisos de Siigo (productos y existencias)', () => {
  it('la firma sirve sólo para esa conexión y ese espacio', () => {
    const sig = siigoWebhookSignature('org-1', 'conn-1', ENV) as string;
    expect(sig).toHaveLength(40);
    expect(verifySiigoWebhook('org-1', 'conn-1', sig, ENV)).toBe(true);
    expect(verifySiigoWebhook('org-1', 'conn-2', sig, ENV)).toBe(false);
    expect(verifySiigoWebhook('org-2', 'conn-1', sig, ENV)).toBe(false);
    expect(verifySiigoWebhook('org-1', 'conn-1', `${sig.slice(0, 39)}0`, ENV)).toBe(false);
    expect(verifySiigoWebhook('org-1', 'conn-1', 'corta', ENV)).toBe(false);
  });
  it('sin secreto en el servidor no hay dirección ni se acepta nada', () => {
    expect(siigoWebhookSignature('o', 'c', {})).toBeNull();
    expect(siigoWebhookUrl('https://app.test', 'o', 'c', {})).toBeNull();
    expect(verifySiigoWebhook('o', 'c', 'x'.repeat(40), {})).toBe(false);
    // Un secreto corto no sirve.
    expect(siigoWebhookSignature('o', 'c', { ACCOUNTING_WEBHOOK_SECRET: 'corto' })).toBeNull();
  });
  it('la dirección que se le da a Siigo lleva el espacio, la conexión y la firma', () => {
    const url = siigoWebhookUrl('https://app.test/', 'org-1', 'conn-1', ENV) as string;
    const sig = siigoWebhookSignature('org-1', 'conn-1', ENV);
    expect(url).toBe(`https://app.test/api/webhooks/siigo/org-1/conn-1/${sig}`);
  });
  it('una corrida por minuto como mucho; el resto espera al barrido', () => {
    const now = new Date('2026-10-21T12:00:00Z');
    expect(webhookShouldRunNow(null, now)).toBe(true);
    expect(webhookShouldRunNow('2026-10-21T11:58:00Z', now)).toBe(true);
    expect(webhookShouldRunNow('2026-10-21T11:59:30Z', now)).toBe(false);
  });
  it('pide avisos de productos y de existencias', () => {
    expect(SIIGO_WEBHOOK_TOPICS.some((t) => t.includes('stock'))).toBe(true);
  });
});
