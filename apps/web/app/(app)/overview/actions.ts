'use server';

/**
 * Lo que la consola del fundador puede cambiar, empresa por empresa.
 *
 * ===========================================================================
 * CADA ACCIÓN VUELVE A PREGUNTAR DE QUIÉN ES CADA EMPRESA
 * ===========================================================================
 * Una acción de servidor es un endpoint con URL propia: se puede invocar sin
 * haber pintado /overview nunca, con los ids que quiera quien llama. Por eso
 * todas empiezan igual —`requireFounderContext()` lee de `ba_member` las
 * empresas de las que la cuenta es fundadora AHORA— y ninguna usa un id del
 * navegador sin pasarlo antes por `assertOwns` / `splitOwned`. Una empresa
 * ajena, un espacio personal o un id inventado reciben la misma respuesta.
 *
 * Después, el trabajo lo hace la misma función que usa «Personas» de cada
 * empresa (lib/team/membership-admin.ts), así que las reglas —último
 * fundador, fundador protegido, tope de asientos— son una sola.
 *
 * ===========================================================================
 * VARIAS EMPRESAS, UNA RESPUESTA POR EMPRESA
 * ===========================================================================
 * Invitar a tres empresas no es atómico ni puede serlo: son tres invitaciones
 * de better-auth, tres planes y tres topes de asientos. Se hacen en serie y se
 * devuelve qué pasó en cada una, para que la pantalla diga «listo en 2 de 3» y
 * cuál falló y por qué, en vez de un «error» que no dice si algo salió.
 */

import { auth } from '@/lib/auth';
import {
  FounderAccessError,
  assertOwns,
  requireFounderContext,
  splitOwned,
} from '@/lib/founder-guard';
import type { PerCompanyResult } from '@/lib/founder-rules';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { cancelInvitation } from '@/lib/team/invitations';
import {
  changeMemberRole,
  inviteToCompany,
  removeCompanyMember,
} from '@/lib/team/membership-admin';
import { revalidatePath } from 'next/cache';
import { headers } from 'next/headers';
import { z } from 'zod';

export interface FounderActionResult {
  ok: boolean;
  message: string;
}

const NOT_YOURS = 'Esa empresa no está entre las que diriges.';

function refresh(organizationId?: string) {
  revalidatePath('/overview');
  revalidatePath('/overview/people');
  if (organizationId) revalidatePath(`/overview/companies/${organizationId}`);
}

async function guarded(
  organizationId: string,
  work: (
    context: Awaited<ReturnType<typeof requireFounderContext>>,
  ) => Promise<FounderActionResult>,
): Promise<FounderActionResult> {
  const context = await requireFounderContext();
  try {
    assertOwns(context, organizationId);
  } catch (err) {
    if (err instanceof FounderAccessError) return { ok: false, message: NOT_YOURS };
    throw err;
  }
  const result = await work(context);
  if (result.ok) refresh(organizationId);
  return result;
}

/* ------------------------------------------------------------------------- */

const Invite = z.object({
  email: z.string().trim().toLowerCase().email('Ese correo no parece válido.'),
  role: z.enum(['member', 'admin']),
  organizationIds: z.array(z.string().min(1)).min(1, 'Elige al menos una empresa.').max(20),
});

export async function inviteAcrossCompaniesAction(
  input: z.input<typeof Invite>,
): Promise<{ ok: boolean; message?: string; results: PerCompanyResult[] }> {
  const parsed = Invite.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? 'Revisa los datos.',
      results: [],
    };
  }
  const context = await requireFounderContext();
  const { allowed, denied } = splitOwned(context, parsed.data.organizationIds);
  const requestHeaders = await headers();
  const results: PerCompanyResult[] = [];
  // En serie a propósito: better-auth y el tope de asientos leen y escriben
  // filas de cada empresa, y el orden de la respuesta sigue el de la pantalla.
  for (const company of allowed) {
    const result = await inviteToCompany({
      organizationId: company.id,
      email: parsed.data.email,
      role: parsed.data.role,
      requestHeaders,
    });
    results.push({
      organizationId: company.id,
      organizationName: company.name,
      ok: result.ok,
      message: result.ok ? 'Invitación enviada' : result.message,
    });
  }
  for (const id of denied) {
    results.push({
      organizationId: id,
      organizationName: 'Empresa',
      ok: false,
      message: NOT_YOURS,
    });
  }
  if (results.some((result) => result.ok)) refresh();
  return { ok: results.every((result) => result.ok), results };
}

