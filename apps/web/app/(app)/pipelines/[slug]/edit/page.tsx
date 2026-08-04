import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { notFound } from 'next/navigation';
import { PipelineBuilder } from '../../_components/PipelineBuilder';
import type { ParamDef, StepDef } from '../../_lib/playbook';
import { builderToolCatalog } from '../../_lib/tool-catalog';

export const dynamic = 'force-dynamic';

export default async function EditPipelinePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireSession();
  const { slug } = await params;

  const sb = getSupabaseServiceClient();
  const { data: p } = await sb
    .from('pipelines')
    .select('slug, name, description, emoji, intro, steps, params, times_run')
    .eq('slug', slug)
    .maybeSingle();
  if (!p) notFound();

  const steps = ((p.steps ?? []) as StepDef[]).map((s) => ({
    title: s.title,
    detail: s.detail,
    tools: s.tools ?? [],
    checkpoint: s.checkpoint ?? false,
  }));

  return (
    <PipelineBuilder
      mode="edit"
      tools={builderToolCatalog()}
      nextRunNumber={((p.times_run as number) ?? 0) + 1}
      initial={{
        slug: p.slug as string,
        name: p.name as string,
        description: (p.description as string) ?? '',
        emoji: (p.emoji as string) || '⚡',
        intro: (p.intro as string) ?? '',
        steps,
        params: ((p.params ?? []) as ParamDef[]).map((x) => ({
          name: x.name,
          description: x.description ?? '',
          required: x.required !== false,
        })),
      }}
    />
  );
}
