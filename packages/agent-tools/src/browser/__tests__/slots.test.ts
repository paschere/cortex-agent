import { describe, expect, it } from 'vitest';
import { REDACTED, enforceSecrets, pauseForOneTimeCodes, safeInputs } from '../redact';
import {
  auditSlots,
  callerSlots,
  fillSlots,
  holesIn,
  normaliseSlot,
  slotComplaint,
} from '../slots';
import type { Step, Variable } from '../types';
import {
  consumesDocument,
  extensionOf,
  parseFileRef,
  planUploads,
  renderRef,
} from '../uploads';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LOS DATOS QUE VIAJAN ENTRE PASOS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Cada caso de este archivo salió de la misma pregunta: ¿qué pasa cuando el
 * valor NO lo escribe una persona leyendo el rótulo al lado de la casilla?
 *
 * La respuesta, sin estas reglas, no es un error: es una respuesta equivocada
 * dicha con seguridad. El portal contesta «no se encontró información», el
 * clasificador lo lee como un rechazo legítimo —el único veredicto que
 * significa «no reintentes, la respuesta va a ser la misma»— y el encargo
 * entrega, correctamente y para nada, que la empresa no tiene registros. Por un
 * guion.
 */

const slot = (over: Partial<Variable> & { name: string }): Variable => ({
  label: over.name,
  example: '',
  required: true,
  type: 'text',
  ...over,
});

const step = (over: Partial<Step> & { action: Step['action']; label: string }): Step => ({
  targets: [],
  landmarks: [],
  ...over,
});

describe('la forma que un portal espera', () => {
  it('parte el NIT de su dígito de verificación, que van en casillas distintas', () => {
    // El caso que este módulo existe para atrapar. Un Drive dice
    // «900.123.456-7»; la casilla de la DIAN quiere «900123456» y tiene OTRA
    // casilla para el 7. Mandarlo entero no falla: devuelve vacío.
    expect(normaliseSlot('nit', '900.123.456-7')).toBe('900123456');
    expect(normaliseSlot('nit', '900123456-7')).toBe('900123456');
    expect(normaliseSlot('nit', ' 900.123.456 - 7 ')).toBe('900123456');
  });

  it('no le inventa un dígito de verificación al NIT que no lo trae', () => {
    // Muchas empresas tienen el NIT escrito sin DV, y adivinar por longitud
    // le arrancaría el último dígito bueno a todas ellas. El guion es lo que
    // lleva el significado, así que el guion es lo único en lo que se confía.
    expect(normaliseSlot('nit', '900123456')).toBe('900123456');
    expect(normaliseSlot('nit', '900.123.456')).toBe('900123456');
    expect(normaliseSlot('nit', '1032456789')).toBe('1032456789');
  });

  it('lee las fechas como se escriben en Colombia, día primero', () => {
    // `new Date('03/15/2026')` decide mes primero. Aquí 03/04 es 3 de abril,
    // que es lo que quiso decir quien lo escribió y lo contrario de lo que
    // habría entendido el runtime.
    expect(normaliseSlot('date', '15/03/2026')).toBe('2026-03-15');
    expect(normaliseSlot('date', '3/4/2026')).toBe('2026-04-03');
    expect(normaliseSlot('date', '2026-3-5')).toBe('2026-03-05');
    expect(normaliseSlot('date', '2026-03-15')).toBe('2026-03-15');
  });

  it('deja quieto un año de dos dígitos en vez de adivinarlo', () => {
    // Ambiguo de una forma que ninguna suposición mejora. Que lo rechace el
    // portal a la vista es mejor que convertirlo en 1926 en silencio.
    expect(normaliseSlot('date', '15/03/26')).toBe('15/03/26');
  });

  it('vuelve dígitos un monto escrito a la colombiana', () => {
    // Los puntos agrupan y la coma es el decimal: al revés de la convención
    // inglesa, así que una limpieza ingenua produce 123 en vez de 1234567.
    expect(normaliseSlot('money', '$ 1.234.567,89')).toBe('1234567');
    expect(normaliseSlot('money', '1.234.567')).toBe('1234567');
    expect(normaliseSlot('money', 'COP 45.000')).toBe('45000');
    expect(normaliseSlot('money', '-1.500')).toBe('-1500');
  });

  it('normaliza placas y correos, y deja el texto en paz', () => {
    expect(normaliseSlot('plate', 'abc 123')).toBe('ABC123');
    expect(normaliseSlot('plate', 'ABC-123')).toBe('ABC123');
    expect(normaliseSlot('email', '  Juan.Perez@Empresa.CO ')).toBe('juan.perez@empresa.co');
    expect(normaliseSlot('text', '  Coltrans S.A.S.  ')).toBe('Coltrans S.A.S.');
  });

  it('le quita al código el espacio que le mete el celular', () => {
    // Los SMS de OTP llegan como «483 920» y la casilla toma seis dígitos.
    expect(normaliseSlot('code', '483 920')).toBe('483920');
    expect(normaliseSlot('code', ' A1B2C3 ')).toBe('A1B2C3');
  });

  it('no le cambia mayúsculas a una referencia de archivo', () => {
    // Una ruta de bucket es una cadena de máquina; normalizarla la rompe.
    expect(normaliseSlot('file', ' doc:AB12-Cd ')).toBe('doc:AB12-Cd');
  });
});