/* ------------------------------------------------------------------------- */

const RoleChange = z.object({
  organizationId: z.string().min(1),
  memberId: z.string().min(1),
  role: z.enum(['member', 'team_admin', 'org_admin']),
});

export async function changeFounderMemberRoleAction(
  input: z.input<typeof RoleChange>,
): Promise<FounderActionResult> {
  const parsed = RoleChange.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Solicitud inválida.' };
  const { organizationId, memberId, role } = parsed.data;
  return guarded(organizationId, async (context) =>
    changeMemberRole({
      organizationId,
      workspaceKind: 'company',
      actorAccountId: context.accountId,
      actorRole: 'owner',
      memberId,
      next: role,
      requestHeaders: await headers(),
    }),
  );
}

const Removal = z.object({ organizationId: z.string().min(1), memberId: z.string().min(1) });

export async function removeFounderMemberAction(
  input: z.input<typeof Removal>,
): Promise<FounderActionResult> {
  const parsed = Removal.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Solicitud inválida.' };
  const { organizationId, memberId } = parsed.data;
  return guarded(organizationId, async (context) =>
    removeCompanyMember({
      organizationId,
      workspaceKind: 'company',
      actorAccountId: context.accountId,
      actorRole: 'owner',
      memberId,
      requestHeaders: await headers(),
    }),
  );
}

const CancelInvite = z.object({
  organizationId: z.string().min(1),
  invitationId: z.string().min(1),
});

export async function cancelFounderInvitationAction(
  input: z.input<typeof CancelInvite>,
): Promise<FounderActionResult> {
  const parsed = CancelInvite.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Solicitud inválida.' };
  const { organizationId, invitationId } = parsed.data;
  return guarded(organizationId, async () => {
    // El espacio va en el WHERE de `cancelInvitation`: un id de invitación de
    // otra empresa no coincide con nada aunque la empresa pedida sí sea tuya.
    const canceled = await cancelInvitation(
      getOrgScopedClient(organizationId),
      organizationId,
      invitationId,
    );
    return canceled
      ? { ok: true, message: 'Invitación cancelada.' }
      : { ok: false, message: 'Esa invitación ya no está pendiente. Recarga la pantalla.' };
  });
}

/* ------------------------------------------------------------------------- */

const Rename = z.object({
  organizationId: z.string().min(1),
  name: z.string().trim().min(1, 'Ponle un nombre a la empresa.').max(120),
});

/**
 * Renombrar una empresa. Sólo el nombre: el slug no cambia, porque aparece en
 * enlaces ya enviados y ninguno debe romperse por un cambio de nombre.
 */
export async function renameCompanyAction(
  input: z.input<typeof Rename>,
): Promise<FounderActionResult> {
  const parsed = Rename.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Revisa el nombre.' };
  }
  const { organizationId, name } = parsed.data;
  return guarded(organizationId, async () => {
    try {
      await auth.api.updateOrganization({
        body: { data: { name }, organizationId },
        headers: await headers(),
      });
    } catch (err) {
      console.error('[founder] better-auth rechazó el cambio de nombre', err);
      return { ok: false, message: 'No se pudo cambiar el nombre. Inténtalo de nuevo.' };
    }
    return { ok: true, message: 'Nombre actualizado.' };
  });
}
