import { describe, expect, it } from 'vitest';
import {
  type FVal,
  evaluateFormula,
  parseDateText,
  parseFormula,
  parseLooseNumber,
  roundTo,
} from './formula';

const NOW = { today: '2026-10-16', now: '14:30' };

function run(src: string, fields: Record<string, FVal> = {}) {
  return evaluateFormula(src, {
    ...NOW,
    get: (name) => (Object.hasOwn(fields, name) ? fields[name] : undefined),
  });
}
const val = (src: string, fields: Record<string, FVal> = {}) => run(src, fields).value;
const d = (s: string) => parseDateText(s) as FVal;

describe('precedencia y operadores', () => {
  it('× y ÷ antes que + y −', () => {
    expect(val('2 + 3 * 4')).toBe(14);
    expect(val('10 - 4 / 2')).toBe(8);
    expect(val('2 + 3 × 4 − 1')).toBe(13);
    expect(val('20 ÷ 4 ÷ 5')).toBe(1);
  });
  it('paréntesis', () => {
    expect(val('(2 + 3) * 4')).toBe(20);
    expect(val('((1+2)*(3+4))')).toBe(21);
  });
  it('potencia asociativa por la derecha y más fuerte que el menos unario', () => {
    expect(val('2 ^ 3 ^ 2')).toBe(512);
    expect(val('-2 ^ 2')).toBe(-4);
    expect(val('2 ^ -1')).toBe(0.5);
  });
  it('menos unario y signos repetidos', () => {
    expect(val('-5 + 3')).toBe(-2);
    expect(val('--5')).toBe(5);
    expect(val('3 - -2')).toBe(5);
  });
  it('porcentajes', () => {
    expect(val('20%')).toBe(0.2);
    expect(val('200 * 15%')).toBe(30);
    expect(val('(10 + 10)%')).toBe(0.2);
    expect(val('50%%')).toBe(0.005);
  });
  it('comparaciones y &', () => {
    expect(val('3 > 2')).toBe(true);
    expect(val('3 <= 2')).toBe(false);
    expect(val('2 = 2')).toBe(true);
    expect(val('2 <> 2')).toBe(false);
    expect(val('2 != 3')).toBe(true);
    expect(val('"Hola " & "mundo"')).toBe('Hola mundo');
    expect(val('1 + 1 = 2')).toBe(true);
    expect(val('"a" & 1 + 1')).toBe('a2');
  });
  it('0,1 + 0,2 no deja basura de coma flotante al guardar (se compara con tolerancia)', () => {
    expect(val('0,1 + 0,2') as number).toBeCloseTo(0.3, 10);
  });
});

describe('números colombianos', () => {
  it('coma decimal', () => {
    expect(val('1,5 + 1,5')).toBe(3);
    expect(val('2,25 * 2')).toBe(4.5);
  });
  it('punto decimal también', () => {
    expect(val('1.5 + 1')).toBe(2.5);
    expect(val('0.5')).toBe(0.5);
  });
  it('puntos de miles', () => {
    expect(val('1.500')).toBe(1500);
    expect(val('1.234.567,89')).toBe(1234567.89);
    expect(val('12.345 + 1')).toBe(12346);
  });
  it('parseLooseNumber lee textos con formato colombiano', () => {
    expect(parseLooseNumber('1.250,50')).toBe(1250.5);
    expect(parseLooseNumber('$ 3.000')).toBe(3000);
    expect(parseLooseNumber('12,5')).toBe(12.5);
    expect(parseLooseNumber('abc')).toBeNull();
    expect(parseLooseNumber('')).toBeNull();
  });
  it('argumentos separados por ; y por coma con espacio', () => {
    expect(val('max(1,5; 2)')).toBe(2);
    expect(val('max(1; 5)')).toBe(5);
    expect(val('max(1, 5)')).toBe(5);
  });
  it('1,5 sin espacio es un número y no dos argumentos: error con pista', () => {
    const r = run('redondear(1,5)');
    expect(r.value).toBe(2);
    const p = parseFormula('si(1,5)');
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.message).toMatch(/«;»/);
  });
});

