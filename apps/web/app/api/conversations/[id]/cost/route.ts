import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { costLine, sumUsage } from '@/lib/usage-cost';
import { loadUsageRows, loadUsdCopRate } from '@/lib/usage-cost-store';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Lo que costó esta conversación (0228): el consumo registrado de sus turnos
 * (y de las tareas que nacieron de ella), con precio en pesos. Sólo de una
 * conversación propia. Sin consumo registrado devuelve `null`: la cabecera no
 * muestra una cifra inventada.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSession();
  const db = getOrgScopedClient(user.organization.id);
  const { data: conv, error } = await db
    .from('conversations')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!conv) return NextResponse.json({ cost: null });
  try {
    const [{ rows }, { rate }] = await Promise.all([
      loadUsageRows(db, { conversationId: id }),
      loadUsdCopRate(db),
    ]);
    if (!rows.length) return NextResponse.json({ cost: null });
    const t = sumUsage(rows);
    return NextResponse.json({
      cost: { usd: t.usd, tokens: t.tokens, turns: t.turns, rate, line: costLine(t, rate) },
    });
  } catch {
    // Sin la tabla (migración sin aplicar) la cabecera simplemente no muestra costo.
    return NextResponse.json({ cost: null });
  }
}
