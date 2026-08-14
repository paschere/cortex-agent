import 'server-only';
import {
  type ClientRow,
  SERVICE_LABEL,
  type ToolContext,
  listClients,
  runTool,
  searchSpaces,
  webScrape,
  webSearch,
} from '@cortex/agent-tools';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pickIdentity } from './extract';
import type { FactCandidate, FactProvenance, ProposalSource } from './proposal';

/**
 * DE DÓNDE SALE LO QUE SE PROPONE.
 *
 * ===========================================================================
 * NINGUNA DE ESTAS CUATRO FUENTES LLAMA A UN MODELO PARA REDACTAR UN VALOR
 * ===========================================================================
 * Y no es un detalle de implementación, es LA decisión del archivo.
 *
 * Todo valor propuesto lleva un chip que dice de dónde salió, y ese chip es una
 * afirmación: «esto está en tu contrato con Coltrans». Si el texto lo hubiera
 * redactado un modelo leyendo el contrato, la afirmación sería falsa —la frase
 * no está en el contrato, se PARECE a lo que dice el contrato— y sería falsa de
 * la única forma que una persona no puede detectar de un vistazo, porque lo que
 * ve es una frase sensata con un sello debajo. Un producto cuya señal de
 * confianza no es fiable es peor que uno sin señal.
 *
 * Así que aquí sólo hay dos clases de valor:
 *
 *   SUBCADENAS. La razón social y el NIT salen tal cual del documento o de la
 *   página, con el renglón donde estaban para poder cotejarlos (`extract.ts`).
 *
 *   ARITMÉTICA. El plazo de pago y la moneda son cuentas sobre sus propias
 *   filas, exactas y reproducibles, y el chip dice sobre cuántas está hecha la
 *   cuenta — que es la diferencia entre «47 días» y «47 días, de 24 facturas».
 *
 * Lo que no se puede sacar de una de esas dos formas NO SE SACA. «A qué se
 * dedica» resumido de nueve páginas no está aquí, y ese hueco es deliberado:
 * ver el final de este comentario.
 *
 * ===========================================================================
 * TODO ESTO SE CAE BIEN, DE UNA EN UNA
 * ===========================================================================
 * Cada fuente va en su propio `try`. Si el cerebro no contesta, si Tavily no
 * está configurado, si la página web no carga, si la tabla de pagos está vacía:
 * esa fuente aporta cero candidatos y una frase en `notes`, y las demás siguen.
 * Una propuesta con tres campos es útil. Una pantalla que no carga porque se
 * cayó una llamada no lo es.
 *
 * LA FUENTE A —lo que el espacio ya sabe de sí mismo— NO NECESITA NI RED
 * EXTERNA NI EMBEDDINGS. Son consultas a sus propias tablas. Es la parte que
 * siempre funciona, y por eso va primera.
 *
 * ===========================================================================
 * LO QUE NO ESTÁ, Y POR QUÉ NO ESTÁ
 * ===========================================================================
 *
 *   RUES. El registro mercantil es la fuente canónica de la razón social, el
 *   NIT, la matrícula, el CIIU, el domicilio y el representante legal, y sería
 *   con diferencia la mejor de las cuatro. No hay ningún trámite de RUES
 *   grabado en `browser_flows`, y grabarlo exige a una persona delante del
 *   navegador. NO se ha escrito el conector: un conector contra una fuente
 *   cuya forma de respuesta nadie ha visto todavía es un mapeo inventado hoy
 *   sobre suposiciones de hoy, que nadie ejecutará hasta dentro de meses y que
 *   para entonces habrá envejecido sin que ninguna prueba se entere. Lo que sí
 *   está preparado es el escalón: `ProposalSource` ya tiene `'registry'` y ya
 *   gana al contrato y a la web en `SOURCE_RANK`, así que el día que exista el
 *   trámite basta con emitir candidatos con ese `kind`. El hueco está en la
 *   tabla de rangos, que es dato, y no en una función muerta.
 *
 *   «CUÁNTA GENTE SOMOS», que se podría contar y no se cuenta. La tabla
 *   `users` dice cuántas CUENTAS DE CORTEX hay, no cuántos empleados tiene la
 *   empresa, y en un espacio donde entran ocho de cuarenta personas la
 *   respuesta sería «8». Ese número es verosímil, es exacto como cuenta, y es
 *   falso como respuesta — exactamente la clase de dato que arruina meses de
 *   respuestas sin que nadie lo mire dos veces. Se queda en el hueco.
 *
 *   «A QUÉ SE DEDICA» SACADO DE LA WEB. Es el campo que más pide un resumen y
 *   por eso mismo es el que no se puede citar. Ver el primer bloque.
 */

