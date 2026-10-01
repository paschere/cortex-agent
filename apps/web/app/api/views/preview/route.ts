import { isSameOrigin } from '@/lib/activations/request';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { previewInput, previewSpec } from '@/lib/views/editor-server';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * La vista previa del lienzo: el spec que se está armando, comprobado y
 * calculado con datos reales, sin guardar nada y sin llamar al modelo (no
 * gasta respuestas del plan). Ver lib/views/editor-server.ts.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req))
    return NextResponse.json(
      { ok: false, error: 'Origen de solicitud inválido.' },
      { status: 403 },
    );
  const user = await requireSession();
  const parsed = previewInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ ok: false, error: 'Vista previa inválida.' }, { status: 400 });
  const db = getOrgScopedClient(user.organization.id);
  try {
    const result = await previewSpec(db, user.id, parsed.data);
    return NextResponse.json(result, { headers: { 'cache-control': 'no-store' } });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: 'No se pudo calcular la vista previa. Sigue editando; se reintenta sola.',
      },
      { status: 503 },
    );
  }
}
