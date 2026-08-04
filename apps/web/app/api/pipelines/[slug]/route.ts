import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';
import { UpdateBody, placeholderError } from '../_schema';

export const runtime = 'nodejs';

/**
 * Update a pipeline from the builder, or flip its archived flag.
 * The slug is immutable — pipeline_runs and scheduled jobs address it by name.
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  await requireSession();
  const { slug } = await params;

  const parsed = UpdateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid pipeline', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const db = getSupabaseServiceClient();
  const { data: existing } = await db.from('pipelines').select('id').eq('slug', slug).maybeSingle();
  if (!existing) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ('steps' in body) {
    const phError = placeholderError(body.intro, body.steps, body.params);
    if (phError) return NextResponse.json({ error: phError }, { status: 422 });
    patch.name = body.name;
    patch.description = body.description;
    patch.emoji = body.emoji || '⚡';
    patch.intro = body.intro;
    patch.steps = body.steps;
    patch.params = body.params;
  }
  if (body.archived !== undefined) patch.archived = body.archived;

  const { data, error } = await db
    .from('pipelines')
    .update(patch)
    .eq('slug', slug)
    .select('slug, archived')
    .single();

  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? 'Update failed' }, { status: 500 });
  }
  return NextResponse.json({ slug: data.slug as string, archived: Boolean(data.archived) });
}

/**
 * Archive, never hard-delete: pipeline_runs reference the row and the history
 * on /pipelines/[slug] would vanish with it.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  await requireSession();
  const { slug } = await params;

  const db = getSupabaseServiceClient();
  const { data, error } = await db
    .from('pipelines')
    .update({ archived: true, updated_at: new Date().toISOString() })
    .eq('slug', slug)
    .select('slug')
    .single();

  if (error || !data) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 });
  return NextResponse.json({ slug: data.slug as string, archived: true });
}
