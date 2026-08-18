import { describe, expect, it } from 'vitest';
import { safeNextPath, workspaceLanding } from './invite-landing';

/**
 * Las dos decisiones del aterrizaje. Ninguna de las dos falla de forma visible
 * cuando se equivoca —una fabrica un espacio de más, la otra manda a alguien a
 * la pantalla equivocada— así que este archivo es el único sitio donde se ven.
 */

const NADA = { activeMembershipId: null, firstMembershipId: null, pendingInvitationId: null };

describe('workspaceLanding', () => {
  it('sin membresía y CON invitación pendiente, no fabrica: manda a aceptar', () => {
    // El caso entero: es lo que le pasaba al invitado, y lo que se corrige.
    expect(workspaceLanding({ ...NADA, pendingInvitationId: 'inv-1' })).toEqual({
      action: 'accept-invitation',
      invitationId: 'inv-1',
    });
  });

  it('sin membresía y sin invitación, este es su primer espacio', () => {
    expect(workspaceLanding(NADA)).toEqual({ action: 'provision' });
  });

  it('la membresía activa gana, aunque haya invitación pendiente a otro sitio', () => {
    // Si no ganara, la persona iría a parar a una pantalla de invitación cada
    // vez que abre el producto, por algo que a lo mejor no piensa aceptar.
    expect(
      workspaceLanding({
        activeMembershipId: 'org-activa',
        firstMembershipId: 'org-primera',
        pendingInvitationId: 'inv-1',
      }),
    ).toEqual({ action: 'use', organizationId: 'org-activa' });
  });

  it('sin activa, cae a la primera membresía antes que a la invitación', () => {
    expect(
      workspaceLanding({
        activeMembershipId: null,
        firstMembershipId: 'org-primera',
        pendingInvitationId: 'inv-1',
      }),
    ).toEqual({ action: 'use', organizationId: 'org-primera' });
  });

  it('quien ya tiene espacio propio NUNCA se queda sin entrar', () => {
    expect(workspaceLanding({ ...NADA, firstMembershipId: 'org-1' })).toEqual({
      action: 'use',
      organizationId: 'org-1',
    });
  });
});

describe('safeNextPath — deja pasar', () => {
  it('la ruta interna que trae una invitación', () => {
    expect(safeNextPath('/accept-invitation/abc-123')).toBe('/accept-invitation/abc-123');
  });

  it('una ruta interna con query', () => {
    expect(safeNextPath('/reports?id=7')).toBe('/reports?id=7');
  });
});

describe('safeNextPath — no deja pasar', () => {
  it('nada cuando no se pidió nada', () => {
    expect(safeNextPath(null)).toBeNull();
    expect(safeNextPath(undefined)).toBeNull();
    expect(safeNextPath('')).toBeNull();
  });

  it('la raíz, que ya es el defecto de quien llama', () => {
    expect(safeNextPath('/')).toBeNull();
  });

  /**
   * El grupo que importa. Cada una de estas es una redirección abierta: manda a
   * la persona a un dominio ajeno recién autenticada, con un enlace que salió
   * del dominio en el que confía.
   */
  it('un dominio ajeno, en todas sus formas', () => {
    expect(safeNextPath('https://evil.com')).toBeNull();
    expect(safeNextPath('http://evil.com')).toBeNull();
    // Protocolo relativo: el navegador lo resuelve a otro host.
    expect(safeNextPath('//evil.com')).toBeNull();
    // La variante con barra invertida, que los navegadores normalizan a `//`.
    expect(safeNextPath('/\\evil.com')).toBeNull();
    expect(safeNextPath('evil.com')).toBeNull();
  });

  it('un esquema ejecutable', () => {
    expect(safeNextPath('javascript:alert(1)')).toBeNull();
    expect(safeNextPath('data:text/html,<script>')).toBeNull();
  });

  it('el mismo ataque con basura invisible delante, que es como se rodea la guarda', () => {
    expect(safeNextPath('\n//evil.com')).toBeNull();
    expect(safeNextPath('\t\thttps://evil.com')).toBeNull();
    expect(safeNextPath('  //evil.com')).toBeNull();
    // Y con control delante de una ruta buena, sigue siendo buena.
    expect(safeNextPath('\n/accept-invitation/x')).toBe('/accept-invitation/x');
  });

  it('algo absurdamente largo', () => {
    expect(safeNextPath(`/${'a'.repeat(600)}`)).toBeNull();
  });
});
