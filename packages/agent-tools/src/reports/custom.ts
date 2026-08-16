import { z } from 'zod';
import { registerTool } from '../index';
import type { ToolContext } from '../types';
import { BLOCK_IDS } from './blocks';
import { sourceById } from './document';
import { longDate, stamp } from './format';
import {
  MAX_BLOCKS,
  type RecipeRow,
  type RecipeSpec,
  blockCatalog,
  blockInputSchema,
  getRecipe,
  listRecipes,
  recipeIsRestricted,
  runRecipe,
  saveRecipe,
  touchRecipe,
} from './recipe';
import { type ReportRow, reportUrl, saveReport, shareIsLive, shareUrl } from './store';

/**
 * `reports.compose` y `reports.run`: pedir un informe de lo que sea.
 *
 * ===========================================================================
 * DOS HERRAMIENTAS Y NO UNA, PORQUE SON DOS ACTOS DISTINTOS
 * ===========================================================================
 * `reports.compose` FORMULA la pregunta: elige bloques, los parametriza, le
 * pone nombre y la corre por primera vez. Es lo que pasa cuando alguien dice
 * «hazme un informe de lo que se nos viene con Servientrega».
 *
 * `reports.run` REPITE una pregunta ya formulada. Es lo que pasa el mes
 * siguiente, y —esto es lo importante— es lo que hace una rutina: su entrada es
 * un solo id, así que `schedule.create` puede agendarla, validarla contra este
 * esquema y correrla desatendida sin que ningún modelo tenga que reconstruir la
 * receta de memoria y equivocarse en un parámetro.
 *
 * Si fueran una sola herramienta, programarla significaría guardar la receta
 * entera dentro de `scheduled_jobs.tool_input`, y entonces habría dos copias de
 * la misma pregunta que nada obliga a coincidir: corregir el informe dejaría la
 * rutina mandando el viejo, cada lunes, sin fallar.
 *
 * ===========================================================================
 * QUÉ PUEDE Y QUÉ NO PUEDE EL MODELO AQUÍ
 * ===========================================================================
 * Puede: escoger bloques de una unión cerrada, ponerles parámetros dentro del
 * rango que cada bloque declara, y escribir tres textos que son ETIQUETAS y no
 * afirmaciones — el nombre, el título y la etiqueta de periodo.
 *
 * No puede: escribir una cifra, una tabla, una serie, una sección ni una línea
 * de markup. No hay campo donde hacerlo. Es la misma frontera de
 * `reports.generate` («elige el kind y los parámetros»), sólo que ahora hay
 * muchas más combinaciones al otro lado.
 *
 * La diferencia con `reports.chart` conviene decirla en voz alta porque es la
 * que hace que esto no sea la trampa: en `reports.chart` las cifras LLEGAN en
 * la llamada, transcritas por el modelo desde lo que otra herramienta devolvió,
 * y su cabecera admite que la garantía es más débil. Aquí no llega ninguna
 * cifra. Los bloques consultan. Por eso esto se puede componer de seis piezas y
 * aquello, con razón, es de una sola.
 */

const nameField = z
  .string()
  .min(1)
  .max(120)
  .describe(
    'Cómo se va a llamar este informe en la lista, en minúscula de oración y corto: «cartera de Servientrega», «lo que se vence este trimestre». Es el nombre por el que alguien lo va a pedir otra vez.',
  );

const titleField = z
  .string()
  .min(1)
  .max(200)
  .describe(
    'El título que lleva el informe en su propio encabezado, en español y en minúscula de oración. Di de qué es, no «Informe».',
  );

const periodField = z
  .string()
  .min(1)
  .max(120)
  .describe(
    'Qué ventana cubre, tal como la diría una persona: «próximos 90 días», «agosto de 2026», «el trimestre». Es una etiqueta para el encabezado; las fechas de verdad las pone cada bloque en su fuente.',
  );

