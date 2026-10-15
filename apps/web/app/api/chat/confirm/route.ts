import { REVERSIBLE_TOOLS, undoPlanFor } from '@/lib/activity/undo';
import { buildToolContext } from '@/lib/agent';
import { confirmationResults, pendingConfirmationIndex } from '@/lib/confirmation-claim';
import { pendingTwinIndexes } from '@/lib/confirmation-dedupe';
import { sameShape } from '@/lib/confirmation-edit';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { getTool, runTool, toolIdAllowed } from '@cortex/agent-tools';
import { logger } from '@cortex/core';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
const Body = z.object({
  conversationId: z.string().uuid(),
  toolId: z.string(),
  input: z.unknown(),
  toolCallId: z.string().optional(),
  /**
   * La entrada CORREGIDA por la persona en la tarjeta. `input` sigue siendo la
   * propuesta original (es lo que identifica la tarjeta pendiente); lo que se
   * ejecuta es esto, si pasa dos controles: misma forma que la propuesta y el
   * esquema de la herramienta.
   */
  editedInput: z.unknown().optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  const { conversationId, toolId, input, toolCallId, editedInput } = parsed.data;
  const db = getOrgScopedClient(user.organization.id);
  const { data: conv, error: convError } = await db
    .from('conversations')
    .select('agent_id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .single();
  if (convError || !conv)
    return NextResponse.json({ error: 'Conversación no disponible.' }, { status: 404 });
  const toolDef = getTool(toolId);
  if (!toolDef) return NextResponse.json({ error: 'Herramienta no disponible.' }, { status: 404 });
  let execInput: unknown = input;
  if (editedInput !== undefined) {
    if (!sameShape(input, editedInput))
      return NextResponse.json(
        {
          error: 'Esa edición cambia la estructura de la acción. Pídele a Cortex que la reformule.',
        },
        { status: 400 },
      );
    const schema = (toolDef as { inputSchema?: { safeParse: (v: unknown) => unknown } })
      .inputSchema;
    const check = schema?.safeParse(editedInput) as
      | { success: true; data: unknown }
      | {
          success: false;
          error: { issues: Array<{ path: Array<string | number>; message: string }> };
        }
      | undefined;
    if (!check)
      return NextResponse.json({ error: 'Esta acción no se puede editar.' }, { status: 400 });
    if (!check.success) {
      const first = check.error.issues[0];
      return NextResponse.json(
        {
          error: `El valor editado no es válido${first ? `: ${first.path.join('.')} — ${first.message}` : '.'}`,
        },
        { status: 400 },
      );
    }
    execInput = editedInput;
  }
  const { data: agent, error: agentError } = await db
    .from('agents')
    .select('allowed_tool_ids')
    .eq('id', conv.agent_id)
    .single();
  if (
    agentError ||
    !agent ||
    !toolIdAllowed(agent.allowed_tool_ids as string[], toolId) ||
    isToolDenied(toolId, await deniedToolPatterns(db, user.id, { failClosed: true }))
  )
    return NextResponse.json({ error: 'Esta acción ya no está autorizada.' }, { status: 403 });
  const { data: rows, error: readError } = await db
    .from('messages')
    .select('id,tool_results,parts')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(20);
  if (readError)
    return NextResponse.json({ error: 'No se pudo verificar la aprobación.' }, { status: 503 });
  const candidates = (rows ?? [])
    .map((row) => ({
      row,
      index: pendingConfirmationIndex(
        confirmationResults(row.tool_results, row.parts),
        toolId,
        input,
        toolCallId,
      ),
    }))
    .filter(({ index }) => index >= 0);
  const candidate = candidates[0];
  if (candidates.length !== 1 || !candidate)
    return NextResponse.json(
      {
        error:
          'No hay una propuesta pendiente que coincida. Espera a que Cortex termine o actualiza la conversación.',
      },
      { status: 409 },
    );
  const { row, index } = candidate;
  const original = confirmationResults(row.tool_results, row.parts);
  const claimed = original.map((entry, i) =>
    i === index
      ? {
          ...entry,
          result: {
            __confirmation_in_progress: true,
            toolId,
            message: 'Ejecución solicitada. Verifica el resultado antes de volver a intentarlo.',
          },
        }
      : entry,
  );
  // Compare-and-swap prevents two tabs, retries or double clicks executing twice.
  //
  // Antes se comparaba `tool_results` ENTERO dentro de la URL de PostgREST. Con
  // resultados grandes en el mismo mensaje (una lista de tablas, filas de
  // Siigo) la URL pasaba del límite, la consulta fallaba y la persona veía
  // «Esta propuesta ya cambió» en una propuesta intacta. Ahora se compara sólo
  // la entrada que se aprueba, por su ruta en el JSON: sigue pendiente y es la
  // misma llamada. Una entrada recuperada de `parts` (no guardada aún en
  // tool_results) se reclama exigiendo que su toolCallId todavía no esté.
  const entryId = (original[index] as { toolCallId?: unknown } | undefined)?.toolCallId;
  const saved = Array.isArray(row.tool_results)
    ? (row.tool_results as Array<{ toolCallId?: unknown }>)
    : null;
  const savedIndex =
    saved && typeof entryId === 'string' ? saved.findIndex((e) => e?.toolCallId === entryId) : -1;
  let claimQuery = db
    .from('messages')
    .update({ tool_results: claimed })
    .eq('id', row.id)
    .eq('conversation_id', conversationId);
  if (row.tool_results === null) claimQuery = claimQuery.is('tool_results', null);
  else if (savedIndex >= 0)
    claimQuery = claimQuery
      .eq(`tool_results->${savedIndex}->>toolCallId`, entryId as string)
      .eq(`tool_results->${savedIndex}->result->>__requires_confirmation`, 'true');
  else if (typeof entryId === 'string')
    claimQuery = claimQuery.not('tool_results', 'cs', JSON.stringify([{ toolCallId: entryId }]));
  else claimQuery = claimQuery.eq('tool_results', JSON.stringify(row.tool_results));
  const { data: claim, error: claimError } = await claimQuery.select('id').maybeSingle();
  if (claimError)
    logger.warn({ err: claimError, conversationId }, 'chat confirm: claim query failed');
  if (claimError || !claim)
    return NextResponse.json(
      { error: 'Esta propuesta ya cambió o está en ejecución. Actualiza la conversación.' },
      { status: 409 },
    );
  // Las copias idénticas que sigan pendientes en este mensaje: aprobar una no
  // deja a su gemela esperando.
  const twins = pendingTwinIndexes(original, index);
  let output: unknown;
  let failed = false;
  try {
    const fresh = await requireSession();
    if (fresh.organization.id !== user.organization.id || fresh.id !== user.id)
      throw new Error('El acceso al espacio cambió.');
    const ctx = buildToolContext({
      organizationId: user.organization.id,
      userId: user.id,
      agentId: conv.agent_id as string,
      conversationId,
    });
    output = await runTool(toolDef, execInput, ctx, { confirmed: true });
  } catch (error) {
    failed = true;
    output = {
      __error: true,
      tool: toolId,
      message:
        error instanceof Error
          ? error.message
          : 'No se pudo confirmar el resultado. Revisa la evidencia antes de reintentar.',
    };
  }
  // Merge with other confirmations on this message; never overwrite their result.
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data: latest } = await db
      .from('messages')
      .select('tool_results')
      .eq('id', row.id)
      .single();
    if (!latest || !Array.isArray(latest.tool_results)) break;
    const next = latest.tool_results.map((entry: Record<string, unknown>, i: number) =>
      i === index
        ? { ...entry, result: output, ...(editedInput !== undefined ? { editedInput } : {}) }
        : twins.includes(i)
          ? {
              ...entry,
              result: {
                __superseded: true,
                toolId,
                message: 'Era una copia de una propuesta que ya se aprobó.',
              },
            }
          : entry,
    );
    const { data: saved } = await db
      .from('messages')
      .update({ tool_results: next })
      .eq('id', row.id)
      .eq('tool_results', JSON.stringify(latest.tool_results))
      .select('id')
      .maybeSingle();
    if (saved) break;
  }
  if (failed)
    return NextResponse.json({ error: (output as { message: string }).message }, { status: 500 });
  return NextResponse.json({
    result: output,
    ...(editedInput !== undefined ? { edited: true } : {}),
    ...(await undoableEventId(db, { toolId, userId: user.id, conversationId })),
  });
}

/**
 * El id de la fila de auditoría de lo que se acaba de ejecutar, SOLO si tiene
 * inversa (lib/activity/undo.ts): es lo que enciende «Deshacer» en la tarjeta.
 * Un fallo aquí nunca estorba la aprobación.
 */
async function undoableEventId(
  db: ReturnType<typeof getOrgScopedClient>,
  args: { toolId: string; userId: string; conversationId: string },
): Promise<{ undoEventId?: string }> {
  if (!(REVERSIBLE_TOOLS as readonly string[]).includes(args.toolId)) return {};
  try {
    const { data } = await db
      .from('audit_events')
      .select('id,tool_id,status,metadata')
      .eq('tool_id', args.toolId)
      .eq('user_id', args.userId)
      .eq('conversation_id', args.conversationId)
      .eq('status', 'ok')
      .order('created_at', { ascending: false })
      .limit(1);
    const row = Array.isArray(data) ? data[0] : null;
    if (row && undoPlanFor(row)) return { undoEventId: row.id as string };
  } catch {
    /* sin Deshacer; la aprobación ya salió */
  }
  return {};
}
