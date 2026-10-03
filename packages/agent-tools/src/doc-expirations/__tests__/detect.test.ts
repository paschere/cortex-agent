import { describe, expect, it } from 'vitest';
import {
  type ExpirationClaim,
  isChamberOrRut,
  parseClaims,
  verifyClaims,
  worthReading,
} from '../detect';
import {
  DEFAULT_LEAD_DAYS,
  daysPhrase,
  deriveExpirationStatus,
  expirationTitle,
  normalizePlate,
} from '../kinds';

const TODAY = '2026-10-03';

const SOAT_TEXT = `SEGURO OBLIGATORIO DE ACCIDENTES DE TRÁNSITO - SOAT
Póliza No. 1234567890  Aseguradora: Seguros del Estado S.A.
Placa: WGY 482   Clase: Camión
INICIO DE VIGENCIA 10/05/2026 00:00 FIN DE VIGENCIA 09/05/2027 23:59`;

const POLICY_TEXT = `PÓLIZA DE RESPONSABILIDAD CIVIL EXTRACONTRACTUAL No. RC-88213
Tomador: Transportes Andinos S.A.S.  Aseguradora: Seguros Bolívar
La presente póliza tiene una vigencia de doce meses desde el 1 de abril de 2026.`;

const chunks = (text: string) => [{ id: 'chunk-1', chunk_index: 0, content: text }];

function claim(over: Partial<ExpirationClaim>): ExpirationClaim {
  return {
    kind: 'soat',
    label: null,
    kindQuote: 'SEGURO OBLIGATORIO DE ACCIDENTES DE TRÁNSITO - SOAT',
    subjectKind: 'vehiculo',
    subject: 'WGY 482',
    issuer: 'Seguros del Estado S.A.',
    number: '1234567890',
    issuedOn: '2026-05-10',
    issuedQuote: 'INICIO DE VIGENCIA 10/05/2026',
    expiresOn: '2027-05-09',
    expiresQuote: 'FIN DE VIGENCIA 09/05/2027 23:59',
    ...over,
  };
}

describe('el filtro gratis', () => {
  it('deja pasar un SOAT', () => {
    expect(worthReading(SOAT_TEXT).ok).toBe(true);
  });

  it('no paga por un texto sin fechas ni por uno que no habla de vigencia', () => {
    expect(worthReading('Acta de reunión del comité. Asistentes: Ana, Luis.').ok).toBe(false);
    expect(worthReading('Factura FE-4471 del 02/09/2026, total $1.500.000').ok).toBe(false);
  });

  it('reconoce un certificado de Cámara de Comercio y un RUT', () => {
    expect(
      isChamberOrRut(
        'CÁMARA DE COMERCIO DE BOGOTÁ. CERTIFICADO DE EXISTENCIA Y REPRESENTACIÓN LEGAL',
      ),
    ).toBe(true);
    expect(isChamberOrRut('Formulario del Registro Único Tributario')).toBe(true);
    expect(isChamberOrRut(SOAT_TEXT)).toBe(false);
  });
});

describe('parseClaims', () => {
  it('lee la respuesta del modelo aunque traiga texto alrededor', () => {
    const raw = `Aquí va:\n{"items":[{"kind":"soat","subject":"WGY482","expiresOn":"2027-05-09","expiresQuote":"FIN DE VIGENCIA 09/05/2027"}]}`;
    const [c] = parseClaims(raw);
    expect(c?.kind).toBe('soat');
    expect(c?.expiresOn).toBe('2027-05-09');
  });

  it('una respuesta rota es una lista vacía, no un error', () => {
    expect(parseClaims('no sé')).toEqual([]);
    expect(parseClaims('{"items": "x"}')).toEqual([]);
  });
});

