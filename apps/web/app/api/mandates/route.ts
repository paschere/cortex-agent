import {
  MAX_MANDATE_DAYS,
  MAX_PATTERNS,
  grantMandate,
  resolveCoverage,
} from '@/lib/mandates/store';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

/**
 * Conceder un mandato.
 *
 * SOLO `org_admin`, y no por simetría con el resto de pantallas de
 * administración: quien escribe una fila aquí decide qué hace Cortex sin
 * preguntarle a nadie más en toda la empresa. Es el privilegio más alto que
 * concede el producto — más que crear una herramienta propia, porque esa al
 * menos sigue parándose a confirmar.
 *
 * La instantánea de ids NO viaja en el cuerpo. La resuelve el servidor en
 * `grantMandate`, contra el registro vivo: si la eligiera el cliente, una
 * petición podría mandar una lista que los patrones no justifican y el
 * invariante «lo efectivo es la intersección» dejaría de ser cierto justo donde
 * importa.
 */
const FORBIDDEN = {
  error:
    'Solo un administrador de la organización puede conceder mandatos: un mandato decide qué hace Cortex sin preguntarle a nadie.',
};

const GrantSchema = z.object({
  label: z.string().trim().min(3).max(80),
  reason: z.string().trim().max(500).default(''),
  toolPatterns: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_PATTERNS),
  maxRiskLevel: z.enum(['low', 'medium', 'high']),
  // `nullish()` y no `optional()`: el formulario manda `null` cuando el campo
  // está vacío, y un `undefined` que se cuela como «no lo toques» es cómo un
  // techo desaparece sin que nadie lo quite.
  amountCeiling: z.number().positive().max(1e15).nullish(),
  currency: z.string().trim().length(3).toUpperCase().nullish(),
  appliesUnattended: z.boolean().default(false),
  maxUsesPerDay: z.number().int().positive().max(10_000).nullish(),
  days: z.number().int().min(1).max(MAX_MANDATE_DAYS),
});

export async function POST(req: NextRequest) {
  const user = await requireSession();
  if (user.role !== 'org_admin') return NextResponse.json(FORBIDDEN, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 });
  }

  const parsed = GrantSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Faltan datos o no tienen la forma esperada.' },
      { status: 400 },
    );
  }

  const db = getOrgScopedClient(user.organization.id);
  try {
    const { id, covered } = await grantMandate(db, {
      label: parsed.data.label,
      reason: parsed.data.reason,
      toolPatterns: parsed.data.toolPatterns,
      maxRiskLevel: parsed.data.maxRiskLevel,
      amountCeiling: parsed.data.amountCeiling ?? null,
      currency: parsed.data.currency ?? null,
      appliesUnattended: parsed.data.appliesUnattended,
      maxUsesPerDay: parsed.data.maxUsesPerDay ?? null,
      days: parsed.data.days,
      grantedBy: user.id,
    });
    return NextResponse.json({ id, covered });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'No se pudo conceder el mandato.' },
      { status: 400 },
    );
  }
}

/**
 * Qué cubrirían estos patrones hoy, sin guardar nada.
 *
 * Existe para que la pantalla pueda enseñar la lista EXACTA antes de que alguien
 * pulse conceder. Delegar a ciegas sobre «gmail.*» y descubrir después qué
 * entraba ahí dentro es la manera más rápida de que un mandato haga algo que su
 * dueño no quería.
 */
export async function PUT(req: NextRequest) {
  const user = await requireSession();
  if (user.role !== 'org_admin') return NextResponse.json(FORBIDDEN, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'JSON inválido.' }, { status: 400 });
  }

  const parsed = z
    .object({ toolPatterns: z.array(z.string().trim().max(64)).max(MAX_PATTERNS) })
    .safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: 'Patrones inválidos.' }, { status: 400 });

  return NextResponse.json({ covered: resolveCoverage(parsed.data.toolPatterns.filter(Boolean)) });
}
