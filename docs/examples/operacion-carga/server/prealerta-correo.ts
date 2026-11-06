/**
 * Función de servidor «prealerta-correo»: recibe un correo entrante (por el webhook
 * `prealerta-correo` cuando haya buzón) y crea prealertas con canal «Correo».
 *
 *   entrada: { asunto, de, texto, adjuntos?: [{ nombre, base64 }] }
 *   salida:  { creadas, duplicadas, sinGuia, ids }
 *
 * El servidor no tiene `docs.scan`: las guías se sacan del TEXTO del correo (con ai.ask si
 * responde; si no, línea por línea). Si no sale ninguna guía, queda UNA prealerta con el
 * asunto, el remitente, el texto y los nombres de los adjuntos, en estado «Sin vuelo», para que
 * el documental la revise en la pantalla Prealertas. Los adjuntos no se guardan aquí (la función
 * no puede subir archivos): quedan anotados por nombre. Nada se envía a la DIAN.
 */

interface Adjunto {
  nombre?: string;
  base64?: string;
}

interface Entrada {
  asunto?: string;
  de?: string;
  texto?: string;
  adjuntos?: Adjunto[];
}

interface Fila {
  id: string;
  label: string;
  values: Record<string, unknown>;
}

interface Contexto {
  log: (...a: unknown[]) => void;
  secrets: Record<string, string>;
  cortex: {
    tables: {
      list: () => Promise<{ id: string; name: string; fields: { key: string }[] }[]>;
      query: (table: string, opts?: Record<string, unknown>) => Promise<{ rows: Fila[] }>;
      insert: (table: string, values: Record<string, unknown>) => Promise<Fila>;
    };
    ai: { ask: (prompt: string, data?: unknown) => Promise<string> };
  };
}

interface Guia {
  guia: string;
  cliente: string;
  numeroVuelo: string;
  aerolinea: string;
  origen: string;
  fecha: string;
  piezas: number | null;
  kilos: number | null;
}

const MAX_TEXTO = 20_000;

const norm = (s: unknown): string =>
  String(s ?? '')
    .toUpperCase()
    .replace(/[\s\-_.\/]+/g, '')
    .trim();