/** Cuántos pagos hacen falta para que una mediana signifique algo. */
const MIN_PAYMENTS = 5;

/** Cuántos clientes con plazo pactado hacen falta para proponer ese plazo. */
const MIN_CLIENTS_WITH_TERMS = 3;

/** Cuántas filas se miran como mucho. El mismo tope que usa `payments`. */
const SCAN = 1000;

export interface GatherInput {
  db: SupabaseClient;
  /** Para las herramientas que van por `runTool` (la web). Null si no hay agente. */
  ctx: ToolContext | null;
  userId: string;
  /** El nombre que tecleó la persona. Es el ancla de toda la identidad. */
  typedName: string;
  /** El sitio de la empresa, si lo escribió. Opcional. */
  site?: string | null;
}

export interface GatherResult {
  candidates: FactCandidate[];
  /**
   * Lo que no se pudo mirar, en español y sin disculpas.
   *
   * Va a la pantalla. Una propuesta corta porque el cerebro está vacío y una
   * propuesta corta porque la búsqueda se cayó se parecen mucho y significan lo
   * contrario, y sin esta lista no habría forma de distinguirlas.
   */
  notes: string[];
}

/** «2026-03-12» → «12 mar 2026». Lo que va en el chip. */
function shortDate(iso: string | null | undefined): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** La mediana, que aguanta el pago de hace catorce meses que la media no aguanta. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return Math.round((((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2) * 10) / 10;
}

function daysApart(from: string, to: string): number | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

function candidate(
  section: string,
  label: string,
  value: string,
  provenance: FactProvenance,
): FactCandidate {
  return { section, label, value, provenance };
}

// ---------------------------------------------------------------------------
// FUENTE A · lo que el espacio ya sabe de sí mismo
// ---------------------------------------------------------------------------

/**
 * El plazo de pago OBSERVADO y la moneda, de sus propios pagos.
 *
 * El plazo observado sale de restar la fecha de emisión de la factura a la
 * fecha en que entró la plata, y por tanto sólo cuenta los pagos que quedaron
 * aplicados a una factura (`payments.extraction_id`). Es una limitación real y
 * se dice en el chip, con el número de facturas: es la misma disciplina que
 * `describeReceivables`, y es lo que separa «47 días» de «47 días, sobre 24
 * facturas» — la segunda se puede discutir y la primera hay que creérsela.
 */
async function fromPayments(db: SupabaseClient): Promise<GatherResult> {
  const { data, error } = await db
    .from('payments')
    .select('paid_on, currency, extraction_id')
    .eq('kind', 'payment')
    .in('state', ['reported', 'confirmed'])
    .limit(SCAN);
  if (error)
    return { candidates: [], notes: ['No se pudieron leer tus pagos, así que no miré ahí.'] };

  const rows = data ?? [];
  if (rows.length === 0) return { candidates: [], notes: [] };

  const candidates: FactCandidate[] = [];

  // --- La moneda. Se dice la principal, y se dice si hay otra, porque un
  //     espacio que factura también en dólares y lee «Moneda: COP» en cada
  //     respuesta tiene un dato peor que ninguno.
  const byCurrency = new Map<string, number>();
  for (const row of rows) {
    const cur = String(row.currency ?? '').toUpperCase();
    if (cur) byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + 1);
  }
  const ranked = [...byCurrency.entries()].sort((a, b) => b[1] - a[1]);
  const main = ranked[0];
  if (main) {
    const others = ranked.slice(1);
    const value =
      others.length === 0
        ? main[0]
        : `${main[0]} (también ${others.map(([c, n]) => `${c} en ${n}`).join(', ')} de ${rows.length} pagos)`;
    candidates.push(
      candidate('ingresos', 'Moneda', value, {
        kind: 'workspace',
        source: 'Tus pagos',
        detail: `${rows.length} pagos`,
      }),
    );
  }

  // --- El plazo observado. Necesita la fecha de emisión, que vive en la
  //     extracción del documento y no en el pago.
  const extractionIds = [...new Set(rows.map((r) => r.extraction_id).filter(Boolean))] as string[];
  if (extractionIds.length === 0) return { candidates, notes: [] };

  const { data: extractions, error: exError } = await db
    .from('document_extractions')
    .select('id, issued_on')
    .in('id', extractionIds.slice(0, SCAN));
  if (exError) return { candidates, notes: [] };

  const issuedOn = new Map(
    (extractions ?? [])
      .filter((e) => typeof e.issued_on === 'string')
      .map((e) => [e.id as string, e.issued_on as string]),
  );

  const spans: number[] = [];
  for (const row of rows) {
    const issued = row.extraction_id ? issuedOn.get(row.extraction_id as string) : undefined;
    if (!issued || typeof row.paid_on !== 'string') continue;
    const days = daysApart(issued, row.paid_on);
    // Un plazo negativo es un anticipo o una fecha mal leída, y ninguna de las
    // dos cosas es «el plazo con que te pagan». Se deja fuera del cálculo en
    // vez de tirar de la mediana hacia abajo sin que se note.
    if (days !== null && days >= 0) spans.push(days);
  }

  if (spans.length >= MIN_PAYMENTS) {
    candidates.push(
      candidate('ingresos', 'Plazo de pago', `${median(spans)} días`, {
        kind: 'workspace',
        source: 'Tus pagos',
        detail: `mediana de ${spans.length} facturas cobradas`,
      }),
    );
  }

  return { candidates, notes: [] };
}

