import {
  automationInput,
  automationSummary,
  automationTransitionSourceStatuses,
  recurringDefinitionError,
} from '@/lib/activations/automations';
import { activationDefinitionSchema, isSameOrigin } from '@/lib/activations/request';
import {
  ActivationError,
  readOwnedTableSources,
  sourceSnapshot,
  textSourceSnapshot,
} from '@/lib/activations/service';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';

export async function GET() {
  const user = await requireSession();
  const { data, error } = await getOrgScopedClient(user.organization.id)
    .from('activation_automations')
    .select('*')
    .eq('actor_id', user.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error)
    return NextResponse.json({ error: 'No se pudo cargar el seguimiento.' }, { status: 503 });
  return NextResponse.json({ automations: (data ?? []).map(automationSummary) });
}
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return NextResponse.json({ error: 'Origen inválido.' }, { status: 403 });
  const user = await requireSession();
  const input = automationInput.safeParse(await req.json().catch(() => null));
  if (!input.success)
    return NextResponse.json({ error: 'Revisa la frecuencia y la autorización.' }, { status: 400 });
  const db = getOrgScopedClient(user.organization.id);
  try {
    const body = input.data;
    if (body.action !== 'create') {
      const { data, error } = await db
        .from('activation_automations')
        .update({
          status: body.action === 'pause' ? 'paused' : 'active',
          lease_token: null,
          lease_until: null,
          next_run_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', body.id)
        .eq('actor_id', user.id)
        .in('status', automationTransitionSourceStatuses(body.action))
        .select('*')
        .maybeSingle();
      if (error || !data)
        throw new ActivationError(
          'No se pudo cambiar el seguimiento. Si necesita revisión, simula y autoriza una regla nueva.',
          409,
        );
      return NextResponse.json({ automation: automationSummary(data) });
    }
    const { data: run, error } = await db
      .from('activation_runs')
      .select('*')
      .eq('id', body.runId)
      .eq('actor_id', user.id)
      .maybeSingle();
    if (error || !run) throw new ActivationError('La simulación no está disponible.', 404);
    const definition = activationDefinitionSchema.parse(run.definition);
    const problem = recurringDefinitionError(definition);
    if (problem) throw new ActivationError(problem, 422);
    const source = (await readOwnedTableSources(db, user.id)).find((s) => s.id === run.source_id);
    if (!source)
      throw new ActivationError('La fuente venció. Añade una versión y vuelve a simular.', 409);
    if (source.feed_truncated)
      throw new ActivationError(
        'La captura está incompleta. Reduce el origen o sus filas antes de activar el seguimiento.',
        409,
      );
    const { data: connection, error: connectionError } = await db
      .from('feed_sources')
      .select('id,kind')
      .eq('actor_id', user.id)
      .eq('latest_attachment_id', source.id)
      .eq('enabled', true)
      .maybeSingle();
    if (connectionError || !connection)
      throw new ActivationError(
        'Vuelve a añadir la fuente desde Feed para guardar su conexión y luego simula otra vez.',
        409,
      );
    let headers = source.feed_tables?.[run.sheet_index]?.rows[0]?.map((v) =>
      String(v ?? '').trim(),
    );
    let prompt: string | null = null;
    if (run.prepared_view_id) {
      const view = await db
        .from('feed_prepared_views')
        .select('table_data,prompt,source_snapshot')
        .eq('id', run.prepared_view_id)
        .eq('actor_id', user.id)
        .eq('source_id', source.id)
        .maybeSingle();
      if (view.error || !view.data || view.data.source_snapshot !== textSourceSnapshot(source))
        throw new ActivationError('La lectura preparada cambió. Prepárala otra vez.', 409);
      headers = view.data.table_data.rows[0].map((v: unknown) => String(v ?? '').trim());
      prompt = view.data.prompt;
    }
    if (
      !headers ||
      run.source_snapshot !== (prompt ? textSourceSnapshot(source) : sourceSnapshot(source))
    )
      throw new ActivationError('La fuente cambió desde la simulación.', 409);
    if (run.candidates.some((c: { status: string }) => c.status === 'invalid'))
      throw new ActivationError(
        'Corrige las filas inválidas antes de activar el seguimiento.',
        422,
      );
    const row = {
      actor_id: user.id,
      source_connection_id: connection.id,
      approval_run_id: run.id,
      name: definition.name,
      definition,
      approved_schema: { headers, sheetIndex: run.sheet_index, prompt },
      trigger: body.trigger,
      interval_minutes: body.intervalMinutes,
    };
    const saved = await db.from('activation_automations').insert(row).select('*').single();
    if (saved.error?.code === '23505') {
      const existing = await db
        .from('activation_automations')
        .select('*')
        .eq('actor_id', user.id)
        .eq('approval_run_id', run.id)
        .single();
      if (existing.data) return NextResponse.json({ automation: automationSummary(existing.data) });
    }
    if (saved.error || !saved.data)
      throw new ActivationError('No se pudo guardar la autorización.', 503);
    return NextResponse.json({ automation: automationSummary(saved.data) });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof ActivationError
            ? error.message
            : 'No se pudo configurar el seguimiento.',
      },
      { status: error instanceof ActivationError ? error.status : 503 },
    );
  }
}