describe('referencias a campos', () => {
  const f = { Kilos: 10, Tarifa: 2500, kilos: 10, 'Valor unitario': 3 };
  it('por nombre visible entre corchetes', () => {
    expect(val('[Kilos] × [Tarifa]', f)).toBe(25000);
    expect(val('[Valor unitario] * 2', f)).toBe(6);
  });
  it('por clave sin corchetes', () => {
    expect(val('kilos * 2', f)).toBe(20);
  });
  it('un campo inexistente es un error en español', () => {
    const r = run('[Nada] + 1', f);
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/No existe el campo «Nada»/);
  });
  it('refs listadas sin repetir', () => {
    const p = parseFormula('[A] + [A] * b');
    expect(p.ok && p.formula.refs).toEqual(['A', 'b']);
  });
  it('un campo vacío deja el resultado vacío (sin error)', () => {
    const r = run('[Kilos] * [Tarifa]', { Kilos: 3, Tarifa: null });
    expect(r.value).toBeNull();
    expect(r.error).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });
});

describe('división por cero', () => {
  it('queda vacío con aviso', () => {
    const r = run('[a] / [b]', { a: 5, b: 0 });
    expect(r.value).toBeNull();
    expect(r.warnings).toEqual(['No se puede dividir entre cero.']);
    expect(r.error).toBeUndefined();
  });
  it('residuo entre cero también', () => {
    const r = run('residuo(5; 0)');
    expect(r.value).toBeNull();
    expect(r.warnings.length).toBe(1);
  });
  it('si() sólo calcula la rama elegida', () => {
    const r = run('si([b] = 0; 0; [a] / [b])', { a: 5, b: 0 });
    expect(r.value).toBe(0);
    expect(r.warnings).toEqual([]);
  });
  it('si_error usa la alternativa y limpia el aviso', () => {
    const r = run('si_error([a] / [b]; -1)', { a: 5, b: 0 });
    expect(r.value).toBe(-1);
    expect(r.warnings).toEqual([]);
    expect(val('si_error([a] / [b]; -1)', { a: 6, b: 3 })).toBe(2);
  });
  it('raíz de negativo avisa', () => {
    const r = run('raiz(-4)');
    expect(r.value).toBeNull();
    expect(r.warnings.length).toBe(1);
  });
});

describe('funciones', () => {
  it('redondear (0,5 sube, también 1,005)', () => {
    expect(val('redondear(2,5)')).toBe(3);
    expect(val('redondear(-2,5)')).toBe(-3);
    expect(val('redondear(1,005; 2)')).toBe(1.01);
    expect(val('redondear(1234,5678; 2)')).toBe(1234.57);
    expect(roundTo(0.1 + 0.2, 6)).toBe(0.3);
  });
  it('redondear_mas / redondear_menos / entero', () => {
    expect(val('redondear_mas(2,1)')).toBe(3);
    expect(val('redondear_menos(2,9)')).toBe(2);
    expect(val('redondear_mas(2,301; 2)')).toBe(2.31);
    expect(val('entero(7,9)')).toBe(7);
  });
  it('abs, min, max, suma, promedio ignoran vacíos', () => {
    expect(val('abs(-3)')).toBe(3);
    expect(val('min(4; 2; 9)')).toBe(2);
    expect(val('max([a]; [b]; 1)', { a: null, b: 7 })).toBe(7);
    expect(val('suma([a]; [b]; 5)', { a: null, b: 7 })).toBe(12);
    expect(val('promedio(2; 4; [x])', { x: null })).toBe(3);
    expect(val('max([a])', { a: null })).toBeNull();
  });
  it('potencia y raiz', () => {
    expect(val('potencia(2; 10)')).toBe(1024);
    expect(val('raiz(81)')).toBe(9);
  });
  it('si / y / o / no', () => {
    expect(val('si([saldo] > 0; "Debe"; "Al día")', { saldo: 5 })).toBe('Debe');
    expect(val('si([saldo] > 0; "Debe"; "Al día")', { saldo: 0 })).toBe('Al día');
    expect(val('si([saldo] > 0; "Debe"; "Al día")', { saldo: null })).toBe('Al día');
    expect(val('y(1 < 2; 2 < 3)')).toBe(true);
    expect(val('o(1 > 2; 2 < 3)')).toBe(true);
    expect(val('no(1 > 2)')).toBe(true);
    expect(val('if(1 = 1; "a"; "b")')).toBe('a');
  });
  it('vacio', () => {
    expect(val('vacio([a])', { a: null })).toBe(true);
    expect(val('vacio([a])', { a: '  ' })).toBe(true);
    expect(val('vacio([a])', { a: 0 })).toBe(false);
  });
  it('textos', () => {
    expect(val('concatenar("a"; 1; "b")')).toBe('a1b');
    expect(val('concatenar([x]; "!")', { x: null })).toBe('!');
    expect(val('unir(" - "; [a]; [b]; [c])', { a: 'x', b: null, c: 'z' })).toBe('x - z');
    expect(val('mayusculas("ab")')).toBe('AB');
    expect(val('minusculas("AB")')).toBe('ab');
    expect(val('largo("hola")')).toBe(4);
    expect(val('izquierda("Bogotá"; 3)')).toBe('Bog');
    expect(val('derecha("Bogotá"; 2)')).toBe('tá');
    expect(val('reemplazar("a-b-c"; "-"; "/")')).toBe('a/b/c');
    expect(val('contiene("Avianca"; "AVIAN")')).toBe(true);
    expect(val('texto(1234,5)')).toBe('1234,5');
    expect(val('texto(2; 2)')).toBe('2,00');
    expect(val('"Total: " & 12,5')).toBe('Total: 12,5');
  });
  it('un texto numérico entra en las cuentas', () => {
    expect(val('[t] * 2', { t: '1.250,50' })).toBe(2501);
  });
  it('un texto que no es número es un error en español', () => {
    const r = run('[t] * 2', { t: 'hola' });
    expect(r.value).toBeNull();
    expect(r.error).toMatch(/«t» no es un número/);
  });
  it('alias en inglés', () => {
    expect(val('round(2,5)')).toBe(3);
    expect(val('SUM(1;2)')).toBe(3);
  });
});

