/**
 * CAMPOS QUE VIENEN DE LA RUTA, NO DEL DOCUMENTO.
 *
 * Muchas carpetas se organizan así: «10.OCTUBRE / 33. FEDEX 3325 07102026 /
 * PREALERTA.pdf». El mes, el consecutivo, quién, el número y la fecha están en
 * el NOMBRE de la subcarpeta, no dentro de los documentos. Aquí se detectan, con
 * reglas generales y deterministas, las piezas que traen esos nombres:
 *
 *   - secuencia: un número al inicio seguido de punto, guion o espacio («33.»).
 *   - fecha:     DDMMAAAA, AAAAMMDD, DD-MM-AAAA, AAAA-MM-DD (con - / .), validada.
 *   - mes:       un nombre de mes en español o inglés («OCTUBRE», «sept»).
 *   - codigo:    el último token con dígitos de 2 a 8 caracteres («3325», «AV9»).
 *   - texto:     lo que sobra («FEDEX», «UPS AIRLINES»).
 *
 * Nada de esto sabe de aviación ni de ningún negocio: el modelo del chat le
 * pone el nombre que corresponde al campo («aerolínea», «vuelo», «cliente»).
 *
 * REGLA DE ORO: lo que un nombre no trae queda VACÍO. Nunca se deduce ni se
 * inventa; un nombre que no encaja deja la fila «Por revisar» con el motivo.
 */

export type PathPart = 'secuencia' | 'texto' | 'codigo' | 'fecha' | 'mes';

/** De dónde sale un campo: la pieza `part` del nombre de la subcarpeta del nivel `level` (1 = la primera). */
export interface PathRule {
  level: number;
  part: PathPart;
}

export type PathValues = Partial<Record<PathPart, string | number>>;

const MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
  ene: 1,
  feb: 2,
  mar: 3,
  abr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  ago: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dic: 12,
  jan: 1,
  apr: 4,
  aug: 8,
  dec: 12,
};

function fold(s: string): string {
  return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Busca una fecha en el texto; devuelve la ISO y el texto sin ella. */
function takeDate(text: string): { date: string | null; rest: string } {
  const tries: Array<{ re: RegExp; make: (m: RegExpExecArray) => string | null }> = [
    {
      re: /(?<!\d)(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/,
      make: (m) => isoDate(Number(m[1]), Number(m[2]), Number(m[3])),
    },
    {
      re: /(?<!\d)(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})(?!\d)/,
      make: (m) => isoDate(Number(m[3]), Number(m[2]), Number(m[1])),
    },
    {
      re: /(?<!\d)(\d{8})(?!\d)/,
      make: (m) => {
        const s = m[1] as string;
        // DDMMAAAA primero (lo habitual en español); si no es una fecha, AAAAMMDD.
        return (
          isoDate(Number(s.slice(4)), Number(s.slice(2, 4)), Number(s.slice(0, 2))) ??
          isoDate(Number(s.slice(0, 4)), Number(s.slice(4, 6)), Number(s.slice(6)))
        );
      },
    },
  ];
  for (const t of tries) {
    const m = t.re.exec(text);
    if (!m) continue;
    const date = t.make(m);
    if (date)
      return { date, rest: `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}` };
  }
  return { date: null, rest: text };
}

/** Las piezas que trae el nombre de UNA carpeta (o archivo). */
export function parseSegment(name: string): PathValues {
  const out: PathValues = {};
  let rest = name.replace(/\.[A-Za-z0-9]{2,5}$/, (ext) =>
    /^\.(pdf|docx?|xlsx?|csv|txt|jpe?g|png)$/i.test(ext) ? '' : ext,
  );
  rest = rest.trim();

  const seq = /^(\d{1,3})\s*[.\-_)]\s*(?=\S)/.exec(rest) ?? /^(\d{1,3})\s+(?=[^\d\s])/.exec(rest);
  if (seq) {
    out.secuencia = Number(seq[1]);
    rest = rest.slice(seq[0].length);
  }

  const { date, rest: noDate } = takeDate(rest);
  if (date) {
    out.fecha = date;
    rest = noDate;
  }

  const tokens = rest
    .split(/[\s_]+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);

  // Un nombre de mes (sólo si el resto del nombre no es más que eso).
  const monthIdx = tokens.findIndex((t) => MONTHS[fold(t)] !== undefined);
  const onlyMonth = tokens.length === 1 && monthIdx === 0;
  if (monthIdx >= 0 && (onlyMonth || tokens.length <= 2)) {
    out.mes = MONTHS[fold(tokens[monthIdx] as string)];
    tokens.splice(monthIdx, 1);
  }

  // El código: el último token con dígitos de 2 a 8 caracteres.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i] as string;
    if (/\d/.test(t) && t.length >= 2 && t.length <= 8) {
      out.codigo = t;
      tokens.splice(i, 1);
      break;
    }
  }

  const texto = tokens.join(' ').trim();
  if (texto && !/^\d+$/.test(texto)) out.texto = texto.slice(0, 80);
  return out;
}