const blocksField = z
  .array(blockInputSchema())
  .min(1)
  .max(MAX_BLOCKS)
  .describe(
    `De qué se compone el informe, en el orden en que se va a leer. Entre uno y ${MAX_BLOCKS}. Los bloques disponibles: ${blockCatalog()}`,
  );

// ---------------------------------------------------------------------------
// Cómo se cuenta un informe recién hecho
// ---------------------------------------------------------------------------

interface Made {
  recipe: RecipeRow;
  row: ReportRow;
  figures: Array<{ label: string; value: string; method: string; source: string; readAt: string }>;
  notes: string[];
}

function figuresOfRow(row: ReportRow, document: Parameters<typeof sourceById>[0]) {
  return document.sections
    .filter((s): s is Extract<typeof s, { type: 'metrics' }> => s.type === 'metrics')
    .flatMap((s) =>
      s.items.map((m) => {
        const src = sourceById(document, m.figure.sourceId);
        return {
          label: m.label,
          value: m.figure.display,
          method: m.figure.method,
          source: src?.system ?? 'fuente no declarada',
          readAt: src?.readAt ?? row.generated_at,
        };
      }),
    );
}

function madeMarkdown(made: Made, opts: { reused: boolean }): string {
  const { recipe, row, figures, notes } = made;
  const lines: string[] = [];

  lines.push(`**${row.title}** — informe a la medida${opts.reused ? '' : ' creado'} y guardado.`);
  lines.push('');
  if (opts.reused) {
    lines.push(
      `Ya existía un informe guardado que calcula exactamente esto, «${recipe.name}», así que se corrió ése en vez de crear uno igual con otro nombre.`,
    );
    lines.push('');
  }
  lines.push(`Periodo: ${row.period_label}.`);
  lines.push(`Calculado: ${stamp(row.generated_at)} (America/Bogota).`);
  lines.push('');

  if (figures.length > 0) {
    lines.push('**Cifras, con su procedencia:**');
    for (const f of figures) {
      lines.push(
        `- **${f.label}: ${f.value}** — ${f.method} _(${f.source}, leído ${stamp(f.readAt)})_`,
      );
    }
    lines.push('');
  }

  if (notes.length > 0) {
    lines.push('**Qué no incluye:**');
    for (const n of notes) lines.push(`- ${n}`);
    lines.push('');
  }

  lines.push(`Se ve completo, con los gráficos y las tablas, en ${reportUrl(row.id)}`);
  lines.push('');
  lines.push(
    row.restricted
      ? '⚠️ Este informe nombra a personas del equipo, así que NO se puede compartir por enlace público. Adentro se ve entero.'
      : `Para volver a correrlo el mes que viene, o para que llegue solo cada lunes, usa \`reports.run\` con recipeId = \`${recipe.id}\`. Programarlo es una rutina de tipo herramienta sobre \`reports.run\`.`,
  );
  lines.push('');
  lines.push(
    '_Este informe es una fotografía: muestra los datos tal como estaban al momento de calcularlo y no cambia cuando cambian los datos. Volver a correr la receta hace una foto nueva, no reescribe ésta._',
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// El camino común
// ---------------------------------------------------------------------------

/**
 * Correr una receta y congelar el resultado.
 *
 * Un solo camino para las dos herramientas y para la pantalla, por la misma
 * razón que `apps/web/app/(app)/reports/actions.ts` pasa por `buildReport`:
 * armar un informe desde el chat y armarlo desde un botón tienen que producir
 * el mismo documento, o las dos superficies empiezan a discrepar sobre qué es
 * «el informe de cartera».
 *
 * `restricted` se deriva de la receta y no se pide: quien pulsa el botón no
 * sabe qué lee cada bloque, y quien escribió el bloque sí.
 */
export async function runRecipeAndSave(
  ctx: ToolContext,
  recipe: RecipeRow,
  opts: { now?: Date } = {},
): Promise<Made> {
  const spec = recipe.spec as RecipeSpec;
  const now = opts.now ?? new Date();

  const document = await runRecipe({
    db: ctx.db,
    title: recipe.title,
    subtitle: recipe.subtitle,
    periodLabel: recipe.period_label,
    spec,
    now,
  });

  const row = await saveReport(ctx, {
    kind: 'custom',
    document,
    params: { recipeId: recipe.id, blocks: spec.blocks },
    recipeId: recipe.id,
    restricted: recipeIsRestricted(spec),
  });

  await touchRecipe(ctx.db, recipe.id, row.generated_at);

  return {
    recipe,
    row,
    figures: figuresOfRow(row, document),
    notes: document.notes,
  };
}

// ---------------------------------------------------------------------------
// reports.compose
// ---------------------------------------------------------------------------

export const reportsCompose = registerTool({
  id: 'reports.compose',
  description: `Arma un informe A LA MEDIDA combinando los bloques que Cortex sabe calcular, lo guarda con nombre para poder repetirlo, y devuelve el enlace. Úsalo cuando pidan un informe que no es ninguno de los tres fijos de \`reports.generate\`: «un informe de lo que se nos viene con este cliente», «júntame los vencimientos y el estado de la flota en un solo papel», «un resumen mensual para la junta». De uno a ${MAX_BLOCKS} bloques, en el orden en que se leen. Los bloques: ${blockCatalog()} TÚ NO ESCRIBES NINGUNA CIFRA. Cada bloque consulta la base por su cuenta y trae sus números con la fuente y el método pegados. Tu trabajo es escoger qué bloques y con qué parámetros, y ponerle nombre, título y periodo. Si lo que piden no lo contesta ningún bloque, DILO y di qué falta — no armes el más parecido y lo presentes como si contestara la pregunta. Si ya existe una receta que calcula exactamente lo mismo, esta herramienta corre esa en vez de crear una copia con otro nombre, y te lo dice. El informe queda como fotografía: no se recalcula cuando cambian los datos. Para repetirlo, o para programarlo, está \`reports.run\` con el id de la receta.`,
  inputSchema: z.object({
    name: nameField,
    title: titleField,
    subtitle: z
      .string()
      .max(300)
      .nullable()
      .default(null)
      .describe('Una línea bajo el título. Normalmente null.'),
    periodLabel: periodField,
    blocks: blocksField,
  }),
  outputSchema: z.object({
    recipeId: z.string(),
    reportId: z.string(),
    url: z.string(),
    reusedExisting: z.boolean(),
    restricted: z.boolean(),
    figures: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        method: z.string(),
        source: z.string(),
        readAt: z.string(),
      }),
    ),
    notes: z.array(z.string()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const spec: RecipeSpec = {
      blocks: input.blocks.map((b) => ({
        block: b.block,
        params: b.params as Record<string, unknown>,
      })),
    };

    const saved = await saveRecipe(ctx, {
      name: input.name,
      title: input.title,
      subtitle: input.subtitle,
      periodLabel: input.periodLabel,
      spec,
    });

    const made = await runRecipeAndSave(ctx, saved.row);

    return {
      recipeId: saved.row.id,
      reportId: made.row.id,
      url: reportUrl(made.row.id),
      reusedExisting: saved.alreadyExisted,
      restricted: made.row.restricted,
      figures: made.figures,
      notes: made.notes,
      markdown: madeMarkdown(made, { reused: saved.alreadyExisted }),
    };
  },
});

// ---------------------------------------------------------------------------
// reports.run
// ---------------------------------------------------------------------------

export const reportsRun = registerTool({
  id: 'reports.run',
  description:
    'Vuelve a correr un informe a la medida que ya está guardado y produce una FOTOGRAFÍA NUEVA con los datos de hoy. La anterior no se toca: siguen existiendo las dos, cada una con su fecha. ' +
    'Úsalo cuando pidan «el mismo de cartera pero de este mes» o cuando una rutina tenga que producirlo sola. Para saber qué informes hay guardados, `reports.recipes`. ' +
    'Su entrada es un solo id a propósito: así una rutina programada puede correrlo cada lunes sin tener que volver a armar la receta de memoria, que es como se acaba mandando el informe equivocado durante seis semanas sin que nada falle.',
  inputSchema: z.object({
    recipeId: z.string().describe('El id que devolvió `reports.compose` o `reports.recipes`.'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    reportId: z.string().nullable(),
    url: z.string().nullable(),
    restricted: z.boolean(),
    figures: z.array(
      z.object({
        label: z.string(),
        value: z.string(),
        method: z.string(),
        source: z.string(),
        readAt: z.string(),
      }),
    ),
    notes: z.array(z.string()),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    const recipe = await getRecipe(ctx.db, input.recipeId);
    if (!recipe || recipe.archived_at) {
      return {
        found: false,
        reportId: null,
        url: null,
        restricted: false,
        figures: [],
        notes: [],
        markdown:
          'No hay ningún informe a la medida con ese id en este espacio de trabajo. Mira `reports.recipes` para ver cuáles hay.',
      };
    }

    const made = await runRecipeAndSave(ctx, recipe);
    return {
      found: true,
      reportId: made.row.id,
      url: reportUrl(made.row.id),
      restricted: made.row.restricted,
      figures: made.figures,
      notes: made.notes,
      markdown: madeMarkdown(made, { reused: false }),
    };
  },
});

// ---------------------------------------------------------------------------
// reports.recipes
// ---------------------------------------------------------------------------

export const reportsRecipes = registerTool({
  id: 'reports.recipes',
  description:
    'Lista los informes a la medida que ya están guardados y se pueden volver a correr, con los bloques de cada uno. Sólo lectura. ' +
    'Úsalo ANTES de `reports.compose`: si ya hay uno que contesta lo que piden, correrlo con `reports.run` es mejor que crear otro casi igual. ' +
    'Ojo con la diferencia: esto lista PREGUNTAS guardadas; `reports.list` lista las FOTOGRAFÍAS que esas preguntas y las demás produjeron.',
  inputSchema: z.object({
    limit: z.number().int().min(1).max(50).default(20),
  }),
  outputSchema: z.object({
    recipes: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        title: z.string(),
        periodLabel: z.string(),
        blocks: z.array(z.string()),
        restricted: z.boolean(),
        lastRunAt: z.string().nullable(),
      }),
    ),
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const rows = await listRecipes(ctx.db, { limit: input.limit });
    const recipes = rows.map((r) => ({
      id: r.id,
      name: r.name,
      title: r.title,
      periodLabel: r.period_label,
      blocks: (r.spec as RecipeSpec).blocks.map((b) => b.block),
      restricted: r.restricted,
      lastRunAt: r.last_run_at,
    }));

    const markdown =
      recipes.length === 0
        ? [
            'Todavía no hay ningún informe a la medida guardado.',
            '',
            `Puedes armar el primero con \`reports.compose\`, combinando los bloques que hay: ${BLOCK_IDS.join(', ')}.`,
          ].join('\n')
        : [
            `**${recipes.length} ${recipes.length === 1 ? 'informe a la medida guardado' : 'informes a la medida guardados'}.**`,
            '',
            ...recipes.map(
              (r) =>
                `- **${r.name}** (\`${r.id}\`) — ${r.blocks.join(' + ')}. ${r.lastRunAt ? `Última corrida: ${longDate(r.lastRunAt.slice(0, 10))}.` : 'Todavía sin correr.'}${r.restricted ? ' No se puede compartir por enlace público.' : ''}`,
            ),
            '',
            '_Correr uno con `reports.run` hace una fotografía nueva; las anteriores siguen donde estaban._',
          ].join('\n');

    return { recipes, markdown };
  },
});

/** Para la pantalla, que muestra el enlace público cuando lo hay. */
export function recipeShareHint(row: ReportRow): string | null {
  if (!shareIsLive(row) || !row.share_token) return null;
  return shareUrl(row.share_token);
}
