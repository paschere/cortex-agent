import { auth } from '@/lib/auth';
import {
  addCompanyToGroup,
  createCompanyGroup,
  deleteCompanyGroup,
  listCompanyGroups,
  listUngroupedOwnedCompanies,
  removeCompanyFromGroup,
  renameCompanyGroup,
} from '@/lib/company-groups';
import { requireSession } from '@/lib/session';
import { headers } from 'next/headers';
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

export const runtime = 'nodejs';

async function accountId() {
  await requireSession();
  return (await auth.api.getSession({ headers: await headers() }))?.user?.id ?? null;
}

export async function GET() {
  const account = await accountId();
  if (!account) return NextResponse.json({ error: 'Sin sesión.' }, { status: 401 });
  const [groups, availableCompanies] = await Promise.all([
    listCompanyGroups(account),
    listUngroupedOwnedCompanies(account),
  ]);
  return NextResponse.json({ groups, availableCompanies });
}

const Create = z.object({ name: z.string().trim().min(1).max(120) });
export async function POST(request: NextRequest) {
  const account = await accountId();
  if (!account) return NextResponse.json({ error: 'Sin sesión.' }, { status: 401 });
  const parsed = Create.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return NextResponse.json({ error: 'Ponle un nombre al grupo.' }, { status: 400 });
  return NextResponse.json(
    { id: await createCompanyGroup(account, parsed.data.name) },
    { status: 201 },
  );
}

/**
 * Un cambio sobre un grupo existente: meter o sacar una empresa, o renombrarlo.
 *
 * Cada rama vuelve a comprobar en su propia sentencia que la cuenta administra
 * el grupo (y, al meter o sacar, que es fundadora de la empresa); el id del
 * grupo que manda el navegador sólo dice CUÁL, nunca da permiso.
 */
const Change = z.discriminatedUnion('action', [
  z.object({
    groupId: z.string().uuid(),
    organizationId: z.string().min(1),
    action: z.enum(['add', 'remove']),
  }),
  z.object({
    groupId: z.string().uuid(),
    action: z.literal('rename'),
    name: z.string().trim().min(1).max(120),
  }),
]);
export async function PATCH(request: NextRequest) {
  const account = await accountId();
  if (!account) return NextResponse.json({ error: 'Sin sesión.' }, { status: 401 });
  const parsed = Change.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  const body = parsed.data;
  if (body.action === 'rename') {
    return (await renameCompanyGroup(account, body.groupId, body.name))
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: 'No administras este grupo.' }, { status: 403 });
  }
  const changed =
    body.action === 'add'
      ? await addCompanyToGroup(account, body.groupId, body.organizationId)
      : await removeCompanyFromGroup(account, body.groupId, body.organizationId);
  return changed
    ? NextResponse.json({ ok: true })
    : NextResponse.json(
        { error: 'No administras este grupo o no eres fundador de esa empresa.' },
        { status: 403 },
      );
}

const Remove = z.object({ groupId: z.string().uuid() });
export async function DELETE(request: NextRequest) {
  const account = await accountId();
  if (!account) return NextResponse.json({ error: 'Sin sesión.' }, { status: 401 });
  const parsed = Remove.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  return (await deleteCompanyGroup(account, parsed.data.groupId))
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: 'No administras este grupo.' }, { status: 403 });
}
