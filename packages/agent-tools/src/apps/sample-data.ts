import { flowOf } from '../trackers/flow';
import type { TrackerField } from '../trackers/schema';

/**
 * FILAS DE EJEMPLO PARA LA VISTA PREVIA DE UNA APP.
 *
 * Salen SOLO de los campos de la tabla (tipo, opciones, mín/máx, formato,
 * flujo): ningún dato real ni de una industria. Son deterministas (la misma
 * tabla da las mismas filas) para que la vista previa no parpadee entre
 * recargas, y nunca se guardan: viven en la memoria del cálculo.
 */

export interface SampleRow {
  id: string;
  label: string;
  values: Record<string, string | number>;
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

/** El «viewer» de la vista previa: lo que un rol «own» ve como suyo. */
export const PREVIEW_USER_ID = '00000000-0000-4000-8000-00000000beef';

/** Generador pseudoaleatorio pequeño y repetible (mulberry32) sembrado con un texto. */
export function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE = [
  'Ana Gómez',
  'Luis Pérez',
  'Marta Ríos',
  'Carlos Ruiz',
  'Sofía Mora',
  'Julián Vega',
];
const PLACES = ['Bogotá', 'Medellín', 'Cali', 'Barranquilla', 'Bucaramanga', 'Cartagena'];
const SENTENCES = [
  'Todo en orden, sin novedades.',
  'Se revisó y quedó listo para el siguiente paso.',
  'Pendiente de confirmar con el cliente.',
  'Se dejó una nota para el equipo.',
];

const pad = (n: number) => String(n).padStart(2, '0');

function addDays(today: string, delta: number): string {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function boundDate(b: unknown, today: string): string | null {
  if (typeof b !== 'string') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(b)) return b;
  const m = /^today(?:([+-])(\d{1,4}))?$/.exec(b);
  if (!m) return null;
  return m[1] ? addDays(today, (m[1] === '-' ? -1 : 1) * Number(m[2])) : today;
}

function sampleValue(
  f: TrackerField,
  i: number,
  rand: () => number,
  ctx: { today: string; total: number; relations?: ReadonlyMap<string, SampleRow[]> },
): string | number | undefined {
  const pick = <T>(list: readonly T[]) => list[Math.floor(rand() * list.length)] as T;
  const text = `${f.key} ${f.label}`.toLowerCase();
  switch (f.type) {
    case 'select': {
      const options = f.flow?.states ?? f.options ?? [];
      if (!options.length) return undefined;
      // Repartido por las opciones (con un poco de azar) para que tableros y gráficos muestren algo.
      return options[(i + (rand() < 0.35 ? 1 : 0)) % options.length];
    }
    case 'number': {
      const min = typeof f.min === 'number' ? f.min : 1;
      const max = typeof f.max === 'number' ? f.max : Math.max(min + 20, 60);
      return Math.round(min + rand() * (max - min));
    }
    case 'money': {
      const min = typeof f.min === 'number' ? f.min : 50_000;
      const max = typeof f.max === 'number' ? f.max : 4_000_000;
      return Math.max(min, Math.round((min + rand() * (max - min)) / 10_000) * 10_000);
    }
    case 'date': {
      const lo = boundDate(f.min, ctx.today) ?? addDays(ctx.today, -21);
      const hi =
        boundDate(f.max, ctx.today) ??
        addDays(ctx.today, /entrega|venc|limite|plazo|cita|agenda|programad/.test(text) ? 14 : 0);
      const span = Math.max(
        0,
        Math.round((Date.parse(`${hi}T12:00:00Z`) - Date.parse(`${lo}T12:00:00Z`)) / 86_400_000),
      );
      return addDays(lo, Math.floor(rand() * (span + 1)));
    }
    case 'time':
      return `${pad(6 + Math.floor(rand() * 12))}:${pick(['00', '15', '30', '45'])}`;
    case 'checkbox':
      return rand() < 0.5 ? 1 : 0;
    case 'location':
      return `${(4.6 + rand() * 0.2).toFixed(6)},${(-74.1 + rand() * 0.1).toFixed(6)}`;
    case 'file':
      return undefined;
    case 'relation': {
      const target = f.tracker ? ctx.relations?.get(f.tracker) : undefined;
      if (!target?.length) return undefined;
      const row = target[i % target.length] as SampleRow;
      return JSON.stringify({ id: row.id, label: row.label });
    }
    case 'longtext':
      return pick(SENTENCES);
    default: {
      if (f.format === 'email') return `${pick(PEOPLE).split(' ')[0]?.toLowerCase()}@ejemplo.co`;
      if (f.format === 'phone') return `3${Math.floor(100000000 + rand() * 899999999)}`;
      if (f.format === 'nit') return `9${Math.floor(10000000 + rand() * 89999999)}`;
      if (f.format === 'plate')
        return `${pick(['ABC', 'XYZ', 'KLM'])}${Math.floor(100 + rand() * 899)}`;
      if (f.format === 'awb') return String(Math.floor(10000000 + rand() * 89999999));
      if (f.format === 'digits') return String(Math.floor(1000 + rand() * 8999));
      if (/nombre|cliente|persona|responsable|contacto|operario|conductor|asignad|recib/.test(text))
        return PEOPLE[i % PEOPLE.length];
      if (/ciudad|destino|origen|lugar|sede|ubicaci|direcci/.test(text)) return pick(PLACES);
      if (/numero|número|codigo|código|guia|guía|referencia|folio|orden|factura/.test(text))
        return `${f.key.slice(0, 2).toUpperCase()}-${1000 + i * 7 + Math.floor(rand() * 6)}`;
      return `${f.label} ${i + 1}`;
    }
  }
}

/**
 * `count` filas de ejemplo de una tabla. Los campos obligatorios siempre llevan
 * valor; los opcionales a veces quedan vacíos para que se vea cómo se ven.
 * Una de cada tres filas es «de quien mira» (`created_by` = PREVIEW_USER_ID).
 */
export function sampleRows(
  table: { slug: string; name: string; fields: readonly TrackerField[] },
  options: {
    count?: number;
    today: string;
    relations?: ReadonlyMap<string, SampleRow[]>;
  },
): SampleRow[] {
  const count = Math.max(1, Math.min(options.count ?? 8, 25));
  const rand = seeded(table.slug);
  const flow = flowOf(table.fields);
  const rows: SampleRow[] = [];
  const tag = Math.floor(seeded(`id:${table.slug}`)() * 0xffffffff)
    .toString(16)
    .padStart(8, '0');
  for (let i = 0; i < count; i++) {
    const values: Record<string, string | number> = {};
    for (const f of table.fields) {
      if (
        f.default !== undefined &&
        f.default !== '' &&
        !['today', 'now', 'viewer'].includes(String(f.default))
      )
        values[f.key] = f.default;
      const skip = !f.required && f.type !== 'select' && rand() < 0.15;
      if (skip) continue;
      const v = sampleValue(f, i, rand, {
        today: options.today,
        total: count,
        relations: options.relations,
      });
      if (v !== undefined && v !== '') values[f.key] = v;
    }
    // El flujo manda sobre el estado: nunca un valor fuera de sus estados.
    if (flow) values[flow.field.key] = flow.flow.states[i % flow.flow.states.length] as string;
    const first = table.fields.find((f) => f.type === 'text' && values[f.key] !== undefined);
    const label = first ? String(values[first.key]) : `${table.name} ${i + 1}`;
    const when = `${addDays(options.today, -(count - i))}T15:00:00.000Z`;
    rows.push({
      id: `${tag}-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      label,
      values,
      created_at: when,
      updated_at: when,
      created_by: i % 3 === 0 ? PREVIEW_USER_ID : null,
    });
  }
  return rows;
}
