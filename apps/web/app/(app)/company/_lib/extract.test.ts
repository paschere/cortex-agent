import { describe, expect, it } from 'vitest';
import { findNits, findOwnLegalName, pickIdentity } from './extract';

/**
 * LO QUE SE SACA DE UN TEXTO, SIN MODELO Y SIN RED.
 *
 * NADA DE ESTE ARCHIVO PODRÍA LLAMAR A ANTHROPIC NI A VOYAGE: las tres
 * funciones que prueba reciben una cadena y devuelven subcadenas. Ése es el
 * motivo de que la extracción viva separada del recolector — es la mitad del
 * trabajo que puede equivocarse en silencio, y es la mitad que se puede afirmar
 * con ejemplos.
 *
 * Los textos de aquí están escritos como están escritos los documentos de
 * verdad: un encabezamiento de contrato colombiano nombra a DOS empresas y trae
 * DOS NIT, y el caso que hay que ganar es no confundirlos. Casi todas las
 * pruebas de este archivo son sobre cuándo NO se propone nada.
 */

const CONTRATO = [
  'CONTRATO DE PRESTACIÓN DE SERVICIOS LOGÍSTICOS',
  '',
  'Entre los suscritos, COLTRANS LOGÍSTICA S.A.S., sociedad comercial identificada con NIT 900.373.115-3, domiciliada en Bogotá D.C., representada legalmente por Ana María Gómez, quien en adelante se denominará EL OPERADOR;',
  '',
  'y ACERÍAS DEL CARIBE LTDA, identificada con NIT 830.025.281-2, con domicilio en Barranquilla, quien en adelante se denominará EL CLIENTE;',
  '',
  'Han convenido celebrar el presente contrato. El plazo de pago será de treinta (30) días calendario.',
].join('\n');

describe('findNits', () => {
  it('encuentra los NIT que llevan la palabra delante y los devuelve formateados', () => {
    const found = findNits(CONTRATO);
    expect(found.map((f) => f.value)).toEqual(['900.373.115-3', '830.025.281-2']);
  });

  it('cita el renglón donde estaba, que es lo que deja cotejarlo', () => {
    const [first] = findNits(CONTRATO);
    expect(first?.quote).toContain('COLTRANS LOGÍSTICA S.A.S.');
    expect(first?.quote).toContain('900.373.115-3');
  });

  it('acepta el NIT escrito seguido y sin puntos', () => {
    expect(findNits('Nit 9003731159-8 ').map((f) => f.value)).toEqual(['9.003.731.159-8']);
  });

  it('acepta un NIT sin dígito de verificación y le pone el que le toca', () => {
    // Sin DV no se afirma nada sobre el dígito, así que no hay nada que
    // contradecir. Con DV equivocado sí, y ése es el caso de abajo.
    expect(findNits('NIT: 900.373.115').map((f) => f.value)).toEqual(['900.373.115-3']);
  });

  it('TIRA el NIT cuyo dígito de verificación no cuadra', () => {
    // 900.373.115 implica un 3. Un 9 escrito ahí es una afirmación falsa, y una
    // afirmación falsa no es un dato incompleto: no se propone.
    expect(findNits('NIT 900.373.115-9')).toEqual([]);
  });

  it('no confunde un número que simplemente anda cerca', () => {
    expect(findNits('NIT del cliente. La factura 900.373.115-3 vence el martes.')).toEqual([]);
  });

  it('no dispara con palabras que contienen «nit»', () => {
    expect(findNits('El monitoreo 900.373.115-3 y el nitrógeno 830.025.281-2.')).toEqual([]);
  });

  it('cuenta un NIT repetido una sola vez, y se queda con la primera aparición', () => {
    const text = 'NIT 900.373.115-3 al inicio.\nMás abajo se repite el NIT 900.373.115-3.';
    const found = findNits(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.quote).toContain('al inicio');
  });

  it('no encuentra nada en un texto sin NIT, y no inventa uno', () => {
    expect(findNits('Somos una empresa de logística en Bogotá desde 2014.')).toEqual([]);
  });
});