const normVuelo = (s: unknown): string => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Número desde «1.234,5» o «1234.5»; null si no hay. */
function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !v.trim()) return null;
  let s = v.trim().replace(/[^\d,.\-]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const txt = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

function fechaIso(s: string): string {
  const t = s.trim();
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(t);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(t);
  if (dmy) {
    const a = dmy[3] as string;
    return `${a.length === 2 ? `20${a}` : a}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  }
  return '';
}

/** Guías en líneas «guía [piezas] [kilos]» separadas por tab, punto y coma o dos espacios. */
function porLineas(texto: string): Guia[] {
  const out: Guia[] = [];
  for (const linea of texto.split(/\r?\n/)) {
    // Una guía aérea: 3 dígitos, guion opcional y 8 dígitos (o un HAWB alfanumérico largo con dígitos).
    const m = /\b(\d{3}[-\s]?\d{8}|[A-Z]{2,4}\d{6,12})\b/.exec(linea.toUpperCase());
    if (!m) continue;
    const resto = linea.slice(linea.toUpperCase().indexOf(m[0]) + m[0].length);
    const nums = (resto.match(/\d[\d.,]*/g) ?? []).map(num).filter((n): n is number => n !== null);
    out.push({
      guia: (m[1] as string).replace(/\s+/g, ''),
      cliente: '',
      numeroVuelo: '',
      aerolinea: '',
      origen: '',
      fecha: '',
      piezas: nums.length >= 2 ? (nums[0] as number) : null,
      kilos: nums.length >= 2 ? (nums[1] as number) : (nums[0] ?? null),
    });
  }
  return out;
}

async function porIa(ctx: Contexto, asunto: string, texto: string): Promise<Guia[]> {
  const resp = await ctx.cortex.ai.ask(
    'Del siguiente correo de prealerta de carga aérea extrae TODAS las guías aéreas. Responde SOLO un arreglo JSON, sin comentarios, donde cada elemento tenga las claves: guia, cliente, numero_vuelo, aerolinea, origen, fecha (AAAA-MM-DD), piezas, kilos. Usa "" si un dato no aparece. No inventes guías.',
    { asunto, texto },
  );
  const i = resp.indexOf('[');
  const j = resp.lastIndexOf(']');
  if (i < 0 || j < i) return [];
  const arr = JSON.parse(resp.slice(i, j + 1)) as unknown;
  if (!Array.isArray(arr)) return [];
  const out: Guia[] = [];
  for (const x of arr) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const guia = txt(o.guia).toUpperCase().replace(/\s+/g, '');
    if (!guia) continue;
    out.push({
      guia,
      cliente: txt(o.cliente),
      numeroVuelo: txt(o.numero_vuelo).toUpperCase().replace(/\s+/g, ''),
      aerolinea: txt(o.aerolinea),
      origen: txt(o.origen),
      fecha: fechaIso(txt(o.fecha)),
      piezas: num(o.piezas),
      kilos: num(o.kilos),
    });
  }
  return out;
}

export default async function prealertaCorreo(input: Entrada, ctx: Contexto): Promise<{ creadas: number; duplicadas: number; sinGuia: boolean; ids: string[] }> {
  const asunto = txt(input?.asunto).slice(0, 300);
  const de = txt(input?.de).slice(0, 300);
  const texto = txt(input?.texto).slice(0, MAX_TEXTO);
  const adjuntos = (Array.isArray(input?.adjuntos) ? input.adjuntos : []).map((a) => txt(a?.nombre) || 'adjunto').slice(0, 50);
  if (!asunto && !texto && !adjuntos.length) throw new Error('El correo llegó vacío: falta asunto, texto o adjuntos.');

  // Qué campos existen (el script de datos puede no haberse aplicado todavía).
  const tablas = await ctx.cortex.tables.list();
  const campos = new Set((tablas.find((t) => t.id === 'prealertas' || t.name === 'prealertas')?.fields ?? []).map((f) => f.key));
  if (!campos.size) throw new Error('No encuentro la tabla prealertas.');
  const puesto = (vals: Record<string, unknown>): Record<string, unknown> => {
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vals)) if (v !== undefined && v !== '' && campos.has(k)) o[k] = v;
    return o;
  };

  // Guías del texto: IA primero (entiende cualquier formato), líneas como respaldo.
  let guias: Guia[] = [];
  const base = `${asunto}\n${texto}`.trim();
  if (base) {
    try {
      guias = await porIa(ctx, asunto, texto);
    } catch (e) {
      ctx.log('ai.ask no sirvió, se leen las líneas:', e instanceof Error ? e.message : e);
    }
    if (!guias.length) guias = porLineas(base);
  }

  // Vuelos para enlazar por número (y fecha si viene).
  let vuelos: Fila[] = [];
  try {
    vuelos = (await ctx.cortex.tables.query('vuelos', { order: { field: 'fecha', dir: 'desc' }, limit: 300 })).rows;
  } catch (e) {
    ctx.log('No pude leer vuelos:', e instanceof Error ? e.message : e);
  }
  const vueloDe = (g: Guia): Fila | null => {
    const n = normVuelo(g.numeroVuelo);
    if (!n) return null;
    return vuelos.find((v) => normVuelo(v.values.numero_vuelo) === n && (!g.fecha || txt(v.values.fecha).slice(0, 10) === g.fecha)) ?? null;
  };

  const ids: string[] = [];
  let duplicadas = 0;

  if (guias.length) {
    const vistas = new Set<string>();
    for (const g of guias) {
      const k = norm(g.guia);
      if (!k || vistas.has(k)) continue;
      vistas.add(k);
      // Idempotente: si ya hay una prealerta (no duplicada) con esa guía, no se crea otra.
      const ya = await ctx.cortex.tables.query('prealertas', { search: g.guia, limit: 20 });
      if (ya.rows.some((r) => norm(r.values.guia) === k && txt(r.values.estado) !== 'Duplicada')) {
        duplicadas += 1;
        continue;
      }
      const v = vueloDe(g);
      const fila = await ctx.cortex.tables.insert(
        'prealertas',
        puesto({
          guia: g.guia,
          cliente: g.cliente,
          numero_vuelo: g.numeroVuelo || (v ? txt(v.values.numero_vuelo) : ''),
          aerolinea: g.aerolinea || (v ? txt(v.values.aerolinea) : ''),
          origen: g.origen || (v ? txt(v.values.origen) : ''),
          fecha_estimada: g.fecha || (v ? txt(v.values.fecha).slice(0, 10) : ''),
          piezas: g.piezas ?? undefined,
          kilos: g.kilos ?? undefined,
          descripcion_carga: `Correo de ${de || 'remitente desconocido'}: ${asunto || '(sin asunto)'}${adjuntos.length ? ` · adjuntos: ${adjuntos.join(', ')}` : ''}`,
          canal: 'Correo',
          guia_normalizada: k,
          vuelo: v?.id,
          estado_cruce: v ? 'En vuelo' : 'Sin vuelo',
        }),
      );
      ids.push(fila.id);
    }
    return { creadas: ids.length, duplicadas, sinGuia: false, ids };
  }

  // Sin guías legibles en el texto (típico: todo viene en el adjunto): queda para revisión humana.
  const marca = `CORREO-${new Date().toISOString().slice(0, 16).replace(/\D/g, '')}`;
  const fila = await ctx.cortex.tables.insert(
    'prealertas',
    puesto({
      guia: marca,
      descripcion_carga: [`Correo de ${de || 'remitente desconocido'}`, `Asunto: ${asunto || '(sin asunto)'}`, adjuntos.length ? `Adjuntos: ${adjuntos.join(', ')}` : '', '', texto.slice(0, 4000)].filter((x, i) => i === 3 || x).join('\n'),
      canal: 'Correo',
      guia_normalizada: marca,
      estado_cruce: 'Sin vuelo',
    }),
  );
  ctx.log('Sin guías legibles: prealerta de revisión', fila.id);
  return { creadas: 1, duplicadas: 0, sinGuia: true, ids: [fila.id] };
}
