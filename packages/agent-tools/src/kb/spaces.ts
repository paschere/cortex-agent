import { ForbiddenError, type Logger, NotFoundError, ValidationError } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { embedQuery } from './embedder';
import { rerankByMeaning, rerankerAvailable } from './reranker';

/**
 * The Brain Knowledge access boundary. Everything that reads or writes KB
 * content — the tools, the web routes, both MCP servers — goes through here.
 *
 * WHY IT IS ONE MODULE. Before spaces, every caller worked out for itself which
 * buckets a person was allowed to see, and they disagreed: the search route
 * accepted a list of bucket ids straight from the browser, the documents route
 * checked nothing, and the tool trusted whatever the model asked for. None of
 * those were wrong on purpose; each one was written on a different day. The
 * rule has to live in exactly one place or it drifts again.
 *
 * The rule is enforced twice, deliberately:
 *   - here, so callers get a clear error and never see a title they shouldn't;
 *   - in `kb_search_scoped` / `kb_visible_space_ids` in Postgres, so a caller
 *     that skips this module still cannot retrieve someone else's notes. The
 *     unscoped search function was dropped in 0049; there is no longer a
 *     database entry point that takes "which spaces" as an argument.
 */

/**
 * De quién es un espacio y, por tanto, qué significa encontrarse algo en él.
 *
 *   'global'    un espacio de la organización abierto a toda la empresa. Lo que
 *               se encuentra aquí es lo que la empresa ya acordó.
 *   'shared'    un espacio de la organización repartido a unos equipos o a unas
 *               personas. Es conocimiento de la empresa, pero de un círculo, y
 *               citarlo delante de quien no lo ve es filtrarlo.
 *   'personal'  el cuaderno de una persona. Nadie más lo ve salvo que su dueño
 *               lo preste, y ni un administrador puede prestarlo por ella.
 *
 * 'global' y 'shared' son la MISMA fila en la base de datos — las dos con
 * `scope = 'global'` — y lo único que las separa es si existe la concesión de
 * sujeto «todo el mundo». Ver la migración 0123: la visibilidad se concede, no
 * se deduce del scope.
 */
export type SpaceKind = 'global' | 'shared' | 'personal';

/**
 * Lo que una persona puede hacer en un espacio, de menos a más:
 *
 *   'view'        buscar y leer.
 *   'contribute'  además, guardar documentos aquí.
 *   'admin'       además, repartir el acceso, renombrar y borrar.
 *
 * El orden lo decide la base de datos (`kb_grant_rank`, migración 0123) porque
 * es la base de datos la que resuelve el nivel efectivo cuando a alguien le
 * llega por varios caminos. `RANK` de más abajo es su espejo y no puede
 * discrepar sin que se conceda de más, así que los dos se leen juntos.
 */
export type SpaceLevel = 'view' | 'contribute' | 'admin';

const RANK: Record<SpaceLevel, number> = { view: 1, contribute: 2, admin: 3 };

/** ¿Alcanza este nivel para lo que se quiere hacer? Un nivel nulo nunca alcanza. */
export function atLeast(level: SpaceLevel | null, needed: SpaceLevel): boolean {
  return level !== null && RANK[level] >= RANK[needed];
}

export interface Space {
  id: string;
  name: string;
  kind: SpaceKind;
  description: string | null;
  /** The one person who can see a personal space. Null for global spaces. */
  ownerId: string | null;
  createdBy: string | null;
  createdAt: string;
  /**
   * Lo que puede hacer aquí LA PERSONA POR LA QUE SE PIDIÓ este espacio. Viaja
   * pegado al espacio y no aparte porque la pregunta «¿puedo escribir aquí?» se
   * hace siempre justo después de «¿cuál es este espacio?», y separarlas es como
   * se acaba pintando un botón que el servidor va a rechazar.
   */
  level: SpaceLevel;
}

/** Un espacio en una lista, con lo que hace falta para pintar «quién lo ve». */
export interface SpaceSummary extends Space {
  /** Cuántos equipos y personas tienen acceso, sin contar «toda la empresa». */
  grantCount: number;
}

