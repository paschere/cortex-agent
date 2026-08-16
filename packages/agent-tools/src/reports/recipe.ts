import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
// Del módulo hoja, no del barril: ver la nota en `blocks.ts`.
import { bogotaToday } from '../commitments/shape';
import type { ToolContext } from '../types';
import { BLOCKS, BLOCK_IDS, type BlockId, getBlock, isBlockId, runBlock } from './blocks';
import {
  REPORT_DOCUMENT_VERSION,
  type ReportDocument,
  type ReportSection,
  type ReportSource,
  validateDocument,
} from './document';
import { canonicalize } from './store';

/**
 * LA RECETA: qué es «un informe» cuando el informe puede ser de lo que sea.
 *
 * ===========================================================================
 * DOS COSAS QUE SE LLAMABAN IGUAL Y AHORA NO
 * ===========================================================================
 * Hasta hoy `reports.kind` hacía dos trabajos a la vez: decía DE QUÉ TRATA el
 * informe ('expiries', 'fleet') y DE DÓNDE VINO la fila ('chart' y 'answer' son
 * procedencias, no asuntos — la propia pantalla de /reports lo dice en un
 * comentario: «las dos son procedencias, no asuntos»).
 *
 * Ése es el motivo de que el CHECK haya crecido tres veces. Mientras el asunto
 * viva en una lista cerrada de la base, cada asunto nuevo es una migración, y
 * «de lo que sea» no cabe en una lista que crece a mano.
 *
 * Así que el asunto se muda. Vive en una RECETA: una fila de
 * `report_recipes` con un nombre y una lista de bloques con sus parámetros. Y
 * `kind` se queda con el trabajo que sí es una lista cerrada de verdad — de
 * dónde vino la fila — y recibe su último valor, 'custom', que es precisamente
 * el que hace que deje de crecer: a partir de aquí un informe nuevo es una fila,
 * no un valor en un CHECK.
 *
 * ===========================================================================
 * QUÉ SUSTITUYE A LA GARANTÍA QUE DABA EL CHECK
 * ===========================================================================
 * El CHECK impedía «que mañana haya cuatro informes que son el mismo con
 * nombres distintos». Conviene ser exacto sobre cuánto impedía: lo impedía
 * entre DESARROLLADORES, obligando a una migración y por tanto a una revisión.
 * No impedía nada entre USUARIOS, porque un usuario nunca pudo crear un tipo.
 *
 * Lo que se pone en su lugar es más fuerte en el segundo caso y suficiente en
 * el primero:
 *
 *  1. LA HUELLA. `fingerprint` es el sha256 de la lista canónica de bloques y
 *     parámetros — sin el nombre, a propósito. Dos recetas que CALCULAN LO
 *     MISMO chocan contra un índice único aunque se llamen distinto, que es
 *     exactamente el caso que preocupaba. `saveRecipe` devuelve la que ya
 *     existe en vez de crear la cuarta copia.
 *  2. EL REGISTRO. Los bloques son una unión cerrada en código. No hay texto
 *     libre en una receta salvo su nombre y su etiqueta de periodo: nadie puede
 *     inventar un cálculo, sólo combinar los que hay.
 *  3. EL NOMBRE. Único por espacio de trabajo, insensible a mayúsculas, para
 *     que la lista se pueda leer.
 *
 * El orden de los bloques SÍ entra en la huella. Dos informes con los mismos
 * bloques en otro orden son dos informes distintos, porque el orden de lectura
 * es parte de lo que un informe dice — el que abre con la plata en riesgo y el
 * que abre con la lista de placas no se leen igual.
 *
 * ===========================================================================
 * LA RECETA SE VUELVE A CORRER; EL INFORME NO
 * ===========================================================================
 * Ésta es la distinción que hace que todo lo demás siga en pie. Una receta es
 * una PREGUNTA GUARDADA y se puede repetir cuantas veces se quiera. Cada
 * repetición produce un INFORME, que es una FOTOGRAFÍA y no se repite jamás:
 * `runRecipe` resuelve el documento entero y `saveReport` lo congela con su
 * huella, igual que los tres de siempre. Abrir el informe de julio en noviembre
 * no corre ni una consulta.
 *
 * Y por eso se puede PROGRAMAR sin superficie nueva: `schedule.create` ya sabe
 * agendar una herramienta con su entrada y validarla contra su esquema, así que
 * «mándame este informe cada lunes» es una rutina `kind: 'tool'` sobre
 * `reports.run` con el id de la receta. No hacía falta un programador de
 * informes; hacía falta algo que un programador pudiera correr.
 */

export const REPORT_RECIPES_TABLE = 'report_recipes';

export const RECIPE_COLUMNS =
  'id, name, title, subtitle, period_label, spec, fingerprint, restricted, created_by, created_at, updated_at, last_run_at, archived_at';

/** Un bloque dentro de una receta: cuál, y con qué parámetros. */
export const recipeBlockSchema = z.object({
  block: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});
export type RecipeBlock = z.infer<typeof recipeBlockSchema>;

