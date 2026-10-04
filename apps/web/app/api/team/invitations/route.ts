import { getOrgScopedClient } from '@/lib/supabase/service';
import { listInvitationDetails } from '@/lib/team/invite-flow';
import { requireInviter } from '@/lib/team/invite-guard';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * Lo que la pantalla de invitar necesita para pintarse completa: las pendientes
 * con quién invitó y lo que llevan, y los equipos de la empresa para el selector.
 *
 * Va por una ruta y no por props porque `/admin/users` entrega a los
 * componentes sólo lo básico, y estas dos listas se vuelven a pedir cada vez
 * que se envía, reenvía o cancela algo — sin recargar toda la página.
 */
export async function GET() {
  const gate = await requireInviter();
  if (!gate.ok) return gate.response;
  const organizationId = gate.user.organization.id;

  const db = getOrgScopedClient(organizationId);
  const [invitations, teams] = await Promise.all([
    listInvitationDetails(organizationId),
    db.from('teams').select('id, name').order('name'),
  ]);
  return NextResponse.json({
    invitations,
    teams: ((teams.data ?? []) as Array<{ id: string; name: string }>).map((team) => ({
      id: team.id,
      name: team.name,
    })),
  });
}
