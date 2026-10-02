import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  cleanQuickbooksSettings,
  mintQuickbooksState,
  quickbooksErrorCode,
  quickbooksErrorMessage,
  readQuickbooksState,
} from './quickbooks-oauth';

/**
 * El `state` de la vuelta de Intuit: firmado, vigente, con el nonce de la
 * cookie y de la misma persona en el mismo espacio. Cualquier otra cosa no
 * conecta nada.
 */

const KEY = randomBytes(32);
const NOW = 1_800_000_000_000;
const base = {
  userId: 'u-1',
  organizationId: 'org-andina',
  nonce: 'nonce-1',
  entities: ['customers', 'invoices'] as Array<'customers' | 'invoices'>,
  intervalMinutes: 60,
  notify: true,
};
const expected = { userId: 'u-1', organizationId: 'org-andina', nonce: 'nonce-1' };

describe('el state de QuickBooks', () => {
  it('ida y vuelta: devuelve lo elegido en la tarjeta', () => {
    const state = mintQuickbooksState(base, KEY, NOW);
    expect(readQuickbooksState(state, KEY, expected, NOW + 60_000)).toMatchObject({
      entities: ['customers', 'invoices'],
      intervalMinutes: 60,
      notify: true,
    });
  });

  it('otra persona, otro espacio u otro navegador (nonce) no conectan', () => {
    const state = mintQuickbooksState(base, KEY, NOW);
    expect(readQuickbooksState(state, KEY, { ...expected, userId: 'u-2' }, NOW)).toBeNull();
    expect(
      readQuickbooksState(state, KEY, { ...expected, organizationId: 'org-otra' }, NOW),
    ).toBeNull();
    expect(readQuickbooksState(state, KEY, { ...expected, nonce: 'otro' }, NOW)).toBeNull();
    expect(readQuickbooksState(state, KEY, { ...expected, nonce: undefined }, NOW)).toBeNull();
  });

  it('vencido, alterado o firmado con otra llave no conecta', () => {
    const state = mintQuickbooksState(base, KEY, NOW);
    expect(readQuickbooksState(state, KEY, expected, NOW + 11 * 60_000)).toBeNull();
    expect(readQuickbooksState(state, randomBytes(32), expected, NOW)).toBeNull();
    const [payload, signature] = state.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload ?? '', 'base64url').toString()),
        organizationId: 'org-otra',
      }),
    ).toString('base64url');
    expect(
      readQuickbooksState(
        `${forged}.${signature}`,
        KEY,
        { ...expected, organizationId: 'org-otra' },
        NOW,
      ),
    ).toBeNull();
    expect(readQuickbooksState('basura', KEY, expected, NOW)).toBeNull();
    expect(readQuickbooksState(null, KEY, expected, NOW)).toBeNull();
  });

  it('lo elegido se limpia: cosas conocidas y una frecuencia entre 15 min y un día', () => {
    expect(
      cleanQuickbooksSettings({ entities: 'invoices,payments,nada', interval: '120', notify: '0' }),
    ).toEqual({ entities: ['invoices', 'payments'], intervalMinutes: 120, notify: false });
    expect(cleanQuickbooksSettings({ entities: '', interval: '60', notify: '1' })).toBeNull();
    expect(
      cleanQuickbooksSettings({ entities: 'invoices', interval: '5', notify: '1' }),
    ).toBeNull();
  });

  it('los códigos de la vuelta se dicen en español; los demás no son de QuickBooks', () => {
    expect(quickbooksErrorMessage('quickbooks_not_configured')).toContain(
      'Falta configurar la app de QuickBooks',
    );
    expect(quickbooksErrorMessage('quickbooks_lo_que_sea')).toContain('Intuit no confirmó');
    expect(quickbooksErrorMessage('state')).toBeNull();
    expect(quickbooksErrorCode('forbidden')).toBe('quickbooks_forbidden');
    expect(quickbooksErrorCode(undefined)).toBe('quickbooks_failed');
  });
});
