import type { IntegrationProvider, Logger, UUID } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import type { SafeActionPolicy } from './safe-actions/types.js';
import type { DeclaredAmount } from './security/mandate.js';

export interface IntegrationsClient {
  getAccessToken(provider: IntegrationProvider): Promise<{ token: string; scopes: string[] }>;
  hasScopes(provider: IntegrationProvider, scopes: string[]): Promise<boolean>;
}

/**
 * Where the tool call came from. Drives the security layer's `unattended`
 * signal: a 'schedule' call has no human in the loop, so nothing can be
 * confirmed interactively. Defaults to 'web' when absent.
 */
export type ToolSurface = 'web' | 'mcp' | 'schedule';

export interface ToolContext {
  /** Trusted scheduler context; never accepted as tool arguments. */
  routineId?: string;
  scopedMandatesOnly?: boolean;
  /**
   * The workspace this call acts in. Required, and never derived inside a tool:
   * an interactive turn takes it from the session, an unattended one takes it
   * from the row of the job it is running. `db` is already pinned to it (see
   * packages/agent-tools/src/tenancy/scoped-client.ts) so a tool never has to
   * filter by it by hand; it is on the context for the few places that must
   * STAMP it — audit rows, security events, and anything that hands work to
   * another surface.
   */
  organizationId: string;
  userId: UUID;
  agentId: UUID;
  conversationId?: UUID;
  surface?: ToolSurface;
  /**
   * Workspace-scoped. Reads are filtered and writes are stamped with
   * `organization_id` automatically; a raw service-role client must never be
   * put here.
   */
  db: SupabaseClient;
  integrations: IntegrationsClient;
  logger: Logger;
  /**
   * A CEILING on Brain Knowledge retrieval for this turn, when the surface has
   * one. Undefined — the normal case — means "whatever this person can see",
   * decided in Postgres from `userId` as it always has been.
   *
   * It can only ever NARROW: retrieval intersects it with the visible set, so a
   * space id in here that the caller cannot see contributes nothing. An EMPTY
   * ARRAY means "no space at all" and must never be read as "no restriction" —
   * that distinction is the whole point of the field.
   *
   * It exists for one situation: answering out loud in a room that contains
   * people who do not work here (a WhatsApp group — migration 0072). There, the
   * asker's own private notes are exactly what must not be quotable, and a rule
   * enforced at each call site would be a rule that eventually is not.
   */
  kbSpaceIds?: string[];
  /**
   * Told what a Brain Knowledge retrieval really returned, at the moment it
   * returned it — losers included.
   *
   * WHY THIS EXISTS AT ALL. `kb.search` drops everything below the relevance
   * floor before it returns, which is correct: a model handed a list of
   * near-misses reads it as evidence. But those near-misses are usually the
   * answer to "why did it reply that", and once the call is over they are gone
   * — the only way to get them back would be to run the search again, and a
   * second search is a DIFFERENT search. Thresholds get recalibrated, documents
   * get re-indexed, the embedding model changes. A screen that re-derived what
   * "would have" been retrieved would agree with the truth on every turn except
   * the ones somebody opened it for.
   *
   * So the capture is handed the real result set from inside the call that
   * produced it. Synchronous, and it must stay synchronous: it is a couple of
   * object literals, it runs while the turn is already waiting on nothing, and
   * an implementation that did I/O here would put diagnostics on the critical
   * path of an answer. Errors thrown by an observer are swallowed by the caller.
   */
  onRetrieval?: (observation: RetrievalObservation) => void;
  /**
   * Poner trabajo en la cola, sin saber cuál es la cola.
   *
   * ===========================================================================
   * POR QUÉ ESTO ES UNA FUNCIÓN EN EL CONTEXTO Y NO UN IMPORT
   * ===========================================================================
   * La cola vive en `apps/web/lib/jobs.ts` — decide entre el worker de pg-boss y
   * el camino viejo, lee dos variables de entorno y firma la petición. Este
   * paquete NO puede importar de la aplicación (lo consumen también el runtime
   * MCP y los tests en Node, y el ciclo ni siquiera compilaría), y copiar aquí
   * ese despacho crearía una SEGUNDA forma de encolar que se desviaría de la
   * primera el día que la infraestructura cambie — que es el día en que nadie
   * está mirando esta copia.
   *
   * Es OPCIONAL, y quien la use tiene que tener un plan para cuando no esté: un
   * contexto sin cola es un contexto que no puede prometer trabajo diferido, y
   * la respuesta correcta ahí es hacer menos y decirlo, nunca prometer algo que
   * no va a pasar. Devuelve `false` cuando no se pudo encolar — `enqueueJob` no
   * lanza a propósito, porque quien encola casi siempre está terminando un turno
   * de chat.
   */
  enqueueJob?: (name: string, data: Record<string, unknown>) => Promise<boolean>;
  /**
   * Leer los bytes de un archivo guardado en Cortex (el valor de un campo
   * `file`: `{url,name,mime,size}`), sin saber dónde ni cómo se guarda. La url
   * lleva una firma; la aplicación la verifica y exige que sea de ESTA empresa.
   * Opcional: un contexto sin almacenamiento (MCP, tests) no la trae y la
   * herramienta que la necesita lo dice. Devuelve null si ya no existe.
   */
  readStoredFile?: (url: string) => Promise<{ bytes: Buffer; mime: string | null } | null>;
  /**
   * Invitar a una persona a ESTA empresa, sin saber cómo se invita.
   *
   * Invitar es de better-auth y del tope de asientos del plan, y ambos viven en
   * la aplicación (`apps/web/lib/team/invite-flow.ts`); este paquete no puede
   * importarlos, y una segunda implementación aquí se desviaría de la de la
   * pantalla «Personas». Es la misma razón de `enqueueJob`. `buildToolContext`
   * la ata.
   *
   * OPCIONAL, y sólo existe donde hay una persona con sesión detrás (el chat
   * web): better-auth firma la invitación con la sesión de quien invita. Una
   * rutina, el runtime MCP o un test no la traen, y `team.invite` lo dice en vez
   * de fingir. Nunca lanza por «no se pudo»: devuelve el estado y la frase.
   */
  inviteTeamMember?: (input: {
    email: string;
    role: 'member' | 'admin';
    message?: string | null;
    position?: string | null;
    teamId?: string | null;
  }) => Promise<{
    status: 'sent' | 'already_member' | 'already_invited' | 'no_seats' | 'invalid' | 'failed';
    message: string;
  }>;
  /**
   * Mandar el correo de invitación (con el enlace /a/<app>) a usuarios externos
   * de una aplicación (0209), sin saber cómo se manda un correo. Mandar correos
   * es de la aplicación web (`lib/apps/invitations.ts`: Resend, plantillas); este
   * paquete no puede importarla, igual que `inviteTeamMember`. OPCIONAL: sin ella
   * `apps.invite_users` deja a las personas en la lista y lo dice.
   */
  sendAppInvitations?: (input: {
    appId: string;
    userIds: string[];
  }) => Promise<{ sent: number; failed: Array<{ email: string; reason: string }> }>;
  /**
   * El alcance de idempotencia de esta ejecución, cuando lo hay (migración
   * 0168). Lo pone quien sabe que una ejecución es UNA: una rutina programada
   * usa `routine:<id>:<hora programada>`, de modo que el reintento de ese paso
   * cae en la misma clave y no repite el envío, mientras que la ejecución de
   * mañana es otra. Sin él (un chat), la clave es sólo quién, qué y con qué
   * datos. Ver packages/agent-tools/src/safe-actions.
   */
  idempotencyScope?: string;
  /**
   * Una línea de avance de una herramienta que tarda («Listé 1.200 archivos en
   * 40 carpetas…»). Genérica: ninguna herramienta sabe adónde va. OPCIONAL —
   * quien pueda mostrarla (el chip de la herramienta en el chat) la ata; sin
   * ella la herramienta trabaja igual y calla. Síncrona, barata y que nunca
   * lance: un fallo al avisar no puede tumbar el trabajo.
   */
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  withSpan?: <T>(
    name: string,
    attrs: Record<string, string | number>,
    fn: () => Promise<T>,
  ) => Promise<T>;
}