/**
 * Qué venden y qué plazo tienen PACTADO, de sus propios clientes.
 *
 * El plazo pactado sale detrás del observado a propósito: los dos responden a
 * «Plazo de pago» y `selectProposal` rompe el empate por orden de llegada, así
 * que el que gana es el que describe lo que de verdad pasa y el que queda a un
 * clic es el que describe lo que se firmó. La persona elige, que es lo suyo:
 * las dos son verdad y sirven para cosas distintas.
 */
function fromClients(rows: ClientRow[]): GatherResult {
  if (rows.length === 0) return { candidates: [], notes: [] };

  const candidates: FactCandidate[] = [];

  // --- Qué vendemos: los servicios que están registrados contra sus clientes.
  const byService = new Map<string, number>();
  for (const row of rows)
    for (const s of row.services ?? []) byService.set(s, (byService.get(s) ?? 0) + 1);
  const services = [...byService.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([key]) => SERVICE_LABEL[key as keyof typeof SERVICE_LABEL] ?? key);
  if (services.length > 0) {
    candidates.push(
      candidate('ingresos', 'Qué vendemos', services.join(', '), {
        kind: 'workspace',
        source: 'Tus clientes',
        detail: `${rows.length} clientes`,
      }),
    );
  }

  // --- Plazo pactado: la moda de lo que dice cada ficha de cliente.
  const byTerm = new Map<number, number>();
  for (const row of rows) {
    const days = row.payment_terms_days;
    if (typeof days === 'number') byTerm.set(days, (byTerm.get(days) ?? 0) + 1);
  }
  const top = [...byTerm.entries()].sort((a, b) => b[1] - a[1])[0];
  if (top && top[1] >= MIN_CLIENTS_WITH_TERMS) {
    candidates.push(
      candidate('ingresos', 'Plazo de pago', `${top[0]} días`, {
        kind: 'workspace',
        source: 'Tus clientes',
        detail: `pactado con ${top[1]} de ${rows.length}`,
      }),
    );
  }

  return { candidates, notes: [] };
}

const PROVIDER_LABEL: Record<string, string> = {
  google: 'Google Workspace',
  microsoft: 'Microsoft 365',
  hubspot: 'HubSpot',
  github: 'GitHub',
  linear: 'Linear',
};