describe('fechas y horas', () => {
  it('hoy() y ahora() salen del contexto', () => {
    expect(val('hoy()')).toEqual(d('2026-10-16'));
    expect(val('ahora()')).toEqual(d('2026-10-16 14:30'));
  });
  it('dias_entre cuenta días de calendario', () => {
    expect(val('dias_entre([a]; [b])', { a: d('2026-10-01'), b: d('2026-10-16') })).toBe(15);
    expect(val('dias_entre([a]; hoy())', { a: d('2026-10-20') })).toBe(-4);
    expect(val('dias_entre("2026-02-27"; "2026-03-02")')).toBe(3);
  });
  it('fecha − fecha = días; fecha ± número = fecha', () => {
    expect(val('[b] - [a]', { a: d('2026-10-01'), b: d('2026-10-11') })).toBe(10);
    expect(val('[a] + 30', { a: d('2026-10-01') })).toEqual(d('2026-10-31'));
    expect(val('[a] - 1', { a: d('2026-03-01') })).toEqual(d('2026-02-28'));
    expect(val('sumar_dias([a]; 7)', { a: d('2026-12-30') })).toEqual(d('2027-01-06'));
  });
  it('sumar_meses respeta el fin de mes', () => {
    expect(val('sumar_meses([a]; 1)', { a: d('2026-01-31') })).toEqual(d('2026-02-28'));
    expect(val('sumar_meses([a]; -1)', { a: d('2026-03-15') })).toEqual(d('2026-02-15'));
    expect(val('fin_de_mes([a])', { a: d('2028-02-10') })).toEqual(d('2028-02-29'));
  });
  it('año, mes, día, día de la semana', () => {
    const f = { a: d('2026-10-16') };
    expect(val('año([a])', f)).toBe(2026);
    expect(val('mes([a])', f)).toBe(10);
    expect(val('dia([a])', f)).toBe(16);
    expect(val('dia_semana([a])', f)).toBe(5); // viernes
    expect(val('anio([a])', f)).toBe(2026);
  });
  it('fecha() valida el calendario', () => {
    expect(val('fecha(2026; 2; 28)')).toEqual(d('2026-02-28'));
    const r = run('fecha(2026; 2; 30)');
    expect(r.value).toBeNull();
    expect(r.warnings.length).toBe(1);
  });
  it('horas_entre con fecha y hora', () => {
    const a = val('fecha_hora([f]; [h])', { f: d('2026-10-16'), h: { k: 'time', min: 22 * 60 } });
    const b = val('fecha_hora([f]; [h])', {
      f: d('2026-10-17'),
      h: { k: 'time', min: 2 * 60 + 30 },
    });
    expect(val('horas_entre([a]; [b])', { a, b })).toBe(4.5);
    expect(val('minutos_entre([a]; [b])', { a, b })).toBe(270);
  });
  it('horas_entre entre dos horas del día', () => {
    expect(
      val('horas_entre([a]; [b])', {
        a: { k: 'time', min: 8 * 60 },
        b: { k: 'time', min: 17 * 60 + 30 },
      }),
    ).toBe(9.5);
  });
  it('mezclar fecha con hora en horas_entre es un error claro', () => {
    const r = run('horas_entre([a]; [b])', { a: d('2026-10-16'), b: { k: 'time', min: 60 } });
    expect(r.error).toMatch(/fechas con hora|horas/);
  });
  it('comparar fechas', () => {
    expect(val('[a] < hoy()', { a: d('2026-10-01') })).toBe(true);
    expect(val('[a] = "2026-10-01"', { a: d('2026-10-01') })).toBe(true);
  });
  it('hora() y minuto()', () => {
    expect(val('hora([h])', { h: { k: 'time', min: 14 * 60 + 5 } })).toBe(14);
    expect(val('minuto([h])', { h: { k: 'time', min: 14 * 60 + 5 } })).toBe(5);
  });
  it('fecha vacía → resultado vacío', () => {
    expect(val('dias_entre([a]; hoy())', { a: null })).toBeNull();
  });
  it('fechas con aritmética no válida', () => {
    expect(run('[a] * 2', { a: d('2026-10-01') }).error).toMatch(/fechas u horas/);
  });
});

