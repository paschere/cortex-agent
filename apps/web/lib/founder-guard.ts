import 'server-only';

/**
 * La puerta del modo fundador: quién es la cuenta y de qué empresas es dueña.
 *
 * ===========================================================================
 * POR QUÉ NO BASTA CON `requireSession`
 * ===========================================================================
 * `requireSession` resuelve UN espacio —el de la pestaña— y el rol en ese
 * espacio. La consola del fundador actúa sobre varias empresas a la vez desde
 * una ruta global (/overview/*), así que la pregunta es otra: «¿esta cuenta es
 * `owner` de ESTA empresa, ahora mismo?», repetida para cada empresa que toca
 * una acción. Se responde leyendo `ba_member` en cada llamada, nunca desde algo
 * que mandó el navegador ni desde la sesión cacheada: perder la propiedad tiene
 * que cortar el acceso en la petición siguiente.
 *
 * Fundador = `ba_member.role = 'owner'` en una organización `kind = 'company'`,
 * la misma definición que `assertCorporateFounder` (lib/team-activity.ts) y que
 * el tope de `organizationLimit` (lib/auth.ts). El espacio personal no cuenta:
 * ser dueño de él nunca da permisos empresariales.
 */

import type { ActiveOrganization, SessionUser } from '@cortex/core';
import { UnauthorizedError } from '@cortex/core';
import { headers } from 'next/headers';
import { auth, pool } from './auth';
import { partitionOwned } from './founder-rules';
import { requireSession } from './session';

export interface OwnedCompany {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string;
}

export class FounderAccessError extends Error {
  constructor(message = 'Solo el fundador de la empresa puede hacer esto.') {
    super(message);
    this.name = 'FounderAccessError';
  }
}

/** Las empresas de las que esta cuenta es fundadora hoy, leídas de better-auth. */
export async function listOwnedCompanies(accountId: string): Promise<OwnedCompany[]> {
  const { rows } = await pool.query<OwnedCompany>(
    `select o.id, o.name, o.slug, o."createdAt"::text as "createdAt"
       from public.ba_member m
       join public.ba_organization o on o.id = m."organizationId"
      where m."userId" = $1 and m.role = 'owner' and o.kind = 'company'
      order by o.name`,
    [accountId],
  );
  return rows;
}

export interface FounderContext {
  user: SessionUser;
  accountId: string;
  owned: OwnedCompany[];
  ownedIds: ReadonlySet<string>;
}

/**
 * La sesión, la cuenta de better-auth y sus empresas propias, en una llamada.
 *
 * No exige tener ninguna: una cuenta sin empresas propias puede abrir la
 * consola y ver el estado vacío. Lo que exige propiedad son las acciones, y
 * lo hacen con `assertOwns` / `partitionOwned` sobre `ownedIds`.
 */
export async function requireFounderContext(): Promise<FounderContext> {
  const user = await requireSession();
  const session = await auth.api.getSession({ headers: await headers() });
  const accountId = session?.user?.id;
  if (!accountId) throw new UnauthorizedError();
  const owned = await listOwnedCompanies(accountId);
  return { user, accountId, owned, ownedIds: new Set(owned.map((company) => company.id)) };
}

/** La empresa pedida, sólo si es de esta cuenta. Lanza en cualquier otro caso. */
export function assertOwns(context: FounderContext, organizationId: string): OwnedCompany {
  const company = context.owned.find((item) => item.id === organizationId);
  if (!company) throw new FounderAccessError();
  return company;
}

/** Reparte una lista pedida por el navegador entre propias y ajenas. */
export function splitOwned(context: FounderContext, requested: readonly string[]) {
  const { allowed, denied } = partitionOwned(requested, context.ownedIds);
  return {
    allowed: allowed.map(
      (id) => context.owned.find((company) => company.id === id) as OwnedCompany,
    ),
    denied,
  };
}

/** El `ActiveOrganization` de una empresa propia, para las lecturas por inquilino. */
export function asOwnedWorkspace(company: OwnedCompany): ActiveOrganization {
  return { id: company.id, name: company.name, slug: company.slug, role: 'owner', kind: 'company' };
}
