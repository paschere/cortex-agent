import { requireSession } from '@/lib/session';
import { PipelineBuilder } from '../_components/PipelineBuilder';
import { builderToolCatalog } from '../_lib/tool-catalog';

export const dynamic = 'force-dynamic';

export default async function NewPipelinePage() {
  await requireSession();
  return <PipelineBuilder mode="create" tools={builderToolCatalog()} nextRunNumber={1} />;
}
