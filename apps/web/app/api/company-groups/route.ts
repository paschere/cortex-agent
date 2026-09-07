import { auth } from '@/lib/auth';
import {
  addCompanyToGroup,
  createCompanyGroup,
  listCompanyGroups,
  listUngroupedOwnedCompanies,
  removeCompanyFromGroup,
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

const Change = z.object({
  groupId: z.string().uuid(),
  organizationId: z.string().min(1),
  action: z.enum(['add', 'remove']),
});
export async function PATCH(request: NextRequest) {
  const account = await accountId();
  if (!account) return NextResponse.json({ error: 'Sin sesión.' }, { status: 401 });
  const parsed = Change.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Solicitud inválida.' }, { status: 400 });
  const changed =
    parsed.data.action === 'add'
      ? await addCompanyToGroup(account, parsed.data.groupId, parsed.data.organizationId)
      : await removeCompanyFromGroup(account, parsed.data.groupId, parsed.data.organizationId);
  return changed
    ? NextResponse.json({ ok: true })
    : NextResponse.json(
        { error: 'No administras este grupo o no eres fundador de esa empresa.' },
        { status: 403 },
      );
}
