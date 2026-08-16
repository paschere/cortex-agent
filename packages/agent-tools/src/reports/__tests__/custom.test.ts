import { describe, expect, it } from 'vitest';
import { BLOCKS, BLOCK_IDS, type BlockId } from '../blocks';
import { runRecipeAndSave } from '../custom';
import { figuresOf, sourceById, validateDocument } from '../document';
import {
  MAX_BLOCKS,
  type RecipeSpec,
  UnknownBlockError,
  recipeFingerprint,
  recipeIsRestricted,
  recipeSpecSchema,
  runRecipe,
  saveRecipe,
} from '../recipe';
import { renderReportHtml } from '../render';
import { RestrictedReportError, getReport, shareReport } from '../store';
import { ACME, ANA, CARLA, GLOBEX, NOW, TODAY, world } from './fixture';

/**
 * INFORMES DE LO QUE SEA, SIN PERDER LAS TRES COSAS QUE UN INFORME PROMETE.
 *
 * Este archivo prueba la generalización por el lado por el que se rompe, que no
 * es «¿sale algo?» sino «¿lo que sale sigue siendo citable?». Tres propiedades,
 * y cada una tiene su forma de fallar en silencio:
 *
 *   LA FOTOGRAFÍA se rompe recalculando al abrir. No falla nada: el informe de
 *   julio simplemente empieza a hablar de noviembre, con el título de julio.
 *
 *   LA PROCEDENCIA se rompe cuando una cifra llega sin fuente o con una que no
 *   resuelve. Tampoco falla nada: la nota al pie sigue ahí, apuntando a otro
 *   sitio, y se lee igual que una buena.
 *
 *   EL LÍMITE se rompe cuando lo que nombra a personas del equipo sale por un
 *   enlace sin contraseña. No falla nada tampoco — funciona perfectamente, que
 *   es el problema.
 *
 * Y una cuarta, la que hace que todo esto sea seguro de generalizar: EL MODELO
 * NO TIENE DÓNDE ESCRIBIR UNA CIFRA. Se prueba intentándolo.
 */

/** Los parámetros por defecto de cada bloque, tal como zod los rellena. */
function defaults(id: BlockId): Record<string, unknown> {
  return BLOCKS[id].params.parse({}) as Record<string, unknown>;
}

function specOf(...ids: BlockId[]): RecipeSpec {
  return { blocks: ids.map((id) => ({ block: id, params: defaults(id) })) };
}

/**
 * Una promesa interna, que es lo único de la empresa que nombra a un empleado.
 * Se añade aquí y no en `fixture()` a propósito: el resto de las pruebas de
 * informes cuentan filas de ese mundo, y meterles una más las movería a todas.
 */
function withInternalPromise(w: ReturnType<typeof world>) {
  (w.tables.commitments as Array<Record<string, unknown>>).push({
    ...(w.tables.commitments as Array<Record<string, unknown>>)[0],
    id: 'c-acme-internal',
    organization_id: ACME,
    title: 'Ana quedó de mandar el informe de aduana',
    kind: 'internal',
    counterparty: null,
    amount_cop: null,
    due_on: '2026-08-12',
    owner_user_id: ANA,
    vehicle_id: null,
    series_id: 's-acme-internal',
  });
  return w;
}

// ---------------------------------------------------------------------------
// 1. La procedencia, bloque por bloque
// ---------------------------------------------------------------------------

/**
 * Se recorre EL REGISTRO ENTERO y no una lista escrita a mano.
 *
 * Es la diferencia entre una prueba y un trinquete: un bloque nuevo entra en
 * este bucle el día que alguien lo añade, sin que nadie se acuerde de venir a
 * escribirlo aquí. Un bloque que se cuela sin citar sus cifras no llega a
 * `main`.
 */