/**
 * Máximo de bloques por informe.
 *
 * No es un límite de recursos: seis bloques ya son seis consultas y unas dos
 * pantallas de papel. Un informe de quince secciones no se lee, se hojea, y un
 * informe que se hojea no se cita — que es para lo único que existe éste.
 */
export const MAX_BLOCKS = 6;

export const recipeSpecSchema = z.object({
  blocks: z.array(recipeBlockSchema).min(1).max(MAX_BLOCKS),
});
export type RecipeSpec = z.infer<typeof recipeSpecSchema>;

export interface RecipeRow {
  id: string;
  name: string;
  title: string;
  subtitle: string | null;
  period_label: string;
  spec: RecipeSpec;
  fingerprint: string;
  restricted: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  archived_at: string | null;
}

export class UnknownBlockError extends Error {
  constructor(id: string) {
    super(
      `No existe ningún bloque llamado "${id}". Los que hay son: ${BLOCK_IDS.join(', ')}. Un informe se arma sólo con bloques que este código sabe calcular — si lo que hace falta no está, dilo en vez de armar el más parecido.`,
    );
    this.name = 'UnknownBlockError';
  }
}

// ---------------------------------------------------------------------------
// La huella
// ---------------------------------------------------------------------------

/**
 * Qué calcula esta receta, reducido a 64 caracteres.
 *
 * Los parámetros se normalizan por el esquema del bloque ANTES de entrar, para
 * que `{}` y `{horizonDays: 60}` sean la misma huella cuando 60 es el valor por
 * defecto. Sin ese paso la huella distinguiría dos peticiones idénticas por lo
 * que el modelo se molestó en escribir, que es justo lo que no debe importar.
 */
export function recipeFingerprint(spec: RecipeSpec): string {
  const normalized = spec.blocks.map((b) => {
    if (!isBlockId(b.block)) throw new UnknownBlockError(b.block);
    return { block: b.block, params: getBlock(b.block).params.parse(b.params ?? {}) };
  });
  return createHash('sha256')
    .update(canonicalize({ blocks: normalized }), 'utf8')
    .digest('hex');
}

/** True cuando algún bloque de la receta nombra a alguien de la empresa. */
export function recipeIsRestricted(spec: RecipeSpec): boolean {
  return spec.blocks.some((b) => isBlockId(b.block) && getBlock(b.block).restricted);
}

// ---------------------------------------------------------------------------
// Correr una receta
// ---------------------------------------------------------------------------

export interface RunRecipeInput {
  db: SupabaseClient;
  title: string;
  subtitle?: string | null;
  periodLabel: string;
  spec: RecipeSpec;
  /** Hoy en Bogotá. Inyectado para que la construcción sea probable. */
  today?: string;
  now?: Date;
  notes?: string[];
}

/**
 * Correr los bloques y armar el documento.
 *
 * Cada bloque recibe un `slot` distinto (`b1`, `b2`, …) porque el mismo bloque
 * puede aparecer dos veces con parámetros distintos, y dos fuentes con el mismo
 * id serían dos notas al pie que se pisan: la cifra del segundo bloque citaría
 * el corte del primero, y una cita que apunta al sitio equivocado es peor que
 * ninguna, porque parece una.
 *
 * Los bloques corren EN SERIE, no con `Promise.all`. Un informe con seis
 * bloques son seis consultas contra la misma base y la misma conexión, y ganar
 * doscientos milisegundos no vale el riesgo de que una tanda de lecturas
 * paralelas se pise dentro del cliente compartido. El instante que se estampa
 * es el mismo para todos: es el instante del INFORME, y dos cifras que un
 * lector va a comparar entre sí no pueden llevar dos relojes.
 */
export async function runRecipe(input: RunRecipeInput): Promise<ReportDocument> {
  const spec = recipeSpecSchema.parse(input.spec);
  const today = input.today ?? bogotaToday();
  const now = input.now ?? new Date();

  const sources: ReportSource[] = [];
  const sections: ReportSection[] = [];
  const notes: string[] = [...(input.notes ?? [])];

  let slot = 0;
  for (const entry of spec.blocks) {
    if (!isBlockId(entry.block)) throw new UnknownBlockError(entry.block);
    slot += 1;
    const out = await runBlock(entry.block, {
      db: input.db,
      params: entry.params,
      today,
      now,
      slot: `b${slot}`,
    });
    sources.push(...out.sources);
    sections.push(...out.sections);
    for (const n of out.notes) if (!notes.includes(n)) notes.push(n);
  }

  return validateDocument({
    version: REPORT_DOCUMENT_VERSION,
    kind: 'custom',
    title: input.title,
    subtitle: input.subtitle ?? null,
    periodLabel: input.periodLabel,
    generatedAt: now.toISOString(),
    timezone: 'America/Bogota',
    sources,
    sections,
    notes,
  });
}

// ---------------------------------------------------------------------------
// Guardar y leer recetas
// ---------------------------------------------------------------------------

