import { canClassifyFinanceSource, classifySourceError } from '@/lib/finance/source-policy';
import { readFinanceSources, summarizeFinanceSources } from '@/lib/finance/sources';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

const Domain = z.enum(['financial', 'administrative', 'commercial', 'operations']);
const FinancialRole = z.enum(['unclassified', 'receivable', 'payable', 'reference']);
const PatchBody = z.object({
  extractionId: z.string().uuid(),
  sourceDomains: z.array(Domain).max(4),
  financialRole: FinancialRole,
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

export async function GET() {
  const user = await requireSession();
  try {
    return NextResponse.json(
      await readFinanceSources(getOrgScopedClient(user.organization.id), {
        userId: user.id,
        canClassify: canClassifyFinanceSource(user.organization.role),
      }),
    );
  } catch {
    return NextResponse.json(
      { error: 'No se pudieron leer las fuentes financieras.' },
      { status: 503 },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const user = await requireSession();
  if (!canClassifyFinanceSource(user.organization.role))
    return NextResponse.json(
      { error: 'No tienes permiso para clasificar fuentes.' },
      { status: 403 },
    );

  const parsed = PatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'La clasificación enviada no es válida.' }, { status: 400 });

  const db = getOrgScopedClient(user.organization.id);
  const { data, error } = await db.rpc('finance_classify_source', {
    p_user_id: user.id,
    p_extraction_id: parsed.data.extractionId,
    p_source_domains: parsed.data.sourceDomains,
    p_financial_role: parsed.data.financialRole,
    p_expected_updated_at: parsed.data.expectedUpdatedAt,
  });
  if (error) {
    const response = classifySourceError(error.code);
    return NextResponse.json({ error: response.error }, { status: response.status });
  }

  // Re-read through the visibility-gated projection. This also prevents the
  // mutation response from becoming a side channel for private KB metadata.
  try {
    const result = await readFinanceSources(db, { userId: user.id, canClassify: true });
    const source = result.sources.find((item) => item.extractionId === parsed.data.extractionId);
    if (!source)
      return NextResponse.json({ error: 'La fuente dejó de estar visible.' }, { status: 404 });
    return NextResponse.json({ source, summary: summarizeFinanceSources(result.sources) });
  } catch {
    void data;
    return NextResponse.json(
      { error: 'La clasificación se guardó, pero no se pudo releer.' },
      { status: 503 },
    );
  }
}
