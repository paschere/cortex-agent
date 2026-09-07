import { buildToolContext } from '@/lib/agent';
import { confirmationResults, pendingConfirmationIndex } from '@/lib/confirmation-claim';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns, isToolDenied } from '@/lib/tool-access';
import { getTool, runTool, toolIdAllowed } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
const Body = z.object({
  conversationId: z.string().uuid(),
  toolId: z.string(),
  input: z.unknown(),
  toolCallId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  const { conversationId, toolId, input, toolCallId } = parsed.data;
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
  const claimQuery = db
    .from('messages')
    .update({ tool_results: claimed })
    .eq('id', row.id)
    .eq('conversation_id', conversationId);
  const { data: claim, error: claimError } = await (row.tool_results === null
    ? claimQuery.is('tool_results', null)
    : claimQuery.eq('tool_results', JSON.stringify(row.tool_results))
  )
    .select('id')
    .maybeSingle();
  if (claimError || !claim)
    return NextResponse.json(
      { error: 'Esta propuesta ya cambió o está en ejecución. Actualiza la conversación.' },
      { status: 409 },
    );
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
    output = await runTool(toolDef, input, ctx, { confirmed: true });
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
      i === index ? { ...entry, result: output } : entry,
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
  return failed
    ? NextResponse.json({ error: (output as { message: string }).message }, { status: 500 })
    : NextResponse.json({ result: output });
}