describe('llenar los huecos de un trámite', () => {
  const variables: Variable[] = [
    slot({ name: 'nit', label: 'el NIT de la empresa', type: 'nit' }),
    slot({ name: 'desde', label: 'la fecha inicial', type: 'date' }),
    slot({ name: 'nota', label: 'una nota', type: 'text', required: false }),
  ];

  it('normaliza todo lo que entra y no exige que el que llama sepa el formato', () => {
    const fill = fillSlots(variables, { nit: '900.123.456-7', desde: '01/02/2026' });
    expect(fill.inputs).toEqual({ nit: '900123456', desde: '2026-02-01' });
    expect(fill.missing).toEqual([]);
    expect(fill.unusable).toEqual([]);
  });

  it('nombra lo que falta con la etiqueta que una persona reconoce', () => {
    const fill = fillSlots(variables, { desde: '01/02/2026' });
    expect(fill.missing).toEqual(['el NIT de la empresa']);
    expect(slotComplaint(fill, 'Certificado DIAN')).toContain('el NIT de la empresa');
  });

  it('distingue «no me lo pasaron» de «me pasaron basura»', () => {
    // Dos frases distintas porque apuntan a sitios distintos: la primera al
    // pedido, la segunda a la fuente de donde salió el dato.
    const fill = fillSlots(variables, { nit: ' - ', desde: '01/02/2026' });
    expect(fill.missing).toEqual([]);
    expect(fill.unusable).toEqual(['el NIT de la empresa']);
    expect(fill.inputs.nit).toBeUndefined();
    expect(slotComplaint(fill, 'Certificado DIAN')).toContain('no sirve como dato');
  });

  it('no se traga un slot que el trámite no declaró', () => {
    // La misma regla que `safeInputs` aplica de salida, aplicada de entrada:
    // quien llama no puede meter un valor en una casilla que no existe.
    const fill = fillSlots(variables, { nit: '900123456', desde: '2026-02-01', placa: 'ABC123' });
    expect(fill.inputs.placa).toBeUndefined();
    expect(fill.unknown).toEqual(['placa']);
  });

  it('un opcional vacío no detiene nada', () => {
    const fill = fillSlots(variables, { nit: '900123456', desde: '2026-02-01', nota: '' });
    expect(slotComplaint(fill, 'Certificado DIAN')).toBeNull();
  });

  it('deja pasar cuando todo está, que es la mitad que importa', () => {
    const fill = fillSlots(variables, { nit: '900123456', desde: '2026-02-01' });
    expect(slotComplaint(fill, 'Certificado DIAN')).toBeNull();
  });
});

describe('lo que el trámite declara contra lo que de verdad usa', () => {
  const steps: Step[] = [
    step({ action: 'goto', label: 'abrir', url: 'https://x.co/consulta?nit={{nit}}' }),
    step({
      action: 'fill',
      label: 'escribir la fecha',
      value: { kind: 'template', text: '{{desde}}' },
    }),
    step({ action: 'pause', label: 'el código que te llegó', extractAs: 'codigo' }),
    step({ action: 'fill', label: 'código', value: { kind: 'template', text: '{{codigo}}' } }),
  ];

  it('encuentra los huecos en URLs, plantillas y referencias de archivo', () => {
    expect(holesIn(steps)).toEqual(['nit', 'desde', 'codigo']);
    expect(
      holesIn([step({ action: 'upload', label: 'adjuntar', value: { kind: 'file', from: '{{rut}}' } })]),
    ).toEqual(['rut']);
  });

  it('delata un hueco que nadie declaró — el que se teclea como «{{nit}}»', () => {
    const audit = auditSlots([slot({ name: 'desde', type: 'date' })], steps);
    expect(audit.undeclared).toEqual(['nit']);
  });

  it('no cuenta como huérfano el slot que llena una pausa', () => {
    // `codigo` no lo pasa nadie al arrancar: lo dicta una persona a mitad de
    // camino. Marcarlo como no declarado obligaría a pedir de antemano un
    // código que todavía no ha sido enviado.
    const audit = auditSlots(
      [slot({ name: 'nit', type: 'nit' }), slot({ name: 'desde', type: 'date' })],
      steps,
    );
    expect(audit.undeclared).toEqual([]);
  });

  it('delata una variable declarada que ningún paso teclea', () => {
    const audit = auditSlots(
      [
        slot({ name: 'nit', type: 'nit' }),
        slot({ name: 'desde', type: 'date' }),
        slot({ name: 'placa', type: 'plate' }),
      ],
      steps,
    );
    expect(audit.unused).toEqual(['placa']);
  });

  it('no le pide al que llama el dato que va a dictar una persona', () => {
    const declared = [
      slot({ name: 'nit', type: 'nit' }),
      slot({ name: 'codigo', type: 'code' }),
    ];
    expect(callerSlots(declared, steps).map((v) => v.name)).toEqual(['nit']);
  });
});