describe('findOwnLegalName', () => {
  it('devuelve la razón social con su forma societaria, tal como está escrita', () => {
    expect(findOwnLegalName(CONTRATO, 'Coltrans Logística')?.value).toBe(
      'COLTRANS LOGÍSTICA S.A.S.',
    );
  });

  it('casa aunque la persona escriba sin tildes y en minúscula', () => {
    expect(findOwnLegalName(CONTRATO, 'coltrans logistica')?.value).toBe(
      'COLTRANS LOGÍSTICA S.A.S.',
    );
  });

  it('no le importa que la persona ya haya escrito la forma societaria', () => {
    expect(findOwnLegalName(CONTRATO, 'Coltrans Logística SAS')?.value).toBe(
      'COLTRANS LOGÍSTICA S.A.S.',
    );
  });

  it('NO devuelve la razón social de la otra parte del contrato', () => {
    // El texto trae «ACERÍAS DEL CARIBE LTDA» con todas las letras. Sin el
    // ancla del nombre tecleado, una búsqueda de «algo seguido de LTDA» la
    // habría propuesto como razón social propia la mitad de las veces.
    expect(findOwnLegalName(CONTRATO, 'Coltrans Logística')?.value).not.toContain('ACERÍAS');
  });

  it('devuelve null cuando el nombre aparece SIN forma societaria', () => {
    // Proponer «Coltrans» a quien acaba de teclear «Coltrans» es devolverle lo
    // suyo con un sello de contrato encima. Lo único que este campo aporta es
    // el «S.A.S.», y si no está, no hay campo.
    expect(findOwnLegalName('Trabajamos con Coltrans desde 2019.', 'Coltrans')).toBeNull();
  });

  it('no toma por forma societaria el principio de la palabra siguiente', () => {
    expect(findOwnLegalName('Coltrans salud ocupacional', 'Coltrans')).toBeNull();
    expect(findOwnLegalName('Coltrans limitada', 'Coltrans')?.value).toBe('Coltrans limitada');
  });

  it('devuelve null si el nombre no aparece en el texto', () => {
    expect(findOwnLegalName(CONTRATO, 'Panadería El Trigal')).toBeNull();
  });

  it('devuelve null con un nombre vacío o de una letra', () => {
    expect(findOwnLegalName(CONTRATO, '')).toBeNull();
    expect(findOwnLegalName(CONTRATO, ' A ')).toBeNull();
  });
});

describe('pickIdentity', () => {
  it('se queda con el NIT que está pegado a SU nombre, no con el del cliente', () => {
    const { legalName, nit } = pickIdentity(CONTRATO, { typedName: 'Coltrans Logística' });
    expect(legalName?.value).toBe('COLTRANS LOGÍSTICA S.A.S.');
    expect(nit?.value).toBe('900.373.115-3');
  });

  it('se queda con el del cliente si el nombre tecleado es el del cliente', () => {
    // La misma función, el mismo texto, y la respuesta correcta es la otra. Es
    // la demostración de que quien decide es el nombre y no el orden del texto.
    const { nit } = pickIdentity(CONTRATO, { typedName: 'Acerías del Caribe' });
    expect(nit?.value).toBe('830.025.281-2');
  });

  it('SE CALLA cuando no reconoce el nombre y hay más de un NIT', () => {
    // Dos NIT y ninguna forma de saber cuál es el suyo. Elegir uno sería
    // acertar a cara o cruz un dato que se cita con seguridad durante meses.
    const { legalName, nit } = pickIdentity(CONTRATO, { typedName: 'Panadería El Trigal' });
    expect(legalName).toBeNull();
    expect(nit).toBeNull();
  });

  it('acepta el único NIT del texto aunque no reconozca el nombre', () => {
    const text = 'Certificado de la empresa. NIT 900.373.115-3. Expedido en Bogotá.';
    expect(pickIdentity(text, { typedName: 'Coltrans' }).nit?.value).toBe('900.373.115-3');
  });

  it('descarta un NIT que ya se sabe de quién es', () => {
    // Los NIT de sus clientes registrados entran por aquí. Un NIT que ya tiene
    // dueño conocido no puede proponerse como propio, y con eso el «único NIT
    // del texto» del caso anterior deja de existir.
    const text = 'Certificado. NIT 900.373.115-3. Expedido en Bogotá.';
    const { nit } = pickIdentity(text, {
      typedName: 'Coltrans',
      excludeNitDigits: ['900373115'],
    });
    expect(nit).toBeNull();
  });

  it('acepta el NIT del cliente escrito con puntos en la lista de exclusión', () => {
    const text = 'Certificado. NIT 900.373.115-3.';
    expect(
      pickIdentity(text, { typedName: 'Coltrans', excludeNitDigits: ['900.373.115-3'] }).nit,
    ).toBeNull();
  });

  it('no acepta un NIT que está lejísimos de su nombre', () => {
    const text = [
      'COLTRANS S.A.S. presta servicios de logística.',
      ' '.repeat(400),
      'El proveedor del edificio tiene NIT 830.025.281-2.',
    ].join('\n');
    const { legalName, nit } = pickIdentity(text, { typedName: 'Coltrans' });
    expect(legalName?.value).toBe('COLTRANS S.A.S.');
    expect(nit).toBeNull();
  });

  it('devuelve dos nulos en un texto que no dice nada de esto', () => {
    const { legalName, nit } = pickIdentity('Acta de reunión del martes. Faltó Pedro.', {
      typedName: 'Coltrans',
    });
    expect(legalName).toBeNull();
    expect(nit).toBeNull();
  });
});