describe('todo bloque cita todas sus cifras', () => {
  for (const id of BLOCK_IDS) {
    it(`${id}: cada cifra resuelve a una fuente declarada con su método`, async () => {
      const w = withInternalPromise(world());
      const doc = await runRecipe({
        db: w.db(ACME),
        title: 'prueba',
        periodLabel: 'la ventana de prueba',
        spec: specOf(id),
        today: TODAY,
        now: NOW,
      });

      expect(doc.sources.length).toBeGreaterThan(0);

      for (const { label, figure } of figuresOf(doc)) {
        const src = sourceById(doc, figure.sourceId);
        expect(src, `${label} cita una fuente que el documento no declara`).toBeDefined();
        // El método tiene que ser una frase que alguien pueda rehacer con la
        // base delante, no el nombre de una tabla.
        expect(figure.method.length, `${label} no dice cómo se sacó`).toBeGreaterThan(20);
        expect(src?.system.length ?? 0).toBeGreaterThan(0);
        expect(src?.detail.length ?? 0).toBeGreaterThan(0);
        expect(Number.isNaN(Date.parse(src?.readAt ?? ''))).toBe(false);
      }

      for (const section of doc.sections) {
        if (section.type === 'chart') {
          expect(sourceById(doc, section.sourceId)).toBeDefined();
          expect(sourceById(doc, section.table.sourceId)).toBeDefined();
          expect(section.method.length).toBeGreaterThan(20);
          // La tabla gemela no es opcional y no es un resumen.
          expect(section.table.columns.length).toBeGreaterThan(0);
          expect(section.altText.length).toBeGreaterThan(0);
        }
        if (section.type === 'table') {
          expect(sourceById(doc, section.table.sourceId)).toBeDefined();
          expect(section.table.method.length).toBeGreaterThan(20);
        }
      }
    });
  }

  it('el instante lo pone el armazón, no el bloque', async () => {
    // Un bloque no puede declarar sus datos más frescos de lo que son. Es la
    // misma regla que `chat-chart.ts` aplica al gráfico del chat, y la razón es
    // la misma: un dato que describe la lectura no se le pide a quien la hizo.
    const w = withInternalPromise(world());
    const doc = await runRecipe({
      db: w.db(ACME),
      title: 'prueba',
      periodLabel: 'x',
      spec: specOf(...BLOCK_IDS),
      today: TODAY,
      now: NOW,
    });
    for (const src of doc.sources) {
      expect(src.readAt).toBe(NOW.toISOString());
    }
    // Y el instante del documento es el mismo: dos cifras que alguien va a
    // comparar entre sí no pueden llevar dos relojes.
    expect(doc.generatedAt).toBe(NOW.toISOString());
  });

  it('dos bloques no se pisan la nota al pie', async () => {
    // El mismo bloque dos veces con ventanas distintas. Si compartieran id de
    // fuente, la cifra de los 90 días citaría el corte de los 30 — una cita que
    // apunta al sitio equivocado, que es peor que ninguna porque parece una.
    const w = world();
    const doc = await runRecipe({
      db: w.db(ACME),
      title: 'prueba',
      periodLabel: 'x',
      spec: {
        blocks: [
          { block: 'commitments_by_state', params: { horizonDays: 30 } },
          { block: 'commitments_by_state', params: { horizonDays: 90 } },
        ],
      },
      today: TODAY,
      now: NOW,
    });

    const ids = doc.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(doc.sources[0]?.detail).not.toBe(doc.sources[1]?.detail);
  });

  it('el libro de fuentes se imprime en la página', async () => {
    const w = withInternalPromise(world());
    const doc = await runRecipe({
      db: w.db(ACME),
      title: 'prueba',
      periodLabel: 'x',
      spec: specOf('commitments_by_state', 'commitments_by_counterparty'),
      today: TODAY,
      now: NOW,
    });
    const html = renderReportHtml(doc);
    expect(html).toContain('De dónde salió cada cifra');
    const markers = html.match(/class="rp-cite"/g)?.length ?? 0;
    expect(markers).toBeGreaterThanOrEqual(figuresOf(doc).length);
  });
});

// ---------------------------------------------------------------------------
// 2. El modelo no tiene dónde escribir una cifra
// ---------------------------------------------------------------------------

