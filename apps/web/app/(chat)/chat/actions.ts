'use server';

import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { mustRead } from '@/lib/supabase/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  REPORTS_TABLE,
  REPORT_DOCUMENT_VERSION,
  type ReportDocument,
  listVisibleSpaces,
  loadOverrides,
  saveChartAsReport,
  saveOverrides,
  saveReport,
} from '@cortex/agent-tools';
import { revalidatePath } from 'next/cache';

/**
 * What the buttons inside the transcript do.
 *
 * Kept as server actions rather than routes because each one is a single
 * mutation with no payload worth streaming, and because the alternative — a
 * route per button — is how a surface accumulates six endpoints that all
 * `requireSession` slightly differently.
 */

export interface ChartSaveResult {
  ok: boolean;
  error?: string;
  reportId?: string;
  url?: string;
  alreadySaved?: boolean;
}

/**
 * Keep a chart drawn in the chat as an informe.
 *
 * THE WHOLE POINT IS WHAT IS ABSENT: there is no query here. The chart was
 * resolved into a `ReportDocument` when it was drawn — figures computed,
 * sources stamped with the instant they were read — and this hands those same
 * bytes to `saveReport`. So the saved informe carries the moment of the CHART,
 * not the moment of the click, and reopening it in November shows what the
 * conversation showed in August.
 *
 * That is the difference between saving and bookmarking, and `store.ts` argues
 * it at length: a report that re-runs its query is a report about today wearing
 * an older title, and nobody can tell because both look correct.
 */
export async function saveChartAsReportAction(chartId: string): Promise<ChartSaveResult> {
  try {
    const user = await requireSession();
    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id,
      agentId: user.id,
      surface: 'web',
    });

    const result = await saveChartAsReport(ctx, chartId);
    revalidatePath('/reports');
    return {
      ok: true,
      reportId: result.reportId,
      url: `/reports/${result.reportId}`,
      alreadySaved: result.alreadySaved,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return {
      ok: false,
      error: message && message.length < 240 ? message : 'No se pudo guardar el informe.',
    };
  }
}

// ===========================================================================
// CONSERVAR UNA RESPUESTA
// ===========================================================================
//
// La tercera acción de la fila que hay bajo cada respuesta, y la única que deja
// algo detrás. Copiar es del portapapeles y rehacer es del turno; ésta escribe
// una fila que se puede abrir, citar y compartir en noviembre.
//
// FOTOGRAFÍA, NO MARCADOR. Es la misma regla que `saveChartAsReportAction`
// defiende para los gráficos y que `store.ts` argumenta entero: lo que se
// guarda es lo que Cortex DIJO en ese momento, con la pregunta que lo provocó y
// la conversación como dirección. No hay consulta que repetir, y por eso no
// puede haber un botón «generar» para esto (ver la migración 0103). Un informe
// que se recalcula al abrirlo es un informe sobre hoy con el título de ayer, y
// nadie puede notarlo porque los dos se ven correctos.
//
// SIN CIFRAS SUELTAS. El documento es prosa: la respuesta va tal cual, en
// párrafos, y la única fuente es la conversación. Nada aquí inventa un `Figure`
// a partir del texto — un número marcado como figura promete un método y un
// origen comprobables, y lo que hay es una frase que los tiene arriba, en las
// llamadas a herramientas de ese turno. Por eso la fuente apunta a la
// conversación: ahí están.

export interface AnswerSaveResult {
  ok: boolean;
  error?: string;
  url?: string;
  /** Ya estaba guardada: se devuelve la misma, no una copia. */
  alreadySaved?: boolean;
}

/** Cuántos renglones de la respuesta caben en un informe. */
const MAX_LINES = 120;
const MAX_LINE = 1200;

/**
 * La respuesta partida en párrafos.
 *
 * Renglón a renglón y no por líneas en blanco, porque media respuesta de este
 * producto son listas: unir «- SOAT vence el 14» con «- Tecnomecánica vence el
 * 2» en un solo párrafo las pega en una línea ilegible al renderizar. Los `#`
 * de un encabezado se caen porque el informe tiene su propia tipografía y un
 * almohadilla suelta en medio del texto sólo se lee como basura.
 *
 * Lo que se pierde y hay que decir en voz alta: una tabla de markdown se guarda
 * como los renglones que la escriben, no como una tabla del informe. Es texto
 * fiel y formato pobre, que es el lado correcto en el que fallar cuando lo que
 * se promete es «lo que se dijo, tal cual».
 */
