import { taskViewerFor } from '@/lib/background-tasks/viewer';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { templateFromRow, validateTemplateInput } from '@/lib/task-templates/shape';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

const MAX_COMPANY_TEMPLATES = 40;

/** Las plantillas de la empresa (las de siempre viven en el código). */
export async function GET() {
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data } = await db
    .from('task_templates')
    .select('id, title, summary, prompt, needs, minutes')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(MAX_COMPANY_TEMPLATES);
  const templates = ((data ?? []) as Record<string, unknown>[])
    .map(templateFromRow)
    .filter((x) => x !== null);
  return NextResponse.json({ templates });
}

/** Agregar una plantilla de la empresa: sólo quien administra. */
export async function POST(req: Request) {
  const user = await requireSession();
  const viewer = await taskViewerFor(user);
  if (!viewer.isManager) {
    return NextResponse.json(
      { error: 'Sólo quien administra la empresa puede agregar plantillas.' },
      { status: 403 },
    );
  }
  const parsed = validateTemplateInput(await req.json().catch(() => null));
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const db = getOrgScopedClient(user.organization.id);
  const { count } = await db
    .from('task_templates')
    .select('id', { count: 'exact', head: true })
    .is('archived_at', null);
  if ((count ?? 0) >= MAX_COMPANY_TEMPLATES) {
    return NextResponse.json(
      { error: 'Ya hay demasiadas plantillas; archiva alguna.' },
      { status: 429 },
    );
  }
  const { data, error } = await db
    .from('task_templates')
    .insert({ created_by: user.id, ...parsed.value })
    .select('id, title, summary, prompt, needs, minutes')
    .single();
  if (error || !data) return NextResponse.json({ error: 'No se pudo guardar.' }, { status: 500 });
  await db
    .from('audit_events')
    .insert({
      user_id: user.id,
      tool_id: 'task.template_add',
      input_hash: (data as { id: string }).id,
      status: 'ok',
      latency_ms: 0,
      metadata: { title: parsed.value.title },
    })
    .then(undefined, () => undefined);
  return NextResponse.json({ template: templateFromRow(data as Record<string, unknown>) });
}