describe('el modelo elige bloques, no escribe números', () => {
  it('una cifra metida en los parámetros no llega al informe', async () => {
    // El intento que hay que impedir: colar un valor por el hueco de los
    // parámetros para que aparezca impreso como si lo hubiera calculado alguien.
    const w = world();
    const doc = await runRecipe({
      db: w.db(ACME),
      title: 'prueba',
      periodLabel: 'x',
      spec: {
        blocks: [
          {
            block: 'commitments_by_state',
            params: {
              horizonDays: 30,
              display: '$999.999.999',
              method: 'porque lo digo yo',
              sections: [{ type: 'prose', paragraphs: ['La cartera está sana.'] }],
            },
          },
        ],
      },
      today: TODAY,
      now: NOW,
    });

    const html = renderReportHtml(doc);
    expect(html).not.toContain('999.999.999');
    expect(html).not.toContain('porque lo digo yo');
    expect(html).not.toContain('La cartera está sana');
    // Y lo que sí llegó son las cifras del bloque, con su método de verdad.
    for (const { figure } of figuresOf(doc)) {
      expect(figure.method).not.toContain('porque lo digo yo');
    }
  });

  it('un bloque inventado no llega a correr', async () => {
    const w = world();
    await expect(
      runRecipe({
        db: w.db(ACME),
        title: 'prueba',
        periodLabel: 'x',
        spec: { blocks: [{ block: 'lo_que_sea', params: {} }] },
        today: TODAY,
        now: NOW,
      }),
    ).rejects.toBeInstanceOf(UnknownBlockError);
  });

  it('una receta sin bloques no es una receta', () => {
    // El espejo en TypeScript del CHECK de la 0107. Se prueba contra el caso
    // vacío a propósito: `jsonb_array_length` de una clave ausente da NULL, y
    // un CHECK que da NULL PASA — así que la restricción hay que escribirla
    // entera y probarla justamente aquí.
    expect(() => recipeSpecSchema.parse({ blocks: [] })).toThrow();
    expect(() => recipeSpecSchema.parse({})).toThrow();
    expect(() =>
      recipeSpecSchema.parse({
        blocks: Array.from({ length: MAX_BLOCKS + 1 }, () => ({
          block: 'commitments_by_state',
          params: {},
        })),
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. La fotografía
// ---------------------------------------------------------------------------

describe('un informe a la medida es una fotografía', () => {
  it('sigue diciendo lo mismo después de que los datos cambian debajo', async () => {
    const w = world();
    const db = w.db(ACME);
    const ctx = w.ctx(ACME, ANA);

    const saved = await saveRecipe(ctx, {
      name: 'lo que se viene',
      title: 'lo que se viene este trimestre',
      periodLabel: 'próximos 90 días',
      spec: specOf('commitments_by_state', 'commitments_upcoming'),
    });
    const made = await runRecipeAndSave(ctx, saved.row, { now: NOW });

    const before = made.figures.map((f) => `${f.label}=${f.value}`);
    expect(before.length).toBeGreaterThan(0);

    // Pasa una semana cualquiera: se cumple uno, se corrige un monto, entra otro.
    const commitments = w.tables.commitments as Array<Record<string, unknown>>;
    const met = commitments.find((c) => c.id === 'c-acme-2');
    if (met) met.state = 'met';
    const soat = commitments.find((c) => c.id === 'c-acme-1');
    if (soat) soat.amount_cop = 99_000_000;
    commitments.push({
      ...(commitments[0] as Record<string, unknown>),
      id: 'c-acme-9',
      title: 'Plazo DIAN',
      kind: 'customs',
      due_on: '2026-08-09',
      amount_cop: 5_000_000,
      series_id: 's-acme-9',
    });

    const reopened = await getReport(db, made.row.id);
    expect(reopened).not.toBeNull();
    if (!reopened) return;

    const after = figuresOf(reopened.document).map((f) => `${f.label}=${f.figure.display}`);
    expect(after).toEqual(before);
    expect(reopened.intact).toBe(true);

    // El control: volver a correr la MISMA receta sí tiene que moverse, o lo de
    // arriba estaría midiendo un mundo que nunca cambió.
    const again = await runRecipeAndSave(ctx, saved.row, { now: NOW });
    expect(again.figures.map((f) => `${f.label}=${f.value}`)).not.toEqual(before);

    // Y las dos fotos coexisten. Volver a correr no reescribe la anterior.
    expect(again.row.id).not.toBe(made.row.id);
    const first = await getReport(db, made.row.id);
    expect(figuresOf(first?.document ?? reopened.document).map((f) => f.figure.display)).toEqual(
      figuresOf(reopened.document).map((f) => f.figure.display),
    );
  });

  it('la fila guardada apunta a la receta de la que salió', async () => {
    const w = world();
    const ctx = w.ctx(ACME, ANA);
    const saved = await saveRecipe(ctx, {
      name: 'flota',
      title: 'papeles de la flota',
      periodLabel: 'hoy',
      spec: specOf('fleet_papers'),
    });
    const made = await runRecipeAndSave(ctx, saved.row, { now: NOW });
    expect(made.row.kind).toBe('custom');
    expect(made.row.recipe_id).toBe(saved.row.id);
  });
});

// ---------------------------------------------------------------------------
// 4. La huella: qué impide cuatro informes que son el mismo
// ---------------------------------------------------------------------------

describe('dos recetas que calculan lo mismo son la misma receta', () => {
  it('los parámetros por defecto y los escritos a mano dan la misma huella', () => {
    // Si no se normalizaran, la huella distinguiría dos peticiones idénticas por
    // lo que el modelo se molestó en escribir — que es justo lo que no importa.
    const a: RecipeSpec = { blocks: [{ block: 'commitments_by_state', params: {} }] };
    const b: RecipeSpec = {
      blocks: [{ block: 'commitments_by_state', params: { horizonDays: 60 } }],
    };
    expect(recipeFingerprint(a)).toBe(recipeFingerprint(b));
  });

  it('un parámetro distinto es otra receta', () => {
    const a: RecipeSpec = {
      blocks: [{ block: 'commitments_by_state', params: { horizonDays: 30 } }],
    };
    const b: RecipeSpec = {
      blocks: [{ block: 'commitments_by_state', params: { horizonDays: 90 } }],
    };
    expect(recipeFingerprint(a)).not.toBe(recipeFingerprint(b));
  });

  it('el mismo par de bloques en otro orden es otro informe', () => {
    // A propósito: el orden de lectura es parte de lo que un informe dice. El
    // que abre con la plata en riesgo y el que abre con la lista de placas no se
    // leen igual, y llamarlos el mismo informe sería tan falso como lo contrario.
    expect(recipeFingerprint(specOf('commitments_by_state', 'fleet_papers'))).not.toBe(
      recipeFingerprint(specOf('fleet_papers', 'commitments_by_state')),
    );
  });

  it('guardar la misma pregunta con otro nombre devuelve la que ya existía', async () => {
    const w = world();
    const ctx = w.ctx(ACME, ANA);
    const spec = specOf('commitments_by_state', 'commitments_by_month');

    const first = await saveRecipe(ctx, {
      name: 'cómo vamos',
      title: 'cómo vamos',
      periodLabel: 'este trimestre',
      spec,
    });
    expect(first.alreadyExisted).toBe(false);

    const second = await saveRecipe(ctx, {
      name: 'resumen para la junta',
      title: 'resumen para la junta',
      periodLabel: 'este trimestre',
      spec,
    });
    expect(second.alreadyExisted).toBe(true);
    expect(second.row.id).toBe(first.row.id);
    expect((w.tables.report_recipes as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Lo que no sale por la puerta de afuera
// ---------------------------------------------------------------------------

describe('lo que nombra al equipo no sale por un enlace público', () => {
  it('marca el informe cuyo bloque nombra a personas', async () => {
    expect(recipeIsRestricted(specOf('internal_promises'))).toBe(true);
    expect(recipeIsRestricted(specOf('commitments_by_state'))).toBe(false);
    // Y basta con uno: un informe mixto arrastra la restricción del que la trae.
    expect(recipeIsRestricted(specOf('commitments_by_state', 'internal_promises'))).toBe(true);
  });

  it('se niega a acuñar el enlace, y lo dice en español', async () => {
    const w = withInternalPromise(world());
    const ctx = w.ctx(ACME, ANA);
    const saved = await saveRecipe(ctx, {
      name: 'quién debe qué adentro',
      title: 'quién debe qué adentro',
      periodLabel: 'este mes',
      spec: specOf('commitments_by_state', 'internal_promises'),
    });
    const made = await runRecipeAndSave(ctx, saved.row, { now: NOW });
    expect(made.row.restricted).toBe(true);

    await expect(shareReport(ctx, made.row.id)).rejects.toBeInstanceOf(RestrictedReportError);

    // Y no se quedó un token a medio acuñar.
    const stored = (w.tables.reports as Array<Record<string, unknown>>).find(
      (r) => r.id === made.row.id,
    );
    expect(stored?.share_token ?? null).toBeNull();
  });

  it('el que no nombra a nadie se comparte como siempre', async () => {
    const w = world();
    const ctx = w.ctx(ACME, ANA);
    const saved = await saveRecipe(ctx, {
      name: 'vencimientos',
      title: 'vencimientos del trimestre',
      periodLabel: 'próximos 90 días',
      spec: specOf('commitments_by_state'),
    });
    const made = await runRecipeAndSave(ctx, saved.row, { now: NOW });
    expect(made.row.restricted).toBe(false);
    const share = await shareReport(ctx, made.row.id);
    expect(share.url).toContain('/api/files/report/');
  });
});

// ---------------------------------------------------------------------------
// 6. Aislamiento
// ---------------------------------------------------------------------------

/**
 * Un informe a la medida es el peor sitio del producto para perder un filtro:
 * el mundo de prueba le da a las dos empresas un camión, un SOAT y un cliente
 * que se llaman casi igual, así que una consulta sin `organization_id` no
 * devuelve algo vacío, devuelve algo verosímil. Se afirma sobre los TOTALES.
 */
describe('un informe a la medida no ve la empresa de al lado', () => {
  it('cada empresa cuenta sólo lo suyo', async () => {
    const w = world();

    const acme = await runRecipe({
      db: w.db(ACME),
      title: 'x',
      periodLabel: 'x',
      spec: specOf('commitments_by_state'),
      today: TODAY,
      now: NOW,
    });
    const globex = await runRecipe({
      db: w.db(GLOBEX),
      title: 'x',
      periodLabel: 'x',
      spec: specOf('commitments_by_state'),
      today: TODAY,
      now: NOW,
    });

    const risk = (doc: typeof acme) =>
      figuresOf(doc).find((f) => f.label === 'Plata en riesgo')?.figure.raw ?? 0;

    // Cifras EXACTAS y no «mayor que», que es lo único que sirve aquí: un
    // filtro perdido no deja un total vacío, deja uno verosímil. Las de Globex
    // son deliberadamente enormes, así que la suma de Acme sólo puede dar
    // 9.200.000 si no vio ni una fila de al lado.
    expect(risk(acme)).toBe(1_200_000 + 8_000_000);
    expect(risk(globex)).toBe(999_999_999 + 777_777_777);

    // Y el conteo de filas de la fuente tampoco puede sumar las dos empresas.
    expect(acme.sources[0]?.rowCount).toBe(2);
    expect(globex.sources[0]?.rowCount).toBe(2);
  });

  it('una receta de otra empresa no se puede correr desde acá', async () => {
    const w = world();
    const acmeCtx = w.ctx(ACME, ANA);
    const globexCtx = w.ctx(GLOBEX, CARLA);

    const saved = await saveRecipe(acmeCtx, {
      name: 'sólo de acme',
      title: 'sólo de acme',
      periodLabel: 'x',
      spec: specOf('commitments_by_state'),
    });

    const { getRecipe } = await import('../recipe');
    expect(await getRecipe(globexCtx.db, saved.row.id)).toBeNull();
    expect(await getRecipe(acmeCtx.db, saved.row.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. El documento entero sigue siendo válido
// ---------------------------------------------------------------------------

describe('el documento que sale de una receta pasa por la misma puerta', () => {
  it('un informe de todos los bloques a la vez valida y se dibuja', async () => {
    const w = withInternalPromise(world());
    const doc = await runRecipe({
      db: w.db(ACME),
      title: 'todo junto',
      periodLabel: 'la ventana entera',
      spec: specOf(...BLOCK_IDS),
      today: TODAY,
      now: NOW,
    });

    expect(() => validateDocument(doc)).not.toThrow();
    expect(doc.kind).toBe('custom');

    const html = renderReportHtml(doc);
    // Nada ejecutable, con `render.test.ts` cubriendo el caso adversario en
    // detalle: aquí sólo se comprueba que la composición no abrió una puerta.
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror=');
    expect(html).toContain('A la medida');
  });
});
