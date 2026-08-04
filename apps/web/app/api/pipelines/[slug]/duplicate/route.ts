import { type NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';

export const runtime = 'nodejs';

/** Slugs are capped at 49 chars by pipeline.create's grammar. */
const MAX_SLUG = 49;

function withSuffix(base: string, suffix: string): string {
  return `${base.slice(0, MAX_SLUG - suffix.length)}${suffix}`;
}

/**
 * Copy a pipeline into `<slug>-copy` (then `-copy-2`, `-copy-3`, … if taken).
 * The copy starts fresh: zero runs, never run, not archived.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const user = await requireSession();
  const { slug } = await params;

  const db = getSupabaseServiceClient();
  const { data: source } = await db
    .from('pipelines')
    .select('name, description, emoji, intro, steps, params, instruction')
    .eq('slug', slug)
    .maybeSingle();
  if (!source) return NextResponse.json({ error: 'Pipeline not found' }, { status: 404 });

  // Strip any existing "-copy…" tail so copies of copies stay readable.
  const base = slug.replace(/-copy(-\d+)?$/, '');
  const candidates = [withSuffix(base, '-copy')];
  for (let n = 2; n <= 20; n++) candidates.push(withSuffix(base, `-copy-${n}`));

  const { data: taken } = await db
    .from('pipelines')
    .select('slug')
    .in('slug', candidates);
  const takenSet = new Set(((taken ?? []) as { slug: string }[]).map((r) => r.slug));
  const newSlug = candidates.find((c) => !takenSet.has(c));
  if (!newSlug) {
    return NextResponse.json({ error: 'Too many copies of this pipeline' }, { status: 409 });
  }

  const { data, error } = await db
    .from('pipelines')
    .insert({
      slug: newSlug,
      name: `${source.name as string} (copy)`.slice(0, 80),
      description: source.description ?? '',
      emoji: source.emoji ?? '⚡',
      intro: source.intro ?? '',
      steps: source.steps ?? [],
      instruction: (source.instruction as string) ?? '',
      params: source.params ?? [],
      created_by: user.id,
    })
    .select('slug')
    .single();

  if (error || !data) {
    if (error?.code === '23505') {
      return NextResponse.json({ error: 'That copy already exists' }, { status: 409 });
    }
    return NextResponse.json({ error: error?.message ?? 'Duplicate failed' }, { status: 500 });
  }

  return NextResponse.json({ slug: data.slug as string }, { status: 201 });
}
