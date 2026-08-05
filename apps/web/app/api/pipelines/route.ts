import { type NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { CreateBody, placeholderError } from './_schema';

export const runtime = 'nodejs';

/** Create a pipeline from the visual builder (same rules as pipeline.create). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const user = await requireSession();

  const parsed = CreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid pipeline', issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const phError = placeholderError(body.intro, body.steps, body.params);
  if (phError) return NextResponse.json({ error: phError }, { status: 422 });

  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db
    .from('pipelines')
    .insert({
      slug: body.slug,
      name: body.name,
      description: body.description,
      emoji: body.emoji || '⚡',
      intro: body.intro,
      steps: body.steps,
      instruction: '', // legacy column; superseded by steps
      params: body.params,
      created_by: user.id,
    })
    .select('slug')
    .single();

  if (error || !data) {
    if (error?.code === '23505') {
      return NextResponse.json(
        { error: `Pipeline "${body.slug}" already exists — pick another slug.` },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: error?.message ?? 'Failed to create pipeline' }, { status: 500 });
  }

  return NextResponse.json({ slug: data.slug as string }, { status: 201 });
}