/** Con qué trabajan, según lo que está conectado a Cortex. */
async function fromIntegrations(db: SupabaseClient): Promise<GatherResult> {
  const { data, error } = await db.from('integrations').select('provider');
  if (error) return { candidates: [], notes: [] };

  const names = new Set<string>();
  for (const row of data ?? []) {
    const provider = String(row.provider ?? '');
    if (provider) names.add(PROVIDER_LABEL[provider] ?? provider);
  }

  const { data: servers, error: serversError } = await db
    .from('user_mcp_servers')
    .select('name')
    .eq('enabled', true);
  if (!serversError) for (const row of servers ?? []) if (row.name) names.add(String(row.name));

  if (names.size === 0) return { candidates: [], notes: [] };
  return {
    candidates: [
      candidate('operacion', 'Herramientas que usamos', [...names].join(', '), {
        kind: 'workspace',
        source: 'Integraciones conectadas',
      }),
    ],
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// FUENTE B · sus documentos
// ---------------------------------------------------------------------------

/**
 * La identidad, sacada literal de sus propios documentos.
 *
 * La recuperación es la misma que usa el chat (`searchSpaces`), que ya sabe
 * degradar sola: si los embeddings no contestan, la búsqueda se queda con el
 * brazo léxico de Postgres y sigue devolviendo los trozos que contienen la
 * palabra «NIT» — que para esto es justo lo que hace falta. La extracción de
 * después no depende de ningún modelo en ningún caso.
 */
async function fromDocuments(
  db: SupabaseClient,
  userId: string,
  typedName: string,
  excludeNitDigits: string[],
): Promise<GatherResult> {
  let hits: Awaited<ReturnType<typeof searchSpaces>>;
  try {
    hits = await searchSpaces(db, {
      userId,
      query: `${typedName} NIT razón social`,
      limit: 8,
    });
  } catch {
    return {
      candidates: [],
      notes: ['No se pudo buscar en Brain Knowledge, así que no miré tus documentos.'],
    };
  }

  const candidates: FactCandidate[] = [];
  let haveName = false;
  let haveNit = false;

  for (const hit of hits) {
    if (haveName && haveNit) break;
    const { legalName, nit } = pickIdentity(hit.content, { typedName, excludeNitDigits });
    const provenance = (quote: string): FactProvenance => ({
      kind: 'document' as ProposalSource,
      source: hit.documentTitle,
      readAt: shortDate(hit.datedAt),
      quote,
    });

    if (legalName && !haveName) {
      haveName = true;
      candidates.push(
        candidate('identidad', 'Razón social', legalName.value, provenance(legalName.quote)),
      );
    }
    if (nit && !haveNit) {
      haveNit = true;
      candidates.push(candidate('identidad', 'NIT', nit.value, provenance(nit.quote)));
    }
  }

  return { candidates, notes: [] };
}

// ---------------------------------------------------------------------------
// FUENTE C · la web
// ---------------------------------------------------------------------------

/**
 * Lo mismo, de su sitio web, y sólo lo que se puede citar palabra por palabra.
 *
 * Para un dato legal la web es la fuente más débil que hay y la que más se
 * inventa, así que aquí se trata como tal por partida triple: entra con
 * `kind: 'web'`, que pierde contra todas las demás; el chip nombra el dominio
 * exacto y el día en que se leyó; y `BULK_ACCEPTABLE` la deja fuera del botón
 * de aceptar en bloque, así que un valor de la web se acepta de uno en uno o no
 * se acepta.
 *
 * Vale la pena a pesar de todo eso, y el caso es concreto: un espacio recién
 * creado no tiene ni un contrato en el cerebro, y casi todas las empresas
 * colombianas llevan la razón social y el NIT en el pie de su propia página.
 * Es la única fuente que le sirve a quien acaba de entrar, que es exactamente a
 * quien hay que prerrellenarle la ficha.
 */
async function fromWeb(
  ctx: ToolContext | null,
  typedName: string,
  site: string | null | undefined,
  excludeNitDigits: string[],
): Promise<GatherResult> {
  if (!ctx)
    return {
      candidates: [],
      notes: ['Cortex no está configurado en este espacio, así que no miré la web.'],
    };

  const today = shortDate(new Date().toISOString().slice(0, 10));
  const pages: Array<{ host: string; text: string }> = [];
  const notes: string[] = [];

  if (site) {
    const url = /^https?:\/\//i.test(site) ? site : `https://${site}`;
    try {
      const page = await runTool(webScrape, { url, maxChars: 20000 }, ctx, { confirmed: true });
      pages.push({ host: hostOf(url), text: page.content });
    } catch {
      notes.push(`No se pudo leer ${hostOf(url)}. Revisa la dirección, o déjala en blanco.`);
    }
  } else {
    try {
      const found = await runTool(
        webSearch,
        { query: `"${typedName}" NIT razón social Colombia`, maxResults: 5 },
        ctx,
        { confirmed: true },
      );
      for (const result of found.results)
        pages.push({ host: hostOf(result.url), text: `${result.title}\n${result.content}` });
    } catch {
      notes.push('La búsqueda web no está disponible aquí. Si sabes el sitio, escríbelo y lo leo.');
    }
  }

  const candidates: FactCandidate[] = [];
  let haveName = false;
  let haveNit = false;

  for (const page of pages) {
    if (haveName && haveNit) break;
    const { legalName, nit } = pickIdentity(page.text, { typedName, excludeNitDigits });
    const provenance = (quote: string): FactProvenance => ({
      kind: 'web' as ProposalSource,
      source: page.host,
      readAt: today,
      quote,
    });

    if (legalName && !haveName) {
      haveName = true;
      candidates.push(
        candidate('identidad', 'Razón social', legalName.value, provenance(legalName.quote)),
      );
    }
    if (nit && !haveNit) {
      haveNit = true;
      candidates.push(candidate('identidad', 'NIT', nit.value, provenance(nit.quote)));
    }
  }

  return { candidates, notes };
}

// ---------------------------------------------------------------------------

/**
 * Las cuatro fuentes, a la vez, y ninguna capaz de tumbar a las otras.
 *
 * `Promise.all` y no una detrás de otra: son lecturas independientes y hacer
 * esperar a la aritmética de los pagos —que tarda milisegundos— a que conteste
 * una página web sería sumar segundos a cambio de nada. Cada una ya trae su
 * propio `try`, así que aquí no hay nada que pueda rechazar.
 */
export async function gatherCandidates(input: GatherInput): Promise<GatherResult> {
  const typedName = input.typedName.trim();

  // LOS CLIENTES SE LEEN UNA VEZ Y SIRVEN PARA DOS COSAS, y la segunda es la
  // que importa: sus NIT son la lista de exclusión. Sin ella, el NIT de un
  // cliente que aparece en su propio contrato es un candidato perfectamente
  // plausible para el NIT de la empresa, y nadie volvería a mirarlo.
  //
  // Va antes del `Promise.all` a propósito, porque dos de las fuentes de dentro
  // dependen de ella. Es la única espera en serie del archivo y cuesta una
  // consulta.
  let clients: ClientRow[] = [];
  let clientsNote: string[] = [];
  try {
    clients = await listClients(input.db, { limit: 200 });
  } catch {
    // Sin la lista de exclusión se sigue: `pickIdentity` se calla igual cuando
    // hay más de un NIT y no reconoce el nombre, que es la guarda de verdad.
    clientsNote = ['No se pudieron leer tus clientes, así que no miré ahí.'];
  }
  const excludeNitDigits = clients
    .map((c) => c.tax_id)
    .filter((x): x is string => typeof x === 'string' && x.length > 0);

  const parts = await Promise.all([
    fromPayments(input.db),
    fromIntegrations(input.db),
    fromDocuments(input.db, input.userId, typedName, excludeNitDigits),
    fromWeb(input.ctx, typedName, input.site, excludeNitDigits),
  ]);
  // EL ORDEN DE ESTA LÍNEA ES SIGNIFICATIVO Y NO ES ESTÉTICO. Los clientes van
  // DETRÁS de los pagos porque las dos fuentes responden a «Plazo de pago» y
  // `selectProposal` rompe el empate —las dos son `workspace`— por orden de
  // llegada. Así gana el plazo OBSERVADO en los pagos y el PACTADO en las
  // fichas de cliente queda como alternativa, a un clic. Moverla arriba
  // invierte esa decisión sin que ninguna prueba se entere.
  parts.push(fromClients(clients));

  return {
    candidates: parts.flatMap((p) => p.candidates),
    notes: [...clientsNote, ...parts.flatMap((p) => p.notes)],
  };
}