/** Una línea del panel «quién ve esto». */
export interface SpaceGrant {
  id: string;
  subjectKind: 'everyone' | 'team' | 'user';
  /** Null cuando el sujeto es toda la empresa. */
  subjectId: string | null;
  /** El nombre del equipo o de la persona, ya resuelto por la base de datos. */
  subjectName: string;
  level: SpaceLevel;
  grantedAt: string;
}

export interface SpaceHit {
  documentId: string;
  documentTitle: string;
  spaceId: string;
  spaceName: string;
  spaceKind: SpaceKind;
  chunkIndex: number;
  content: string;
  /**
   * The 0.7 semantic / 0.3 keyword blend the database sorts by. A good ORDER
   * and a meaningless magnitude — threshold on `semanticScore` instead, and see
   * relevance.ts for what that cost when nobody did.
   */
  score: number;
  /** Identifies the chunk itself, which is what a conflict lookup starts from. */
  chunkId: string;
  /**
   * Raw cosine similarity between question and passage: the only number here
   * that means the same thing from one query to the next. Null — never 0 —
   * when the semantic arm did not run for this row, because 0 is a real
   * similarity and would read as a certain miss.
   */
  semanticScore: number | null;
  /** ts_rank of the literal-word match. Zero for most rows. */
  keywordScore: number;
  /**
   * The provider-qualified model behind `semanticScore` — the same one on both
   * sides, because `kb_search_scoped` will not rank a query vector against a
   * chunk written by any other model (migration 0074). Null when the semantic
   * arm did not run.
   *
   * It travels on the hit because cosine similarity has no meaning without it:
   * relevance.ts keeps a different pair of thresholds per model, and a score
   * that arrives without saying which scale it is on is exactly how thresholds
   * measured for one embedder went on being applied to another.
   */
  embeddingModel: string | null;
  /**
   * The document's own date: when the call happened or the note was written,
   * not when the file was uploaded. This is the date a citation should carry.
   */
  datedAt: string | null;
  /** When the document says it stops being true, if it says so at all. */
  validUntil: string | null;
  /** Set when somebody filed a replacement for this document. */
  supersededById: string | null;
  supersededByTitle: string | null;
  /**
   * Whatever the chunk was filed with. `{pages}` for a parsed document,
   * `{speaker, speakers, startMs, endMs}` for a chunk of a recording — which
   * is what lets a caller cite the minute rather than just the file.
   */
  metadata: Record<string, unknown>;
}

type SpaceRow = {
  id: string;
  name: string;
  scope: string;
  scope_id: string | null;
  description: string | null;
  created_by: string | null;
  created_at: string;
  /**
   * Espejo de «existe la concesión a todo el mundo» (migración 0123 § 1bis).
   * Opcional en el tipo, y no por descuido: un despliegue al que le falte una
   * migración debe perder la distinción entre 'global' y 'shared', no romperse
   * en cada lectura. Ausente se lee como falso, que es el lado prudente — un
   * espacio se pinta como repartido, nunca como público, cuando no se sabe.
   */
  everyone?: boolean | null;
  level?: string | null;
  grant_count?: number | null;
};

function kindOf(scope: string, everyone: boolean | null | undefined): SpaceKind {
  if (scope !== 'global') return 'personal';
  return everyone ? 'global' : 'shared';
}

function toSpace(row: SpaceRow, level: SpaceLevel): Space {
  return {
    id: row.id,
    name: row.name,
    kind: kindOf(row.scope, row.everyone),
    description: row.description,
    ownerId: row.scope_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    level,
  };
}

/**
 * Todos los espacios de los que esta persona puede recuperar: los suyos, más
 * todo lo que se le haya concedido — a ella, a un equipo suyo, o a toda la
 * empresa — más, si administra la organización, los espacios comunes de esa
 * organización.
 *
 * SE PREGUNTA A LA BASE DE DATOS, no se arma aquí. Antes esta función escribía
 * el filtro a mano (`scope.eq.global,and(scope.eq.user,scope_id.eq.X)`) porque
 * la regla cabía en una línea. Con concesiones ya no cabe: haría falta traerse
 * los equipos de la persona, luego sus concesiones, luego los espacios, y
 * cualquiera de los tres pasos escrito de otra manera en otro sitio sería una
 * segunda definición de quién ve qué. `kb_spaces_for` se apoya en
 * `kb_visible_space_ids` — la misma función de la que sale la búsqueda — así
 * que esta lista NO PUEDE contener un espacio del que la búsqueda no
 * recuperaría, ni al revés. Esa es toda la razón de que sea una llamada y no
 * una consulta.
 */
