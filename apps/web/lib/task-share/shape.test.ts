import { describe, expect, it } from 'vitest';
import {
  SHARE_DEFAULT_DAYS,
  SHARE_MAX_DAYS,
  SHARE_TOKEN_RE,
  buildSnapshot,
  canRevokeShare,
  canShareTask,
  clampShareDays,
  parseShotPath,
  parseSnapshot,
  redactText,
  shareExpiry,
  shareState,
} from './shape';
import { hashShareToken, mintShareToken } from './token';

describe('redactText', () => {
  it('siempre quita claves y tokens', () => {
    const out = redactText(
      'Usa Bearer abcdef1234567890abcdef y sk-live_ABCDEFGHIJKLMNOP1234, password: hunter22 https://x.co/a?token=SECRETO&b=1',
      { personal: false },
    );
    expect(out).not.toMatch(/abcdef1234567890abcdef|ABCDEFGHIJKLMNOP|hunter22|SECRETO/);
    expect(out).toContain('https://x.co/a');
  });

  it('con datos personales ocultos quita correos, teléfonos y NIT', () => {
    const out = redactText(
      'Escribe a ana.perez@empresa.co o al 300 123 4567 / +57 310 555 1212. NIT 900.123.456-7 y NIT: 8001234567',
      { personal: true },
    );
    expect(out).not.toMatch(/ana\.perez|300 123 4567|555 1212|900\.123\.456|8001234567/);
    expect(out).toContain('[correo oculto]');
    expect(out).toContain('[NIT oculto]');
  });

  it('sin el interruptor deja los datos personales pero no las claves', () => {
    const out = redactText('ana@empresa.co NIT 900.123.456-7 token: abc12345', { personal: false });
    expect(out).toContain('ana@empresa.co');
    expect(out).toContain('900.123.456-7');
    expect(out).not.toContain('abc12345');
  });

  it('no destruye cifras de dinero normales', () => {
    expect(redactText('Total $1.234.567 de 12 facturas', { personal: true })).toBe(
      'Total $1.234.567 de 12 facturas',
    );
  });

  it('oculta números de tarjeta', () => {
    expect(redactText('Tarjeta 4111 1111 1111 1111 ok', { personal: false })).not.toContain('4111');
  });
});

describe('enlace: token, caducidad y revocación', () => {
  it('el token tiene forma fija y sólo se guarda su hash', () => {
    const t = mintShareToken();
    expect(SHARE_TOKEN_RE.test(t)).toBe(true);
    expect(mintShareToken()).not.toBe(t);
    const h = hashShareToken(t);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).not.toContain(t);
    expect(hashShareToken(t)).toBe(h);
  });

  it('por defecto vence en 7 días y nunca pasa de 30', () => {
    expect(clampShareDays(undefined)).toBe(SHARE_DEFAULT_DAYS);
    expect(clampShareDays(0)).toBe(SHARE_DEFAULT_DAYS);
    expect(clampShareDays(400)).toBe(SHARE_MAX_DAYS);
    const now = new Date('2026-10-12T12:00:00Z');
    expect(shareExpiry(now, undefined).toISOString()).toBe('2026-10-19T12:00:00.000Z');
  });

  it('estado: activo, vencido, revocado (revocado gana)', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    const base = { expiresAt: '2026-10-13T00:00:00Z', revokedAt: null };
    expect(shareState(base, now)).toBe('active');
    expect(shareState({ ...base, expiresAt: '2026-10-12T12:00:00Z' }, now)).toBe('expired');
    expect(shareState({ ...base, expiresAt: 'nonsense' }, now)).toBe('expired');
    expect(shareState({ ...base, revokedAt: '2026-10-12T11:00:00Z' }, now)).toBe('revoked');
    expect(shareState({ expiresAt: '2020-01-01', revokedAt: '2026-01-01' }, now)).toBe('revoked');
  });

  it('sólo la dueña o quien administra comparte y revoca', () => {
    const task = { userId: 'u1' };
    expect(canShareTask({ id: 'u1', isManager: false }, task)).toBe(true);
    expect(canShareTask({ id: 'u2', isManager: true }, task)).toBe(true);
    expect(canShareTask({ id: 'u2', isManager: false }, task)).toBe(false);
    expect(canRevokeShare({ id: 'u3', isManager: false }, { createdBy: 'u3' }, task)).toBe(true);
    expect(canRevokeShare({ id: 'u3', isManager: false }, { createdBy: 'u1' }, task)).toBe(false);
  });
});