describe('errores de sintaxis en español', () => {
  const msg = (src: string) => {
    const p = parseFormula(src);
    expect(p.ok).toBe(false);
    return p.ok ? '' : p.message;
  };
  it('vacía', () => expect(msg('   ')).toMatch(/vacía/));
  it('paréntesis sin cerrar', () => expect(msg('(1 + 2')).toMatch(/paréntesis/));
  it('paréntesis de más', () => expect(msg('1 + 2)')).toMatch(/Sobra/));
  it('falta operador', () => expect(msg('[a] [b]')).toMatch(/operador/));
  it('falta valor', () => expect(msg('1 +')).toMatch(/valor/));
  it('función desconocida', () => expect(msg('foo(1)')).toMatch(/No conozco la función «foo»/));
  it('aridad', () => expect(msg('si(1; 2)')).toMatch(/recibe 3/));
  it('corchete sin cerrar', () => expect(msg('[a + 1')).toMatch(/corchete/));
  it('comillas sin cerrar', () => expect(msg('"hola')).toMatch(/comillas/));
  it('símbolo raro', () => expect(msg('1 # 2')).toMatch(/símbolo/));
  it('corchetes vacíos', () => expect(msg('[] + 1')).toMatch(/vacío/));
  it('demasiado larga', () => expect(msg('1+'.repeat(300))).toMatch(/pasa de 500/));
  it('anidación excesiva', () =>
    expect(msg(`${'('.repeat(60)}1${')'.repeat(60)}`)).toMatch(/anidados|larga/));
  it('acepta un = inicial como en las hojas', () => {
    expect(val('= 1 + 1')).toBe(2);
  });
});

describe('seguridad', () => {
  it('no ejecuta código', () => {
    const p = parseFormula('constructor.constructor("return 1")()');
    expect(p.ok).toBe(false);
    expect(parseFormula('process').ok).toBe(true); // es un nombre de campo más
    expect(run('process').error).toMatch(/No existe el campo/);
    expect(run('__proto__', {}).error).toMatch(/No existe/);
  });
  it('desbordes dan vacío con aviso', () => {
    const r = run('10 ^ 400');
    expect(r.value).toBeNull();
    expect(r.warnings.length).toBe(1);
  });
});