describe('el código de un solo uso no se escribe en ninguna fila', () => {
  it('lo reemplaza por *** al guardar los datos de la corrida', () => {
    // Un OTP no es una credencial —nadie lo rota, vale noventa segundos— y por
    // eso es fácil tratarlo como dato común. No lo es: durante esos noventa
    // segundos es el segundo factor de una cuenta cuyo primer factor ya está
    // cifrado en esta misma base. Escribirlo en `browser_flow_runs.inputs`,
    // que se pinta en la pantalla de historial para siempre, pondría las dos
    // mitades de un ingreso bancario en la misma página.
    const stored = safeInputs(
      { nit: '900123456', codigo: '483920' },
      [slot({ name: 'nit', type: 'nit' }), slot({ name: 'codigo', type: 'code' })],
    );
    expect(stored).toEqual({ nit: '900123456', codigo: REDACTED });
  });

  it('deja constancia de que hubo código, en vez de omitirlo', () => {
    // Ausente se leería como «esta corrida nunca necesitó uno», que es una
    // afirmación distinta y falsa.
    const stored = safeInputs({ codigo: '1' }, [slot({ name: 'codigo', type: 'code' })]);
    expect(Object.hasOwn(stored, 'codigo')).toBe(true);
  });

  it('sigue funcionando con la lista de nombres de siempre', () => {
    // La firma se ensanchó; no cambió. Todo lo que llamaba antes con nombres
    // sueltos tiene que seguir viendo exactamente lo mismo.
    expect(safeInputs({ placa: 'ABC', clave: 'x' }, ['placa'])).toEqual({ placa: 'ABC' });
  });
});

describe('lo que una grabación hace con un código que llega por SMS', () => {
  it('no lo guarda como credencial, que era una espera sin final', () => {
    // EL BUG QUE ESTO CIERRA. «Código de verificación» estaba en la lista de
    // palabras de credencial, así que el paso se reescribía como
    // {kind:'secret', field:'codigo_de_verificacion'} y el trámite quedaba
    // esperando para siempre a que alguien guardara, en una columna cifrada, un
    // número que cambia cada noventa segundos. No hay valor que alguien hubiera
    // podido poner ahí que sirviera. Se podía enseñar, revisar y vincular; no
    // se podía correr.
    const { steps } = enforceSecrets([
      step({
        action: 'fill',
        label: 'Código de verificación',
        value: { kind: 'literal', text: '483920' },
      }),
    ]);
    expect(steps[0]?.value).toEqual({
      kind: 'template',
      text: '{{codigo_de_verificacion}}',
    });
    expect(JSON.stringify(steps)).not.toContain('483920');
  });

  it('sigue tratando una contraseña como contraseña', () => {
    const { steps, redacted } = enforceSecrets([
      step({ action: 'fill', label: 'Contraseña', value: { kind: 'literal', text: 'hunter2' } }),
    ]);
    expect(redacted).toBe(1);
    expect(steps[0]?.value).toEqual({ kind: 'secret', field: 'contrasena' });
  });

  it('mete la parada que lo pide justo antes del paso que lo teclea', () => {
    // Insertada y no sugerida: quien acaba de grabar el ingreso a su banco no
    // tiene por qué saber qué es un paso `pause`, y el trámite que sale de que
    // se lo salte teclea una cadena vacía y falla a las 3 de la mañana.
    const { steps, added } = pauseForOneTimeCodes([
      step({ action: 'click', label: 'Entrar' }),
      step({
        action: 'fill',
        label: 'Código de verificación',
        value: { kind: 'template', text: '{{codigo_de_verificacion}}' },
      }),
    ]);
    expect(added).toEqual(['codigo_de_verificacion']);
    expect(steps[1]?.action).toBe('pause');
    expect(steps[1]?.extractAs).toBe('codigo_de_verificacion');
    expect(steps[2]?.action).toBe('fill');
    // Y las dos mitades encajan por construcción: la parada llena el hueco que
    // el paso siguiente teclea.
    expect(holesIn(steps)).toEqual(['codigo_de_verificacion']);
    expect(
      auditSlots([slot({ name: 'codigo_de_verificacion', type: 'code' })], steps).undeclared,
    ).toEqual([]);
  });

  it('no acumula paradas al volver a enseñar el mismo trámite', () => {
    const once = pauseForOneTimeCodes([
      step({
        action: 'fill',
        label: 'Código de verificación',
        value: { kind: 'template', text: '{{codigo_de_verificacion}}' },
      }),
    ]);
    const twice = pauseForOneTimeCodes(once.steps);
    expect(twice.added).toEqual([]);
    expect(twice.steps.filter((s) => s.action === 'pause').length).toBe(1);
  });

  it('deja en paz un dato que cambia y no es un código', () => {
    const { steps, added } = pauseForOneTimeCodes([
      step({
        action: 'fill',
        label: 'Número de placa',
        value: { kind: 'template', text: '{{placa}}' },
      }),
    ]);
    expect(added).toEqual([]);
    expect(steps.length).toBe(1);
  });
});