/**
 * One retrieval, as it really came back.
 *
 * Declared here rather than in `turn-context/` so that `ToolContext` stays a
 * leaf type with no dependency on the capture module — the retrieval side
 * should not have to know that anything is watching.
 */
export interface RetrievalObservation {
  query: string;
  /** How many fragments the caller asked for. */
  limit: number;
  coverage: 'answered' | 'thin' | 'nothing' | 'keyword-only';
  /** The exact sentence handed to the model about its own results. */
  summary: string;
  /** The cuts that judged these scores, and the scale they are on. */
  cuts: {
    modelId: string;
    strongMatch: number;
    weakFloor: number;
    railCeiling: number;
    measured: boolean;
  };
  /** Every row the search returned, in rank order, before the floor was applied. */
  hits: RetrievalObservationHit[];
}

export interface RetrievalObservationHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  spaceId: string;
  spaceName: string;
  spaceKind: 'global' | 'shared' | 'personal';
  chunkIndex: number;
  content: string;
  /** Raw cosine. Null when the semantic arm did not run for this row. */
  cosine: number | null;
  keyword: number;
  blended: number;
  /** How the cuts above rated it. 'dropped' is below the floor. */
  verdict: 'strong' | 'weak' | 'dropped';
}

export interface ToolDef<I, O> {
  id: string;
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  requiresConfirmation?: boolean;
  /**
   * Ventana (ms) durante la cual una confirmación humana de ESTA herramienta,
   * en ESTA conversación, vale también para las llamadas siguientes — la
   * «memoria corta del sí» (security/conversation-grace.ts lleva el argumento
   * completo y sus límites: no toca la puerta de seguridad, no cruza hilos ni
   * usuarios, y en la duda vuelve la tarjeta). Solo tiene sentido junto a
   * `requiresConfirmation: true`.
   */
  conversationGrace?: number;
  /**
   * Dónde están el importe y su moneda dentro de `inputSchema`, cuando esta
   * herramienta mueve dinero (migración 0099).
   *
   * Es lo único que hace que un techo monetario de un mandato («puedes aprobar
   * hasta $500.000») pueda aplicarse a esta herramienta. Sin esta declaración un
   * mandato CON techo no la delega nunca y la llamada se para a preguntar, que
   * es la dirección segura: la alternativa sería buscar la cifra en el cuerpo
   * del texto, y equivocarse ahí autoriza.
   *
   * Ambas claves son de primer nivel en el esquema de entrada, `amountKey` tiene
   * que llegar como `number` (nunca como cadena con separadores) y `currencyKey`
   * como código ISO de tres letras. Si algo de eso no se cumple en la llamada
   * concreta, no hay delegación.
   */
  declaredAmount?: DeclaredAmount;
  requiredScopes?: { provider: IntegrationProvider; scopes: string[] }[];
  rateLimit?: { perMinute: number };
  /**
   * Acción segura de repetir (migración 0168): la misma llamada, ya hecha
   * dentro de la ventana, se devuelve en vez de repetirse; dos a la vez, sólo
   * una corre; y `verify` comprueba después que el efecto ocurrió. Si no se
   * declara aquí, `registerTool` la toma de `safe-actions/catalog.ts`.
   */
  safeAction?: SafeActionPolicy<I, O>;
  /**
   * Lo que el rastro de actividad necesita saber ANTES de que la herramienta
   * cambie algo, para poder deshacerlo después (`audit-detail.ts`). Sólo se
   * llama en herramientas con efectos; si lanza o devuelve `null`, la fila se
   * escribe igual y esa acción simplemente no se podrá deshacer.
   */
  audit?: {
    before?: (input: I, ctx: ToolContext) => Promise<Record<string, unknown> | null>;
  };
  handler: (input: I, ctx: ToolContext) => Promise<O>;
}

export type AnyTool = ToolDef<unknown, unknown>;