function answerParagraphs(answer: string): string[] {
  return answer
    .split('\n')
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_LINES)
    .map((line) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line));
}

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export async function saveAnswerAsReportAction(input: {
  conversationId?: string;
  /** El id del mensaje, que es lo que impide guardar dos veces lo mismo. */
  messageId: string;
  /** La pregunta que la provocó, si el hilo la tenía delante. */
  question?: string;
  answer: string;
}): Promise<AnswerSaveResult> {
  try {
    const user = await requireSession();
    const paragraphs = answerParagraphs(input.answer);
    if (paragraphs.length === 0) {
      return { ok: false, error: 'Esta respuesta no tiene texto que guardar.' };
    }

    const db = getOrgScopedClient(user.organization.id);

    // Pulsar dos veces no puede crear dos informes idénticos. Se busca por el
    // id del mensaje y no por el hash del documento: la fecha de guardado entra
    // en el documento, así que dos guardados del mismo texto tienen hashes
    // distintos y el trinquete no mordería nunca.
    //
    // Cubre el caso real —el doble clic y el «¿lo guardé o no?» de un minuto
    // después— y no cubre uno: la respuesta que se está escribiendo trae el id
    // que le puso el SDK, y al recargar la conversación pasa a tener el de su
    // fila. Guardarla antes y después de recargar deja dos informes. Se puede
    // vivir con eso; lo que no se puede es guardar dos veces con un clic.
    if (input.conversationId) {
      const rows = mustRead(
        await db
          .from(REPORTS_TABLE)
          .select('id')
          .eq('kind', 'answer')
          .eq('conversation_id', input.conversationId)
          .contains('params', { messageId: input.messageId })
          .limit(1),
        'los informes de esta conversación',
      ) as Array<{ id: string }>;
      const already = rows[0];
      if (already) return { ok: true, url: `/reports/${already.id}`, alreadySaved: true };
    }

    const now = new Date();
    const said = now.toLocaleDateString('es-CO', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'America/Bogota',
    });
    const question = input.question ? clip(input.question, 200) : null;
    const title = question ?? clip(paragraphs[0] ?? 'Respuesta de Cortex', 120);

    const document: ReportDocument = {
      version: REPORT_DOCUMENT_VERSION,
      kind: 'answer',
      title,
      subtitle: question ? 'Respuesta de Cortex, tal como se dijo' : null,
      periodLabel: `Conversación del ${said}`,
      generatedAt: now.toISOString(),
      timezone: 'America/Bogota',
      sources: [
        {
          id: 'conversacion',
          system: 'Cortex · conversación',
          detail: input.conversationId
            ? `La respuesta guardada de la conversación #${input.conversationId.slice(0, 8)}, con las llamadas a herramientas de ese turno todavía adjuntas.`
            : 'Una respuesta del chat, guardada antes de que la conversación tuviera dirección.',
          readAt: now.toISOString(),
          rowCount: 1,
          caveat:
            'Es lo que Cortex contestó en ese momento. No se vuelve a calcular, así que las cifras son las de ese día y no las de hoy.',
        },
      ],
      sections: [
        ...(question
          ? [{ type: 'prose' as const, heading: 'La pregunta', paragraphs: [question] }]
          : []),
        { type: 'prose' as const, heading: 'La respuesta', paragraphs },
      ],
      notes:
        paragraphs.length >= MAX_LINES
          ? ['La respuesta era más larga y se guardaron los primeros renglones.']
          : [],
    };

    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id,
      agentId: user.id,
      surface: 'web',
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    });

    const row = await saveReport(ctx, {
      kind: 'answer',
      document,
      params: { messageId: input.messageId },
      conversationId: input.conversationId ?? null,
    });
    revalidatePath('/reports');
    return { ok: true, url: `/reports/${row.id}` };
  } catch (err) {
    const message = err instanceof Error ? err.message : '';
    return {
      ok: false,
      error: message && message.length < 240 ? message : 'No se pudo guardar el informe.',
    };
  }
}

export interface SpaceChoice {
  id: string;
  name: string;
  kind: 'global' | 'personal';
  /** False when this person may read the space but not write to it. */
  writable: boolean;
}

/**
 * The spaces offered when somebody chooses to remember a file.
 *
 * Company-wide spaces are LISTED for everyone and only WRITABLE by org admins,
 * rather than hidden from everybody else. Hiding them would make the product
 * look like it has no shared memory; showing them disabled says the true thing
 * — this exists, and putting something in it is not your call — which is the
 * answer somebody needs in order to go and ask.
 *
 * `assertCanWriteToSpace` on the upload route is what actually enforces it.
 * This list is a convenience and is never the check.
 */
export async function listWritableSpacesAction(): Promise<SpaceChoice[]> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const [spaces, { data: me }] = await Promise.all([
      listVisibleSpaces(db, user.id),
      db.from('users').select('role').eq('id', user.id).maybeSingle(),
    ]);
    const isAdmin = (me?.role as string | undefined) === 'org_admin';

    return spaces.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      writable: s.kind === 'personal' ? s.ownerId === user.id : isAdmin,
    }));
  } catch {
    return [];
  }
}