const inv = (
  toolName: string,
  args: unknown,
  result: unknown,
  id = `${toolName}-${Math.random()}`,
) => ({ toolCallId: id, toolName, state: 'result', args, result });

describe('buildSnapshot', () => {
  const base = {
    title: 'Concilia el banco',
    request: 'Concilia el banco de ana@empresa.co',
    status: 'done',
    startedAt: null,
    finishedAt: null,
    companyName: 'Acme',
    ownerName: 'Ana',
    answer: 'Listo. Escribe a pedro@acme.co. password: zzz999',
    hidePersonal: true,
    includeShots: true,
  };

  it('nunca lleva los argumentos ni los resultados crudos de las herramientas', () => {
    const { snapshot } = buildSnapshot({
      ...base,
      invocations: [
        inv(
          'siigo.list_invoices',
          { nit: '900123456', apiKey: 'TOPSECRET99' },
          { rows: [{ secret: 'RAW' }] },
        ),
        inv('browser.open_page', { url: 'https://dian.gov.co/x?token=ABC' }, { ok: true }),
      ],
    });
    const json = JSON.stringify(snapshot);
    expect(json).not.toMatch(/TOPSECRET99|900123456|RAW|token=ABC/);
    expect(snapshot.steps).toHaveLength(2);
    expect(snapshot.steps[1]?.sentence).toContain('dian.gov.co');
  });

  it('oculta datos personales de la petición y la respuesta, y las claves siempre', () => {
    const { snapshot } = buildSnapshot({ ...base, invocations: [] });
    expect(snapshot.request).toContain('[correo oculto]');
    expect(snapshot.answer).toContain('[correo oculto]');
    expect(snapshot.answer).not.toContain('zzz999');
    const open = buildSnapshot({ ...base, hidePersonal: false, invocations: [] }).snapshot;
    expect(open.answer).toContain('pedro@acme.co');
    expect(open.answer).not.toContain('zzz999');
  });

  it('una herramienta de credenciales no dice nada más', () => {
    const { snapshot } = buildSnapshot({
      ...base,
      invocations: [inv('vault.get_credential', { name: 'banco' }, { value: 'P@ss' })],
    });
    expect(snapshot.steps[0]?.sentence).toBe('Usó una credencial protegida');
    expect(JSON.stringify(snapshot)).not.toContain('P@ss');
  });

  it('pedir una clave no deja captura ni la etiqueta del secreto', () => {
    const { snapshot, shots } = buildSnapshot({
      ...base,
      invocations: [
        inv(
          'browser.request_secret',
          { label: 'Clave DIAN' },
          { screenshot: '/api/browser/live/s1/shot/a1' },
        ),
        inv(
          'browser.read_page',
          {},
          { screenshot: '/api/browser/live/s1/shot/a2', page: { title: 'Inicio' } },
        ),
      ],
    });
    expect(snapshot.steps[0]?.sentence).toBe('Pidió una clave a la persona');
    expect(snapshot.steps[0]?.shot).toBeNull();
    expect(shots).toEqual([{ key: 'p0', sessionId: 's1', shotId: 'a2' }]);
    expect(snapshot.steps[1]?.shot).toBe('p0');
  });

  it('sin capturas incluidas no pide ninguna', () => {
    const { shots } = buildSnapshot({
      ...base,
      includeShots: false,
      invocations: [inv('browser.read_page', {}, { screenshot: '/api/browser/live/s1/shot/a2' })],
    });
    expect(shots).toHaveLength(0);
  });

  it('el plan sale de cortex.plan y esa herramienta no es un paso', () => {
    const { snapshot } = buildSnapshot({
      ...base,
      invocations: [
        inv(
          'cortex.plan',
          {},
          { title: 'Plan', steps: [{ id: 'a', label: 'Leer el extracto', status: 'done' }] },
        ),
      ],
    });
    expect(snapshot.plan?.steps[0]?.label).toBe('Leer el extracto');
    expect(snapshot.steps).toHaveLength(0);
  });

  it('parseSnapshot rechaza lo que no es una foto', () => {
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot({ version: 2 })).toBeNull();
    expect(parseSnapshot(buildSnapshot({ ...base, invocations: [] }).snapshot)).not.toBeNull();
  });

  it('parseShotPath sólo acepta la ruta del proxy', () => {
    expect(parseShotPath('/api/browser/live/abc/shot/def')).toEqual({
      sessionId: 'abc',
      shotId: 'def',
    });
    expect(parseShotPath('https://evil.test/a')).toBeNull();
    expect(parseShotPath('/api/browser/live/../shot/x')).toBeNull();
    expect(parseShotPath(null)).toBeNull();
  });
});