describe('de dónde salen los bytes de un archivo que se sube', () => {
  it('entiende las cuatro formas de nombrar un archivo', () => {
    expect(parseFileRef('download')).toEqual({ kind: 'download' });
    expect(parseFileRef('doc:3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toEqual({
      kind: 'document',
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });
    expect(parseFileRef('file:kb-uploads/abc/def.pdf')).toEqual({
      kind: 'stored',
      bucket: 'kb-uploads',
      path: 'abc/def.pdf',
    });
  });

  it('devuelve null en vez de lanzar cuando el hueco quedó sin llenar', () => {
    // Lo más común que llega mal aquí es el literal «{{factura}}», porque nadie
    // pasó ese slot. Eso tiene que volverse «me falta el archivo», que una
    // persona puede atender, y no una excepción en una pantalla.
    expect(parseFileRef('{{factura}}')).toBeNull();
    expect(parseFileRef('doc:no-es-un-uuid')).toBeNull();
    expect(parseFileRef('')).toBeNull();
    expect(parseFileRef('/etc/passwd')).toBeNull();
  });

  it('rechaza una ruta que intente salirse de la fila que nombra', () => {
    expect(parseFileRef('file:kb-uploads/../secretos/x.pdf')).toBeNull();
  });

  it('llena los huecos de la referencia con los datos de la corrida', () => {
    expect(renderRef('{{certificado}}', { certificado: 'doc:abc' })).toBe('doc:abc');
    // Un hueco sin llenar se queda visible, que es lo que lo hace diagnosticable.
    expect(renderRef('{{certificado}}', {})).toBe('{{certificado}}');
  });

  it('planea una subida por cada paso, con el índice que el servicio usa de llave', () => {
    const steps: Step[] = [
      step({ action: 'goto', label: 'abrir', url: 'https://x.co' }),
      step({ action: 'download', label: 'bajar el certificado' }),
      step({ action: 'upload', label: 'adjuntar lo bajado', value: { kind: 'file', from: 'download' } }),
      step({
        action: 'upload',
        label: 'adjuntar el RUT',
        value: { kind: 'file', from: '{{rut}}' },
      }),
    ];
    const plan = planUploads(steps, { rut: 'doc:3f2504e0-4f89-41d3-9a0c-0305e82c3301' });
    expect(plan.map((p) => p.index)).toEqual([2, 3]);
    expect(plan[0]?.ref).toEqual({ kind: 'download' });
    expect(plan[1]?.ref).toEqual({
      kind: 'document',
      id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    });
  });

  it('sabe si un trámite mete un archivo antes de haberlo corrido nunca', () => {
    expect(consumesDocument([step({ action: 'click', label: 'x' })])).toBe(false);
    expect(
      consumesDocument([step({ action: 'upload', label: 'adjuntar', value: { kind: 'file', from: 'download' } })]),
    ).toBe(true);
  });

  it('lee la extensión aunque el nombre no tenga punto', () => {
    expect(extensionOf('certificado.PDF')).toBe('pdf');
    expect(extensionOf('certificado')).toBe('');
  });
});