export interface SaveRecipeInput {
  name: string;
  title: string;
  subtitle?: string | null;
  periodLabel: string;
  spec: RecipeSpec;
}

export interface SaveRecipeResult {
  row: RecipeRow;
  /** True cuando ya existía una receta que calcula exactamente lo mismo. */
  alreadyExisted: boolean;
}

/**
 * Guardar la pregunta, o devolver la que ya estaba.
 *
 * La huella decide, y decide ANTES de insertar y también DESPUÉS: se busca
 * primero porque es la respuesta amable, y se atrapa el 23505 porque dos
 * peticiones a la vez pasan las dos por la búsqueda. Es el mismo trato que
 * `claimWeeklyReport` le da al índice único de la 0100 — la base contesta la
 * pregunta «¿ya estaba?», no la memoria del proceso.
 */
export async function saveRecipe(
  ctx: ToolContext,
  input: SaveRecipeInput,
): Promise<SaveRecipeResult> {
  const spec = recipeSpecSchema.parse(input.spec);
  const fingerprint = recipeFingerprint(spec);
  const restricted = recipeIsRestricted(spec);

  const existing = await findRecipeByFingerprint(ctx.db, fingerprint);
  if (existing) return { row: existing, alreadyExisted: true };

  const { data, error } = await ctx.db
    .from(REPORT_RECIPES_TABLE)
    .insert({
      id: randomUUID(),
      name: input.name.trim(),
      title: input.title.trim(),
      subtitle: input.subtitle?.trim() || null,
      period_label: input.periodLabel.trim(),
      spec,
      fingerprint,
      restricted,
      created_by: ctx.userId,
    })
    .select(RECIPE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      const raced = await findRecipeByFingerprint(ctx.db, fingerprint);
      if (raced) return { row: raced, alreadyExisted: true };
      throw new Error(
        `Ya hay un informe guardado con el nombre «${input.name.trim()}». Ponle otro o corre el que existe.`,
      );
    }
    throw new Error(`No se pudo guardar el informe a la medida: ${error.message}`);
  }
  if (!data) throw new Error('No se pudo guardar el informe a la medida.');
  return { row: data as unknown as RecipeRow, alreadyExisted: false };
}

export async function findRecipeByFingerprint(
  db: SupabaseClient,
  fingerprint: string,
): Promise<RecipeRow | null> {
  const { data, error } = await db
    .from(REPORT_RECIPES_TABLE)
    .select(RECIPE_COLUMNS)
    .eq('fingerprint', fingerprint)
    .is('archived_at', null)
    .maybeSingle();
  if (error) throw new Error(`No se pudieron leer los informes a la medida: ${error.message}`);
  return (data as unknown as RecipeRow) ?? null;
}

export async function getRecipe(db: SupabaseClient, id: string): Promise<RecipeRow | null> {
  const { data, error } = await db
    .from(REPORT_RECIPES_TABLE)
    .select(RECIPE_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`No se pudo abrir el informe a la medida: ${error.message}`);
  return (data as unknown as RecipeRow) ?? null;
}

export async function listRecipes(
  db: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<RecipeRow[]> {
  const { data, error } = await db
    .from(REPORT_RECIPES_TABLE)
    .select(RECIPE_COLUMNS)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(Math.min(opts.limit ?? 30, 100));
  if (error) throw new Error(`No se pudieron leer los informes a la medida: ${error.message}`);
  return (data ?? []) as unknown as RecipeRow[];
}

/** Sellar la última corrida. Falla en silencio: no vale perder un informe por esto. */
export async function touchRecipe(db: SupabaseClient, id: string, at: string): Promise<void> {
  const { error } = await db
    .from(REPORT_RECIPES_TABLE)
    .update({ last_run_at: at, updated_at: at })
    .eq('id', id);
  if (error) return;
}

// ---------------------------------------------------------------------------
// Lo que el modelo lee
// ---------------------------------------------------------------------------

/** El catálogo de bloques, en una línea cada uno, para la descripción del tool. */
export function blockCatalog(): string {
  return BLOCK_IDS.map((id) => {
    const b = BLOCKS[id];
    return `"${id}" (${b.label}): ${b.question}${b.restricted ? ' [RESTRINGIDO: no se puede compartir por enlace público]' : ''}`;
  }).join(' ');
}

/**
 * El esquema que ve el modelo: una unión discriminada por `block`.
 *
 * Es la pieza que hace de la generalización algo seguro. El modelo no escribe
 * un nombre de bloque en un campo de texto — escoge una rama, y la rama trae
 * los parámetros que ese bloque admite y ningún otro. Un bloque inventado no
 * pasa la validación de la herramienta, así que nunca llega a `runRecipe`.
 */
export function blockInputSchema() {
  const branches = BLOCK_IDS.map((id) =>
    z.object({
      block: z.literal(id).describe(BLOCKS[id].question),
      params: BLOCKS[id].params,
    }),
  );
  return z.discriminatedUnion(
    'block',
    branches as unknown as [(typeof branches)[number], ...(typeof branches)[number][]],
  );
}

export type { BlockId };