export async function listVisibleSpaces(
  db: SupabaseClient,
  userId: string,
): Promise<SpaceSummary[]> {
  if (!userId) return [];
  const { data, error } = await db.rpc('kb_spaces_for', { p_user_id: userId });
  if (error) throw error;
  return ((data ?? []) as SpaceRow[]).map((row) => ({
    ...toSpace(row, (row.level as SpaceLevel | null) ?? 'view'),
    grantCount: row.grant_count ?? 0,
  }));
}

/**
 * Un espacio con el nivel de quien pregunta, o null si ni siquiera lo ve.
 *
 * UN SOLO VIAJE, y es deliberado: «tráeme este espacio» y «¿qué puedo hacer
 * aquí?» son siempre la misma pregunta hecha seguida, y por este camino pasa
 * cada lectura de cada documento. El nivel puede llegar por su equipo, por ella
 * misma, por estar el espacio abierto a toda la empresa o por su rol, y gana el
 * más alto; esa resolución vive entera en la base de datos.
 */
async function fetchSpace(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<{ row: SpaceRow; level: SpaceLevel } | null> {
  if (!userId || !spaceId) return null;
  const { data, error } = await db.rpc('kb_space_for', {
    p_user_id: userId,
    p_space_id: spaceId,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as SpaceRow | null | undefined;
  if (!row) return null;
  const level = row.level;
  if (level !== 'view' && level !== 'contribute' && level !== 'admin') return null;
  return { row, level };
}

/** Lo que esta persona puede hacer en este espacio, o null si ni siquiera lo ve. */
export async function spaceLevel(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<SpaceLevel | null> {
  return (await fetchSpace(db, userId, spaceId))?.level ?? null;
}

/**
 * Fetch one space, or throw as if it did not exist when the caller cannot see
 * it. "Not found" rather than "forbidden" is the point: a wrong-id probe and a
 * someone-else's-space probe have to be indistinguishable, otherwise the error
 * message itself confirms that a private space exists.
 */
export async function getVisibleSpace(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<Space> {
  const found = await fetchSpace(db, userId, spaceId);
  // «No existe» y «existe pero no es tuyo» salen por la misma puerta, y por eso
  // la función de la base de datos devuelve cero filas en los dos casos en vez
  // de distinguirlos: si el mensaje de error los separara, sería una manera de
  // confirmar que el espacio privado de un compañero existe.
  if (!found) throw new NotFoundError('That space no longer exists.');
  return toSpace(found.row, found.level);
}

/**
 * Quién puede meter un documento en un espacio: quien tenga 'contribute' o más.
 *
 * Antes de la 0123 esta pregunta se contestaba con dos ramas fijas — el dueño
 * en un espacio personal, un administrador de la organización en uno común — y
 * ésa era exactamente la rigidez que hacía imposible «Finanzas mantiene
 * Tarifas». Ahora se contesta con el nivel efectivo, que ya incluye las dos
 * ramas viejas: el dueño de su cuaderno resuelve 'admin', y un administrador de
 * la organización resuelve 'admin' sobre los espacios comunes. Nadie pierde
 * nada de lo que podía hacer ayer.
 */
export async function assertCanWriteToSpace(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<Space> {
  const space = await getVisibleSpace(db, userId, spaceId);
  if (!atLeast(space.level, 'contribute')) {
    throw new ForbiddenError(
      space.kind === 'personal'
        ? 'Ese espacio es el cuaderno de otra persona: te lo prestó para leer, no para escribir en él.'
        : `Puedes leer «${space.name}» pero no guardar ahí. Pídele acceso de aportación a quien lo administra, o guárdalo en uno de tus espacios.`,
    );
  }
  return space;
}

/**
 * Quién puede repartir el acceso a un espacio, renombrarlo o borrarlo.
 *
 * Se separa de escribir a propósito: aportar un documento y decidir quién lee
 * el espacio entero son decisiones de tamaños distintos, y juntarlas es como un
 * espacio de equipo acaba abierto a la empresa porque alguien tenía que subir
 * un PDF.
 */
export async function assertCanAdminSpace(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<Space> {
  const space = await getVisibleSpace(db, userId, spaceId);
  if (space.level !== 'admin') {
    throw new ForbiddenError(
      space.kind === 'personal'
        ? 'Las notas de otra persona las reparte esa persona, y nadie más.'
        : `No administras «${space.name}», así que no puedes cambiar quién lo ve.`,
    );
  }
  return space;
}

export async function isOrgAdmin(db: SupabaseClient, userId: string): Promise<boolean> {
  if (!userId) return false;
  const { data } = await db.from('users').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'org_admin';
}

/**
 * The person's own default space, created on first use. Everything Cortex saves
 * without being told where lands here, so the default is the private one: a
 * note that should have been company-wide is a one-click move, a note that
 * should have been private and wasn't cannot be un-published.
 */
export async function ensurePersonalSpace(
  db: SupabaseClient,
  userId: string,
  name = 'My notes',
): Promise<{ id: string; name: string }> {
  const { data: existing, error: findErr } = await db
    .from('kb_collections')
    .select('id, name')
    .eq('scope', 'user')
    .eq('scope_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (findErr) throw findErr;
  if (existing) return { id: existing.id as string, name: existing.name as string };

  const { data: created, error: insErr } = await db
    .from('kb_collections')
    .insert({ scope: 'user', scope_id: userId, name, created_by: userId })
    .select('id, name')
    .single();
  if (insErr || !created) throw new Error(`Could not create your space: ${insErr?.message}`);
  return { id: created.id as string, name: created.name as string };
}

/**
 * Resolve a space the way a person refers to it — by name. Cortex is never
 * given an id to repeat back, so the tools take names and this turns a name
 * into a space the caller can actually write to. Personal spaces win ties: if
 * someone has their own "Rates" and the company has a "Rates", "save it to
 * Rates" means their own.
 */
export async function resolveSpaceByName(
  db: SupabaseClient,
  userId: string,
  name: string,
): Promise<Space | null> {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const visible = await listVisibleSpaces(db, userId);
  const exact = visible.filter((s) => s.name.toLowerCase() === wanted);
  const exactFirst = exact.find((s) => s.kind === 'personal') ?? exact[0];
  if (exactFirst) return exactFirst;

  const partial = visible.filter((s) => s.name.toLowerCase().includes(wanted));
  return partial.length === 1 ? (partial[0] ?? null) : null;
}

export interface SearchSpacesOptions {
  userId: string;
  query: string;
  /**
   * Narrow the search to a subset of what the caller can already see. It can
   * never widen it: the database intersects this with the visible set, so an
   * id belonging to someone else's personal space contributes nothing.
   */
  spaceIds?: string[];
  limit?: number;
  /**
   * Called with a human-readable reason when the semantic half of the search
   * could not run. The search still returns keyword matches, so the caller
   * decides whether to log it, tell the person, or both — what it must not do
   * is present a degraded result as a complete one.
   */
  onDegraded?: (reason: string) => void;
  /**
   * Count this retrieval against the fragments it returns (migration 0073).
   *
   * OFF BY DEFAULT, and the default is the point. The question the counter
   * answers is "does Cortex ever use this fragment to answer anybody" — the
   * memory that is being paid for and never spent. Two callers must therefore
   * NOT set it: the memory bench on the Brain Knowledge page, whose entire
   * purpose is to run the real retrieval without it counting as one, and the
   * search box on the same page, where a person is looking something up by
   * hand. Turning it on by default would make every fragment anybody ever
   * browsed look used, and the signal would be gone within a week of shipping.
   */
  recordRetrieval?: boolean;
  /**
   * Reorder the result set before it is cut to `limit`, counted, or returned.
   *
   * WHY THE HOOK IS HERE AND NOT AT THE CALL SITE. Postgres already applied the
   * limit, so a caller that reordered afterwards would only be shuffling rows
   * that were all going to be used anyway — it could never change WHICH
   * fragments the model is handed, which is the only thing worth changing. So
   * the extra rows have to be fetched here, and once they are fetched they must
   * be discarded here too: the surplus must not be counted as retrieved
   * (migration 0073's "has Cortex ever used this fragment" would rot within a
   * week) and must not reach the caller, where it would quietly widen the set
   * `assessCoverage` judges.
   *
   * The reranker may only REORDER. This function does the cutting, so a
   * reranker cannot lengthen a result set, and a reranker that returns the rows
   * unchanged produces byte-identical behaviour to having no reranker at all.
   *
   * Used by the learning loop (migration 0083), whose implementation is barred
   * from moving a fragment across a relevance band. See learning/apply.ts.
   */
  rerank?: (hits: SpaceHit[]) => SpaceHit[];
  /**
   * Pasarle los candidatos a un segundo lector antes de cortar (ver
   * `kb/reranker.ts`).
   *
   * QUÉ CAMBIA DE VERDAD. Con esto encendido la consulta pide MÁS filas de las
   * que va a devolver —`CANDIDATE_FACTOR` veces más— y deja que el reordenador
   * decida cuáles de ellas sobreviven al corte. Ése es todo el valor: sin la
   * horquilla ancha, un reordenador sólo baraja lo que se iba a usar de todos
   * modos y no puede cambiar QUÉ fragmentos ve el modelo, que es lo único que
   * merece la pena cambiar. Es la misma lección que ya está escrita para
   * `rerank`, aplicada a una horquilla mucho más ancha porque este lector es
   * mucho mejor juez.
   *
   * Apagado por defecto. Cuesta una llamada de red por búsqueda, y hay dos
   * llamadores que no deben pagarla: el banco de memoria de la página de Brain
   * Knowledge, que mide la recuperación cruda a propósito, y cualquier barrido
   * que busque en lote.
   */
  secondReader?: boolean;
  /** Para poder decir que el segundo lector no corrió. Nunca para fallar. */
  logger?: Logger;
  signal?: AbortSignal;
}

/**
 * How many extra rows are fetched when a reranker is present.
 *
 * Small on purpose. It is what lets a demoted fragment actually fall out of the
 * prepended set — without it a reranker can only reorder what was going to be
 * used regardless — and every one of them is a row Postgres ranked and returned
 * for nothing when learning has no opinion. Three covers the realistic case (a
 * couple of fragments under a doubt, out of a limit of three to eight) without
 * turning every search into a materially bigger one.
 */
const RERANK_MARGIN = 3;

/**
 * Cuántos candidatos se traen cuando hay segundo lector, por cada resultado que
 * se va a devolver.
 *
 * Cuatro es donde se cruzan dos costes. Por debajo, el reordenador apenas tiene
 * de dónde elegir y su lectura se desperdicia; por encima, cada candidato es un
 * pasaje más que Postgres ordena, que viaja, y que el reordenador lee y cobra —
 * y el que estaba en el puesto treinta rara vez era la respuesta.
 */
const CANDIDATE_FACTOR = 4;

/** Y un techo absoluto, para que un `limit` grande no dispare una llamada enorme. */
const MAX_CANDIDATES = 40;

/**
 * The single retrieval entry point. Embeds the query and hands the USER — not
 * a list of spaces — to Postgres, which decides what is searchable.
 *
 * When the query cannot be embedded (no Voyage key, provider down), the
 * embedding is sent as null and `kb_search_scoped` falls back to its full-text
 * arm. Half a search beats an exception: the person asked a question, and
 * "here is what matched on words" is a better answer than a red box.
 */
export async function searchSpaces(
  db: SupabaseClient,
  {
    userId,
    query,
    spaceIds,
    limit = 8,
    onDegraded,
    recordRetrieval,
    rerank,
    secondReader,
    logger,
    signal,
  }: SearchSpacesOptions,
): Promise<SpaceHit[]> {
  // A caller that has lost track of who it is asking for must retrieve
  // nothing, not everything.
  if (!userId) return [];
  if (!query.trim()) return [];
  // An explicit empty list means "search these zero spaces", which is not the
  // same as "search everything" — sending null here would silently widen it.
  if (spaceIds && spaceIds.length === 0) return [];

  // `input_type: "query"`, never "document" — the two live on different sides
  // of the same space and mixing them quietly costs recall.
  const embedded = await embedQuery(query);
  if (!embedded.ok) onDegraded?.(embedded.reason);

  // Con segundo lector se pide de más, porque de eso vive: ver más candidatos de
  // los que caben para poder cambiar cuáles caben. Ver `secondReader`.
  const deep = secondReader === true && rerankerAvailable();
  const askFor = deep
    ? Math.min(limit * CANDIDATE_FACTOR, MAX_CANDIDATES)
    : rerank
      ? limit + RERANK_MARGIN
      : limit;

  const { data, error } = await db.rpc('kb_search_scoped', {
    p_user_id: userId,
    p_query_embedding: embedded.ok ? embedded.data : null,
    p_query_text: query,
    // The surplus exists only so a reranker has something to choose from, and
    // it never leaves this function. See `rerank` and `secondReader` above.
    p_limit: askFor,
    p_space_ids: spaceIds ?? null,
    // The vector and the model that produced it always travel together. A query
    // vector from voyage-4-lite scored against a chunk from voyage-3-large does
    // not error, it returns a plausible number — so the database refuses to
    // consider chunks written by any other model, and a search whose model is
    // unknown degrades to keyword-only instead of ranking across spaces that
    // have nothing to do with each other. See migration 0074.
    p_embedding_model: embedded.ok ? embedded.usage.modelId : null,
  });
  if (error) throw error;

  type Row = {
    document_id: string;
    document_title: string;
    space_id: string;
    space_name: string;
    space_scope: string;
    space_everyone?: boolean | null;
    chunk_index: number;
    content: string;
    score: number;
    metadata?: Record<string, unknown> | null;
    chunk_id?: string | null;
    vec_score?: number | null;
    fts_score?: number | null;
    dated_at?: string | null;
    valid_until?: string | null;
    superseded_by?: string | null;
    superseded_by_title?: string | null;
  };

  const rows = (data as Row[]) ?? [];

  const mapped: SpaceHit[] = rows.map((r) => ({
    documentId: r.document_id,
    documentTitle: r.document_title,
    spaceId: r.space_id,
    spaceName: r.space_name,
    // 'shared' sólo puede llegar de un despliegue con la 0125 puesta, que es
    // la migración donde `kb_search_scoped` empezó a decir si el espacio está
    // abierto a toda la empresa. Sin ella la columna no viene y un espacio
    // común se lee como 'global', que es lo que era antes de que existiera la
    // distinción — degradar, no romper.
    spaceKind: kindOf(r.space_scope, r.space_everyone ?? r.space_scope === 'global'),
    chunkIndex: r.chunk_index,
    content: r.content,
    score: Number(r.score),
    // Everything from here down is optional on the row rather than required,
    // for the same reason `metadata` has been since 0058: a deployment whose
    // migrations lag by one should lose the extra columns, not crash on every
    // search. Missing `vec_score` degrades to null, which relevance.ts already
    // reads as "not measured" and handles as keyword-only.
    chunkId: r.chunk_id ?? '',
    semanticScore: r.vec_score === null || r.vec_score === undefined ? null : Number(r.vec_score),
    keywordScore: Number(r.fts_score ?? 0),
    // The scale the cosine above is on. Null whenever there is no cosine —
    // either the query could not be embedded, or this row came back from the
    // keyword arm alone and was never scored by meaning.
    embeddingModel:
      embedded.ok && r.vec_score !== null && r.vec_score !== undefined
        ? embedded.usage.modelId
        : null,
    datedAt: r.dated_at ?? null,
    validUntil: r.valid_until ?? null,
    supersededById: r.superseded_by ?? null,
    supersededByTitle: r.superseded_by_title ?? null,
    metadata: r.metadata ?? {},
  }));

  // Reorder, then cut. The cut is not the reranker's to make: it may say which
  // fragments it prefers, never how many there are. A reranker that throws is a
  // bug in the reranker and not a failed search — the plain scores are always
  // an acceptable answer, and the loop that supplies this hook is an
  // improvement on retrieval, never a precondition for it.
  let ordered = mapped;

  // PRIMERO EL SEGUNDO LECTOR, LUEGO LO APRENDIDO, y en ese orden a propósito.
  // El lector juzga la pregunta contra el pasaje, que es una opinión general;
  // lo aprendido es lo que ESTA empresa corrigió a mano sobre SU material, que
  // es una opinión particular y más cara de conseguir. La particular va última
  // porque la última es la que manda.
  if (deep) {
    ordered = await rerankByMeaning(query, ordered, (h) => h.content, {
      ...(logger ? { logger } : {}),
      ...(signal ? { signal } : {}),
    });
    // Se estrecha a lo que el reordenador de aprendizaje espera ver: su
    // horquilla es de tres, no de cuarenta, y darle cuarenta convertiría un
    // ajuste fino en una segunda búsqueda.
    ordered = ordered.slice(0, rerank ? limit + RERANK_MARGIN : limit);
  }

  if (rerank) {
    const before = ordered;
    try {
      ordered = rerank(before);
    } catch {
      ordered = before;
    }
    ordered = ordered.slice(0, limit);
  }

  // Bookkeeping must never cost an answer. If the counter fails — an older
  // deployment without 0073, a lock, anything — the person still gets their
  // hits and the only thing lost is a statistic. Awaited rather than left
  // dangling so a serverless invocation cannot be frozen mid-update, which is
  // how a fire-and-forget write becomes a write that sometimes does not happen.
  //
  // Counted from `ordered`, not from the raw rows: the surplus fetched for the
  // reranker was never shown to anybody and must not make an unused fragment
  // look used.
  if (recordRetrieval) {
    const chunkIds = ordered.map((h) => h.chunkId).filter((id): id is string => Boolean(id));
    if (chunkIds.length > 0) {
      try {
        await db.rpc('kb_note_retrieval', { p_user_id: userId, p_chunk_ids: chunkIds });
      } catch {
        // Deliberately silent: the caller asked for search results, not for a
        // report on the counter, and there is no action anybody could take.
      }
    }
  }

  return ordered;
}

/**
 * Guard for anything that reaches a document directly by id rather than
 * through search — reading its chunks, listing it, moving it, deleting it.
 * Without this, a document id (which every search hit hands out) is enough to
 * pull the full text of a document out of a space you cannot see.
 */
export async function getVisibleDocument(
  db: SupabaseClient,
  userId: string,
  documentId: string,
): Promise<{ id: string; title: string; uploadedBy: string | null; space: Space }> {
  const { data, error } = await db
    .from('kb_documents')
    .select('id, title, uploaded_by, collection_id')
    .eq('id', documentId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new NotFoundError('That document is no longer in Brain Knowledge.');

  // Throws NotFoundError when the space is someone else's, which is what the
  // caller should see: the document is not theirs to know about.
  const space = await getVisibleSpace(db, userId, data.collection_id as string).catch(() => {
    throw new NotFoundError('That document is no longer in Brain Knowledge.');
  });

  return {
    id: data.id as string,
    title: data.title as string,
    uploadedBy: (data.uploaded_by as string | null) ?? null,
    space,
  };
}

/**
 * ===========================================================================
 * REPARTIR EL ACCESO
 * ===========================================================================
 * Las tres funciones que escriben en `kb_space_grants`. Todas empiezan por
 * `assertCanAdminSpace` y ninguna acepta una organización: la fila la coloca en
 * su empresa el disparador de la 0123, que la deriva del espacio. Un llamador
 * no puede conceder acceso a través de una frontera de empresa ni equivocándose
 * a propósito.
 */

/** Quién ve este espacio. Vacío si quien pregunta no lo administra. */
export async function listSpaceAccess(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
): Promise<SpaceGrant[]> {
  await assertCanAdminSpace(db, userId, spaceId);
  const { data, error } = await db.rpc('kb_space_access', {
    p_user_id: userId,
    p_space_id: spaceId,
  });
  if (error) throw error;
  type Row = {
    grant_id: string;
    subject_kind: string;
    subject_id: string | null;
    subject_name: string | null;
    level: string;
    granted_at: string;
  };
  return ((data ?? []) as Row[]).map((r) => ({
    id: r.grant_id,
    subjectKind: r.subject_kind as SpaceGrant['subjectKind'],
    subjectId: r.subject_id,
    // Un equipo borrado deja la concesión huérfana un instante, entre el borrado
    // y la cascada. Mejor una línea que dice que no sabe quién es que una fila
    // que desaparece de un panel de permisos sin explicación.
    subjectName: r.subject_name ?? 'Alguien que ya no está',
    level: r.level as SpaceLevel,
    grantedAt: r.granted_at,
  }));
}

export interface GrantSubject {
  kind: 'everyone' | 'team' | 'user';
  /** Obligatorio salvo para «toda la empresa», que no tiene id. */
  id?: string | null;
}

/**
 * Conceder, o cambiar el nivel de una concesión que ya existía.
 *
 * Se hace leyendo y luego escribiendo, en vez de con un upsert, porque la
 * unicidad de esta tabla se apoya en dos índices PARCIALES (uno para los
 * sujetos con id, otro para «toda la empresa») y un índice parcial no sirve de
 * blanco de conflicto por PostgREST. Dos viajes bien entendidos son mejores que
 * un upsert que en producción resulta que inserta duplicados.
 */
export async function grantSpaceAccess(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
  subject: GrantSubject,
  level: SpaceLevel,
): Promise<void> {
  const space = await assertCanAdminSpace(db, userId, spaceId);

  if (subject.kind !== 'everyone' && !subject.id) {
    throw new ValidationError('Falta decir a quién.');
  }
  // Las dos reglas del cuaderno personal, dichas aquí en castellano antes de
  // que el disparador las diga en forma de excepción de Postgres. La valla de
  // abajo sigue estando; ésta existe para que el mensaje sea legible.
  if (space.kind === 'personal') {
    if (subject.kind === 'everyone') {
      throw new ForbiddenError(
        'Un espacio personal no se abre a toda la empresa. Mueve el documento a un espacio común si eso es lo que quieres.',
      );
    }
    if (level === 'admin') {
      throw new ForbiddenError(
        'Puedes prestar tus notas, pero no delegar quién más las ve: eso te queda a ti.',
      );
    }
  }

  const subjectId = subject.kind === 'everyone' ? null : (subject.id ?? null);

  const existing = await db
    .from('kb_space_grants')
    .select('id')
    .eq('space_id', spaceId)
    .eq('subject_kind', subject.kind)
    .filter('subject_id', subjectId === null ? 'is' : 'eq', subjectId === null ? null : subjectId)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (existing.data) {
    const { error } = await db
      .from('kb_space_grants')
      .update({ level, granted_by: userId })
      .eq('id', (existing.data as { id: string }).id);
    if (error) throw error;
    return;
  }

  const { error } = await db.from('kb_space_grants').insert({
    space_id: spaceId,
    subject_kind: subject.kind,
    subject_id: subjectId,
    level,
    granted_by: userId,
  });
  if (error) throw error;
}

/**
 * Quitar el acceso. Se identifica por sujeto y no por el id de la fila porque
 * el que llama razona en «quítale esto a Finanzas», y hacerle buscar antes el
 * id de la concesión es darle una manera de borrar la concesión equivocada.
 */
export async function revokeSpaceAccess(
  db: SupabaseClient,
  userId: string,
  spaceId: string,
  subject: GrantSubject,
): Promise<void> {
  await assertCanAdminSpace(db, userId, spaceId);
  const subjectId = subject.kind === 'everyone' ? null : (subject.id ?? null);
  if (subject.kind !== 'everyone' && !subjectId) {
    throw new ValidationError('Falta decir a quién.');
  }
  const { error } = await db
    .from('kb_space_grants')
    .delete()
    .eq('space_id', spaceId)
    .eq('subject_kind', subject.kind)
    .filter('subject_id', subjectId === null ? 'is' : 'eq', subjectId === null ? null : subjectId);
  if (error) throw error;
}