describe('verifyClaims: la puerta', () => {
  it('un SOAT con todo escrito sale con confianza alta, la placa normalizada y su cita', () => {
    const [v] = verifyClaims([claim({})], chunks(SOAT_TEXT), TODAY);
    expect(v?.kind).toBe('soat');
    expect(v?.subject).toBe('WGY482');
    expect(v?.expiresOn).toBe('2027-05-09');
    expect(v?.expiresQuote).toBe('FIN DE VIGENCIA 09/05/2027 23:59');
    expect(v?.issuedOn).toBe('2026-05-10');
    expect(v?.confidence).toBe('alta');
    expect(v?.reviewNote).toBeNull();
  });

  it('rechaza una fecha CALCULADA: la póliza queda sin fecha y en baja', () => {
    const [v] = verifyClaims(
      [
        claim({
          kind: 'poliza',
          kindQuote: 'PÓLIZA DE RESPONSABILIDAD CIVIL EXTRACONTRACTUAL No. RC-88213',
          subjectKind: 'empresa',
          subject: null,
          issuer: 'Seguros Bolívar',
          number: 'RC-88213',
          issuedOn: null,
          issuedQuote: '',
          expiresOn: '2027-04-01',
          expiresQuote: 'una vigencia de doce meses desde el 1 de abril de 2026',
        }),
      ],
      chunks(POLICY_TEXT),
      TODAY,
    );
    expect(v?.expiresOn).toBeNull();
    expect(v?.confidence).toBe('baja');
    expect(v?.reviewNote).toMatch(/calculada/);
    expect(v?.issuer).toBe('Seguros Bolívar');
  });

  it('una cita que no está en el documento no vale', () => {
    const [v] = verifyClaims(
      [claim({ expiresQuote: 'vigente hasta el 9 de mayo de 2027' })],
      chunks(SOAT_TEXT),
      TODAY,
    );
    expect(v?.expiresOn).toBeNull();
    expect(v?.reviewNote).toMatch(/no encontré escrita/);
  });

  it('si el modelo toma el comienzo por el fin, manda la cita', () => {
    const [v] = verifyClaims(
      [
        claim({
          expiresOn: '2026-05-10',
          expiresQuote: 'INICIO DE VIGENCIA 10/05/2026 00:00 FIN DE VIGENCIA 09/05/2027 23:59',
        }),
      ],
      chunks(SOAT_TEXT),
      TODAY,
    );
    expect(v?.expiresOn).toBe('2027-05-09');
    expect(v?.confidence).not.toBe('alta');
  });

  it('una placa que no aparece en el documento no se inventa', () => {
    const [v] = verifyClaims([claim({ subject: 'ABC123' })], chunks(SOAT_TEXT), TODAY);
    expect(v?.subject).toBeNull();
    expect(v?.reviewNote).toMatch(/placa/);
  });

  it('el emisor y el número sólo si están escritos', () => {
    const [v] = verifyClaims([claim({ issuer: 'Sura', number: '999' })], chunks(SOAT_TEXT), TODAY);
    expect(v?.issuer).toBeNull();
    expect(v?.number).toBeNull();
  });

  it('dos propuestas del mismo papel son una', () => {
    expect(verifyClaims([claim({}), claim({})], chunks(SOAT_TEXT), TODAY)).toHaveLength(1);
  });
});

describe('kinds', () => {
  it('las anticipaciones por defecto son las del trámite', () => {
    expect(DEFAULT_LEAD_DAYS.soat).toBe(30);
    expect(DEFAULT_LEAD_DAYS.tecnomecanica).toBe(30);
    expect(DEFAULT_LEAD_DAYS.poliza).toBe(45);
    expect(DEFAULT_LEAD_DAYS.contrato).toBe(60);
    expect(DEFAULT_LEAD_DAYS.licencia).toBe(60);
  });

  it('el estado sale de la fecha, y renovado/descartado son decisiones', () => {
    const base = { renewal_lead_days: 30 };
    expect(deriveExpirationStatus({ ...base, expires_on: '2026-12-31' }, TODAY)).toBe('vigente');
    expect(deriveExpirationStatus({ ...base, expires_on: '2026-10-20' }, TODAY)).toBe('por_vencer');
    expect(deriveExpirationStatus({ ...base, expires_on: '2026-10-02' }, TODAY)).toBe('vencido');
    expect(
      deriveExpirationStatus({ ...base, expires_on: '2026-10-02', status: 'renovado' }, TODAY),
    ).toBe('renovado');
  });

  it('frases, títulos y placas', () => {
    expect(daysPhrase('2026-10-03', TODAY)).toBe('vence hoy');
    expect(daysPhrase('2026-10-13', TODAY)).toBe('vence en 10 días');
    expect(daysPhrase('2026-09-30', TODAY)).toBe('venció hace 3 días');
    expect(daysPhrase(null, TODAY)).toBe('sin fecha');
    expect(expirationTitle({ kind: 'soat', subject: 'WGY482' })).toBe('SOAT · WGY482');
    expect(normalizePlate('wgy-482')).toBe('WGY482');
    expect(normalizePlate('ABC12D')).toBe('ABC12D');
    expect(normalizePlate('1234')).toBeNull();
  });
});
