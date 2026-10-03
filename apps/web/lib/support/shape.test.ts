import { describe, expect, it } from 'vitest';
import {
  browserLabel,
  draftProblem,
  operatorEmails,
  sanitizeContext,
  screenshotProblem,
  supportChannel,
  supportEmail,
} from './shape';

describe('el canal de soporte', () => {
  it('sólo «off» lo apaga', () => {
    expect(supportChannel(undefined)).toBe('email');
    expect(supportChannel('email')).toBe('email');
    expect(supportChannel(' OFF ')).toBe('off');
  });

  it('los operadores salen de la lista, en minúsculas y sin basura', () => {
    expect([...operatorEmails(' Ana@Cortex.co, ,no-es-correo,b@x.co')]).toEqual([
      'ana@cortex.co',
      'b@x.co',
    ]);
  });
});

describe('el formulario', () => {
  it('pide asunto y un mensaje con algo de contexto', () => {
    expect(draftProblem({ subject: 'x', message: 'Algo pasó con el extracto' })).toMatch(/asunto/);
    expect(draftProblem({ subject: 'Extracto', message: 'mal' })).toMatch(/más/);
    expect(
      draftProblem({ subject: 'Extracto', message: 'No me deja subir el archivo' }),
    ).toBeNull();
  });

  it('el pantallazo es una imagen de hasta 5 MB, y es opcional', () => {
    expect(screenshotProblem(null)).toBeNull();
    expect(screenshotProblem({ size: 10, type: 'application/pdf' })).toMatch(/PNG/);
    expect(screenshotProblem({ size: 6 * 1024 * 1024, type: 'image/png' })).toMatch(/5 MB/);
    expect(screenshotProblem({ size: 1000, type: 'image/webp' })).toBeNull();
  });
});

describe('el contexto que adjunta la app', () => {
  it('se recorta y descarta lo que no es texto', () => {
    const ctx = sanitizeContext({
      route: '/pagar',
      userAgent: 'x'.repeat(900),
      viewport: 1280,
      recentErrors: ['a', 2, 'b', 'c', 'd', 'e', 'f'],
      secreto: 'no debe pasar',
    });
    expect(ctx.route).toBe('/pagar');
    expect(ctx.userAgent?.length).toBe(500);
    expect(ctx.viewport).toBeUndefined();
    expect(ctx.recentErrors).toEqual(['b', 'c', 'd', 'e', 'f']);
    expect(ctx).not.toHaveProperty('secreto');
  });

  it('una ruta que no es interna no se guarda', () => {
    expect(sanitizeContext({ route: 'https://evil.example' }).route).toBeUndefined();
    expect(sanitizeContext(null)).toEqual({});
  });

  it('el navegador en palabras', () => {
    expect(
      browserLabel(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
      ),
    ).toBe('Chrome 129 en macOS');
    expect(browserLabel(null)).toBe('Navegador desconocido');
  });
});

describe('el correo a soporte', () => {
  it('trae el caso, la empresa, la pantalla, el mensaje y los errores', () => {
    const mail = supportEmail({
      number: 42,
      subject: 'No sube el extracto',
      message: 'Sale un error al subir.',
      organizationName: 'Acme',
      organizationId: 'org_1',
      fromEmail: 'ana@acme.co',
      fromName: 'Ana',
      context: { route: '/payments', recentErrors: ['TypeError: x'] },
      hasScreenshot: true,
      inboxUrl: 'https://app.example/overview/soporte',
    });
    expect(mail.subject).toBe('[Soporte Cortex #42] No sube el extracto');
    expect(mail.text).toContain('Empresa: Acme (org_1)');
    expect(mail.text).toContain('Pantalla: /payments');
    expect(mail.text).toContain('Sale un error al subir.');
    expect(mail.text).toContain('- TypeError: x');
    expect(mail.text).toContain('pantallazo');
    expect(mail.text).toContain('https://app.example/overview/soporte');
  });
});
