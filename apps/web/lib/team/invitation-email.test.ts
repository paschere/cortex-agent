import { describe, expect, it } from 'vitest';
import { invitationSubject, renderInvitationEmail } from './invitation-email';

const base = {
  inviterName: 'Ana Restrepo',
  organizationName: 'Transportes del Valle',
  role: 'member',
  url: 'https://app.cortex.test/accept-invitation/inv_123',
  expiresAt: '2026-10-10T20:20:00.000Z',
};

describe('el correo de invitación', () => {
  it('dice quién invita y a qué empresa, en el asunto y en el cuerpo', () => {
    const mail = renderInvitationEmail(base);
    expect(mail.subject).toBe('Ana Restrepo te invitó a Transportes del Valle en Cortex');
    expect(mail.text).toContain('Ana Restrepo te invitó a unirte a Transportes del Valle');
    expect(mail.html).toContain('Transportes del Valle');
    expect(mail.html).toContain('lang="es"');
  });

  it('trae el enlace en el texto y en el botón', () => {
    const mail = renderInvitationEmail(base);
    expect(mail.text).toContain(base.url);
    expect(mail.html).toContain(`href="${base.url}"`);
  });

  it('cuenta el rol en palabras y no como `admin`', () => {
    expect(renderInvitationEmail({ ...base, role: 'admin' }).text).toContain(
      'Tu rol: Administrador.',
    );
    expect(renderInvitationEmail({ ...base, role: 'member' }).text).toContain('Tu rol: Miembro.');
  });

  it('un owner se dice Cofundador, y un rol raro baja a Miembro', () => {
    expect(renderInvitationEmail({ ...base, role: 'owner' }).text).toContain('Tu rol: Cofundador.');
    expect(renderInvitationEmail({ ...base, role: 'superuser' }).text).toContain(
      'Tu rol: Miembro.',
    );
    expect(renderInvitationEmail({ ...base, role: null }).text).toContain('Tu rol: Miembro.');
  });

  it('incluye el mensaje personal sólo cuando existe, y lo escapa en el HTML', () => {
    const without = renderInvitationEmail(base);
    expect(without.text).not.toContain('Mensaje de');
    const withNote = renderInvitationEmail({
      ...base,
      message: 'Bienvenida al equipo <script>alert(1)</script>',
    });
    expect(withNote.text).toContain('Mensaje de Ana Restrepo:');
    expect(withNote.html).not.toContain('<script>');
    expect(withNote.html).toContain('&lt;script&gt;');
  });

  it('corta un mensaje larguísimo', () => {
    const mail = renderInvitationEmail({ ...base, message: 'a'.repeat(5000) });
    expect(mail.text.length).toBeLessThan(2000);
    expect(mail.text).toContain('…');
  });

  it('dice cuándo vence, o los siete días si no sabe la fecha', () => {
    expect(renderInvitationEmail(base).text).toMatch(/El enlace vence el .*hora de Colombia/);
    expect(renderInvitationEmail({ ...base, expiresAt: null }).text).toContain(
      'El enlace dura 7 días.',
    );
  });

  it('no se rompe con un invitador sin nombre', () => {
    const mail = renderInvitationEmail({ ...base, inviterName: '  ' });
    expect(mail.subject).toContain('Alguien de tu equipo te invitó');
  });

  it('el asunto cabe en una línea razonable', () => {
    expect(invitationSubject('x'.repeat(400), 'Acme').length).toBeLessThanOrEqual(200);
  });
});