const PART_LABEL: Record<PathPart, string> = {
  secuencia: 'N.º (carpeta)',
  texto: 'Nombre (carpeta)',
  codigo: 'Código (carpeta)',
  fecha: 'Fecha (carpeta)',
  mes: 'Mes (carpeta)',
};
const PART_TYPE: Record<PathPart, 'text' | 'number' | 'date'> = {
  secuencia: 'number',
  texto: 'text',
  codigo: 'text',
  fecha: 'date',
  mes: 'number',
};

export interface PathPatternExample {
  name: string;
  values: PathValues;
}

/** El patrón que siguen los nombres de las subcarpetas de un nivel. */
export interface PathPattern {
  level: number;
  /** Piezas presentes en al menos el 60 % de los nombres de ese nivel. */
  parts: PathPart[];
  /** Nombres distintos mirados en ese nivel. */
  names: number;
  /** Cuántos nombres traen todas las piezas del patrón. */
  matching: number;
  examples: PathPatternExample[];
  /** Nombres que no encajan (quedarán vacíos y por revisar). */
  unmatched: string[];
  /** Una forma legible: «N.º + nombre + código + fecha». */
  shape: string;
}

export interface PathFieldSuggestion {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date';
  rule: PathRule;
}

const MIN_SHARE = 0.6;

/**
 * Detecta, nivel por nivel, qué piezas traen los nombres de las subcarpetas.
 * `folders` son las carpetas del inventario (ruta relativa, «A / B»).
 */
export function detectPathPatterns(folders: Array<{ path: string; depth: number }>): PathPattern[] {
  const byLevel = new Map<number, Set<string>>();
  for (const f of folders) {
    const segs = f.path.split(' / ');
    const name = segs[segs.length - 1];
    if (!name) continue;
    const set = byLevel.get(f.depth) ?? new Set<string>();
    set.add(name);
    byLevel.set(f.depth, set);
  }
  const patterns: PathPattern[] = [];
  for (const [level, set] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    const names = [...set];
    if (names.length < 2) continue;
    const parsed = names.map((n) => ({ name: n, values: parseSegment(n) }));
    const parts = (Object.keys(PART_LABEL) as PathPart[]).filter(
      (p) => parsed.filter((x) => x.values[p] !== undefined).length / names.length >= MIN_SHARE,
    );
    // Un mes ya dice todo lo que dice su consecutivo y su nombre.
    const kept = parts.includes('mes')
      ? parts.filter((p) => p !== 'secuencia' && p !== 'texto')
      : parts;
    if (!kept.length) continue;
    const fits = parsed.filter((x) => kept.every((p) => x.values[p] !== undefined));
    const unmatched = parsed.filter((x) => !fits.includes(x)).map((x) => x.name);
    patterns.push({
      level,
      parts: kept,
      names: names.length,
      matching: fits.length,
      examples: (fits.length ? fits : parsed)
        .slice(0, 3)
        .map((x) => ({ name: x.name, values: x.values })),
      unmatched: unmatched.slice(0, 5),
      shape: kept.map((p) => PART_LABEL[p].replace(' (carpeta)', '').toLowerCase()).join(' + '),
    });
  }
  return patterns;
}

/** Los campos que se proponen para los patrones detectados (claves únicas por nivel). */
export function suggestPathFields(patterns: PathPattern[]): PathFieldSuggestion[] {
  const out: PathFieldSuggestion[] = [];
  const used = new Set<string>();
  for (const p of patterns) {
    for (const part of p.parts) {
      let key = part === 'mes' ? 'mes' : `${part}_carpeta`;
      if (used.has(key)) key = `${key}_${p.level}`;
      used.add(key);
      out.push({
        key,
        label: patterns.length > 1 ? `${PART_LABEL[part]} nivel ${p.level}` : PART_LABEL[part],
        type: PART_TYPE[part],
        rule: { level: p.level, part },
      });
    }
  }
  return out;
}

/** «33. FEDEX 3325 07102026 → n.º 33, nombre FEDEX, código 3325, fecha 2026-10-07». */
export function describeValues(values: PathValues): string {
  const label: Record<PathPart, string> = {
    secuencia: 'n.º',
    texto: 'nombre',
    codigo: 'código',
    fecha: 'fecha',
    mes: 'mes',
  };
  return (Object.keys(label) as PathPart[])
    .filter((p) => values[p] !== undefined)
    .map((p) => `${label[p]} ${values[p]}`)
    .join(', ');
}

/**
 * El valor de una regla para la ruta de un archivo. `undefined` cuando el nombre
 * de esa subcarpeta no trae la pieza (o el archivo está más arriba que el nivel).
 */
export function pathValue(path: string, rule: PathRule): string | number | undefined {
  const segs = path ? path.split(' / ') : [];
  const seg = segs[rule.level - 1];
  if (!seg) return undefined;
  return parseSegment(seg)[rule.part];
}
