import { describe, expect, it } from 'vitest';
import { buildClientIndex, nitVariants, resolveAgainst } from '../identity';

/**
 * La identidad del cliente, probada donde es pura.
 *
 * Lo que se prueba es lo que rompería la confianza en la ficha: que un NIT
 * escrito de cinco maneras sea el mismo, que «COLTRANS S.A.S.» y «Coltráns»
 * sean el mismo, y sobre todo que dos clientes que calzan igual NO produzcan
 * respuesta.
 */

const COLTRANS = 'c1';
const COLTRANS_CARGO = 'c2';
const NEXA = 'c3';
const NEXA_2 = 'c4';
const NEXA_LTDA = 'c5';

function index() {
  return buildClientIndex({
    clients: [
      {
        id: COLTRANS,
        name: 'Coltrans',
        legal_name: 'Colombiana de Transportes S.A.S.',
        tax_id: '890903938',
      },
      { id: COLTRANS_CARGO, name: 'Coltrans Cargo', tax_id: null },
      { id: NEXA, name: 'Nexa Logística', tax_id: '899999068' },
      // Otra empresa que, por razón social, también se pliega a «nexa».
      { id: NEXA_2, name: 'Nexa', legal_name: 'NEXA S.A.S.', tax_id: null },
      { id: NEXA_LTDA, name: 'Nexa Ltda', tax_id: null },
    ],
    aliases: [
      { client_id: COLTRANS, alias: 'COLTRANS SAS BOGOTA', verified_by: 'ana' },
      { client_id: COLTRANS, alias: 'Coltr. sin confirmar', verified_by: null },
    ],
    domains: [{ client_id: COLTRANS, domain: 'coltrans.com', verified_by: 'ana' }],
    contacts: [{ client_id: NEXA, email: 'Pagos@Nexa.co' }],
  });
}

describe('nitVariants', () => {
  it('lee el NIT con puntos, guion y DV', () => {
    expect(nitVariants('890.903.938-8')).toEqual(['890903938']);
    expect(nitVariants('890903938 8')).toEqual(['890903938']);
  });

  it('ofrece las dos lecturas cuando el DV viene pegado y cuadra', () => {
    expect(nitVariants('8909039388')).toEqual(['8909039388', '890903938']);
  });

  it('no inventa la segunda lectura si el último dígito no es el DV', () => {
    expect(nitVariants('8909039381')).toEqual(['8909039381']);
  });

  it('rechaza un DV escrito que contradice el número', () => {
    expect(nitVariants('890.903.938-3')).toEqual([]);
  });

  it('quita los ceros de relleno de algunos sistemas', () => {
    expect(nitVariants('000890903938')).toContain('890903938');
  });

  it('no confunde basura con un NIT', () => {
    expect(nitVariants('')).toEqual([]);
    expect(nitVariants('abc')).toEqual([]);
    expect(nitVariants('12')).toEqual([]);
  });
});

describe('resolveAgainst', () => {
  it('encuentra por NIT en cualquiera de sus formas, y aplica', () => {
    for (const raw of ['890903938', '890.903.938-8', '8909039388', '890903938-8']) {
      const r = resolveAgainst(index(), { taxId: raw });
      expect(r.client?.clientId).toBe(COLTRANS);
      expect(r.client?.matchedBy).toBe('tax_id');
      expect(r.applies).toBe(true);
    }
  });

  it('el NIT gana al nombre', () => {
    const r = resolveAgainst(index(), { taxId: '899999068-1', name: 'Coltrans' });
    expect(r.client?.clientId).toBe(NEXA);
  });

  it('el correo de un contacto registrado aplica, sin importar mayúsculas', () => {
    const r = resolveAgainst(index(), { email: 'pagos@nexa.co' });
    expect(r.client?.clientId).toBe(NEXA);
    expect(r.client?.matchedBy).toBe('email');
    expect(r.applies).toBe(true);
  });

  it('el dominio registrado aplica; un dominio público no identifica a nadie', () => {
    const r = resolveAgainst(index(), { email: 'carlos@coltrans.com' });
    expect(r.client?.clientId).toBe(COLTRANS);
    expect(r.client?.matchedBy).toBe('domain');
    expect(resolveAgainst(index(), { email: 'x@gmail.com' }).client).toBeNull();
  });

  it('pliega S.A.S./SAS y tildes al buscar por nombre, pero sólo propone', () => {
    for (const name of [
      'COLTRANS S.A.S.',
      'Coltráns',
      'coltrans sas',
      'Colombiana de Transportes SAS',
    ]) {
      const r = resolveAgainst(index(), { name });
      expect(r.client?.clientId).toBe(COLTRANS);
      expect(r.client?.matchedBy).toBe('name');
      expect(r.applies).toBe(false);
    }
  });

  it('un alias confirmado por una persona aplica; uno sin confirmar sólo propone', () => {
    const confirmed = resolveAgainst(index(), { name: 'Coltrans S.A.S. Bogotá' });
    expect(confirmed.client?.clientId).toBe(COLTRANS);
    expect(confirmed.client?.method).toBe('alias');
    expect(confirmed.applies).toBe(true);

    const loose = resolveAgainst(index(), { name: 'Coltr sin confirmar' });
    expect(loose.client?.clientId).toBe(COLTRANS);
    expect(loose.applies).toBe(false);
  });

  it('dos clientes que calzan igual no producen respuesta', () => {
    const r = resolveAgainst(index(), { name: 'NEXA SAS' });
    expect(r.client).toBeNull();
    expect(r.ambiguous).toBe(true);
    expect(r.candidates.map((c) => c.clientId).sort()).toEqual([NEXA_2, NEXA_LTDA]);
  });

  it('no confunde Coltrans con Coltrans Cargo', () => {
    const r = resolveAgainst(index(), { name: 'Coltrans Cargo S.A.S.' });
    expect(r.client?.clientId).toBe(COLTRANS_CARGO);
  });

  it('un NIT distinto al del cliente que el nombre señala no se vincula', () => {
    const r = resolveAgainst(index(), { name: 'Coltrans', taxId: '900123456' });
    expect(r.client).toBeNull();
    expect(r.conflict).toBe(true);
  });

  it('sin nada que comparar, no contesta', () => {
    expect(resolveAgainst(index(), {}).client).toBeNull();
    expect(resolveAgainst(index(), { name: 'XY' }).client).toBeNull();
    expect(resolveAgainst(index(), { name: 'Empresa Desconocida' }).candidates).toEqual([]);
  });
});