// ===========================================================================
// CHOOSING WHICH MEMORY ANSWERS
// ===========================================================================
//
// WHY THIS IS NOT `listWritableSpacesAction`. That list answers "where may I
// PUT this file", and it is right that a company-wide space appears in it
// greyed out. This one answers "where should Cortex LOOK", and reading is the
// other half of the rule: every space a person can retrieve from is a space
// they may narrow to, admin or not. Two questions, two lists — merging them
// would mean either offering a space nobody may write to as a destination, or
// hiding a readable space from the filter because the person is not an admin.
//
// WHERE THE CHOICE IS STORED. In `turn_context_settings.space_ids`, the column
// migration 0080 already created for exactly this, reached through
// `loadOverrides` / `saveOverrides`. Nothing new was added: the composer's
// filter and the "espacios" knob in the diagnostics panel at
// /conversations/[id] are the SAME value, so the two surfaces can never
// disagree about what a conversation is searching. The header of
// packages/agent-tools/src/turn-context/settings.ts argues the scope
// (conversation, not workspace, not forever) and that argument is unchanged.

export interface ScopeSpace {
  id: string;
  name: string;
  kind: 'global' | 'personal';
}

/** Every space this person may retrieve from — the only things they may filter to. */
export async function listScopeSpacesAction(): Promise<ScopeSpace[]> {
  try {
    const user = await requireSession();
    const db = getOrgScopedClient(user.organization.id);
    const spaces = await listVisibleSpaces(db, user.id);
    return spaces.map((s) => ({ id: s.id, name: s.name, kind: s.kind }));
  } catch {
    // An empty list closes the picker with "no hay espacios todavía", which is
    // a truthful thing to show and never blocks the composer.
    return [];
  }
}

/**
 * Narrow (or un-narrow) one conversation's retrieval.
 *
 * OWNERSHIP, NOT MEMBERSHIP. Only the person whose conversation it is may
 * change it, and a conversation that is not theirs answers "no longer exists"
 * rather than "forbidden" — the same rule and the same wording as
 * `saveTurnContextAdjustments`, so a wrong id and somebody else's id stay
 * indistinguishable.
 *
 * IT READS BEFORE IT WRITES. `saveOverrides` upserts the whole row, so writing
 * the scope without loading the rest would silently reset the fragment limit
 * and the muted tool families somebody set while debugging this same
 * conversation. Only `space_ids` changes here.
 *
 * IT CANNOT WIDEN. Every id is checked against `listVisibleSpaces` and anything
 * else is dropped before it is stored, so a forged id cannot be parked in the
 * column; and even if one were, `kb_search_scoped` intersects with what the
 * person can see. This check exists so a stale id fails at the moment somebody
 * picks it instead of quietly narrowing retrieval to nothing three turns later.
 */
export async function setChatScopeAction(
  conversationId: string,
  spaceIds: string[],
): Promise<{ ok: true } | { ok: false; error: string }> {
  let user: Awaited<ReturnType<typeof requireSession>>;
  try {
    user = await requireSession();
  } catch {
    return { ok: false, error: 'Vuelve a entrar para cambiar el filtro.' };
  }

  const db = getOrgScopedClient(user.organization.id);

  const { data: conv } = await db
    .from('conversations')
    .select('id, user_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || (conv.user_id as string) !== user.id) {
    return { ok: false, error: 'Esa conversación ya no existe.' };
  }

  let allowed: string[] = [];
  if (spaceIds.length > 0) {
    const visible = await listVisibleSpaces(db, user.id);
    const visibleIds = new Set(visible.map((s) => s.id));
    allowed = spaceIds.filter((id) => visibleIds.has(id));
    if (allowed.length === 0) {
      return { ok: false, error: 'Los espacios que elegiste ya no existen.' };
    }
  }

  try {
    const current = await loadOverrides(db, conversationId);
    await saveOverrides(db, {
      conversationId,
      userId: user.id,
      overrides: {
        fragmentLimit: current.fragmentLimit,
        // An empty selection is stored as null — "todo lo que ves" — and never
        // as `[]`, which `kbSpaceIds` reads as "ningún espacio" and would
        // switch the brain off for the conversation. See settings.ts.
        spaceIds: allowed.length > 0 ? allowed : null,
        mutedFamilies: current.mutedFamilies,
      },
    });
  } catch {
    return { ok: false, error: 'No se pudo guardar el filtro. Inténtalo otra vez.' };
  }

  return { ok: true };
}
