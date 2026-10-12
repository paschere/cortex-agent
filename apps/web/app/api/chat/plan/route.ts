import { planScope } from '@/lib/plan-grant-server';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { createPlanGrant, findActivePlanGrant, revokePlanGrant } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * «APROBAR EL PLAN»: una aprobación para varios pasos.
 *
 *   GET  ?conversationId  → qué cubriría la aprobación y si ya hay una vigente.
 *   POST approve          → crea la concesión (security/plan-grant.ts).
 *   POST revoke           → «Detener el plan».
 *
 * El alcance sale SIEMPRE del plan guardado en la conversación y de lo que el
 * agente y la persona pueden usar (lib/plan-grant-server.ts); el cuerpo de la
 * petición sólo dice a qué conversación y qué hacer.
 */

const Body = z.object({
  conversationId: z.string().uuid(),
  action: z.enum(['approve', 'revoke']),
});

async function context(conversationId: string) {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data: conv } = await db
    .from('conversations')
    .select('agent_id')
    .eq('id', conversationId)
    .eq('user_id', user.id)
    .single();
  if (!conv) return null;
  const { data: agent } = await db
    .from('agents')
    .select('allowed_tool_ids')
    .eq('id', conv.agent_id)
    .single();
  if (!agent) return null;
  return {
    user,
    db,
    agentId: conv.agent_id as string,
    agentToolIds: (agent.allowed_tool_ids ?? []) as string[],
  };
}

const grantView = (
  g: { id: string; tools: string[]; expiresAt: string; maxCalls: number } | null,
) => (g ? { id: g.id, tools: g.tools, expiresAt: g.expiresAt, maxCalls: g.maxCalls } : null);

export async function GET(req: NextRequest) {
  const conversationId = z
    .string()
    .uuid()
    .safeParse(req.nextUrl.searchParams.get('conversationId'));
  if (!conversationId.success)
    return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  const c = await context(conversationId.data);
  if (!c) return NextResponse.json({ error: 'Conversación no disponible.' }, { status: 404 });
  const [scope, grant] = await Promise.all([
    planScope(c.db, {
      conversationId: conversationId.data,
      userId: c.user.id,
      agentToolIds: c.agentToolIds,
    }),
    findActivePlanGrant(c.db, { conversationId: conversationId.data, userId: c.user.id }),
  ]);
  return NextResponse.json({
    scope: scope ? { grantable: scope.grantable, alwaysAsk: scope.alwaysAsk } : null,
    planTitle: scope?.plan.title ?? null,
    grant: grantView(grant),
  });
}

export async function POST(req: NextRequest) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  const { conversationId, action } = parsed.data;
  const c = await context(conversationId);
  if (!c) return NextResponse.json({ error: 'Conversación no disponible.' }, { status: 404 });

  if (action === 'revoke') {
    const ok = await revokePlanGrant(c.db, {
      conversationId,
      userId: c.user.id,
      agentId: c.agentId,
    });
    return ok
      ? NextResponse.json({ grant: null })
      : NextResponse.json({ error: 'No se pudo detener el plan.' }, { status: 503 });
  }

  const scope = await planScope(c.db, {
    conversationId,
    userId: c.user.id,
    agentToolIds: c.agentToolIds,
  });
  if (!scope)
    return NextResponse.json(
      { error: 'Todavía no hay un plan guardado. Espera a que Cortex termine de escribirlo.' },
      { status: 409 },
    );
  if (scope.grantable.length === 0)
    return NextResponse.json(
      { error: 'Ninguno de los pasos se puede aprobar de una vez; cada uno pedirá su tarjeta.' },
      { status: 409 },
    );
  const grant = await createPlanGrant(c.db, {
    conversationId,
    userId: c.user.id,
    agentId: c.agentId,
    tools: scope.grantable,
    planCallId: scope.plan.lastCallId,
  });
  if (!grant)
    return NextResponse.json({ error: 'No se pudo registrar la aprobación.' }, { status: 503 });
  return NextResponse.json({
    grant: grantView(grant),
    scope: { grantable: scope.grantable, alwaysAsk: scope.alwaysAsk },
    title: scope.plan.title,
  });
}
