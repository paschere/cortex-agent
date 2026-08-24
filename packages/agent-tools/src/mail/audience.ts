import { internalEmailDomains, isInternalEmailDomain } from '@cortex/core';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * QUIÉN ESTÁ EN ESTE HILO DE CORREO — la pregunta de la que depende si se
 * archiva o no.
 *
 * ESTE MÓDULO NACIÓ DENTRO DE `outlook/ingest-thread.ts` y sale aquí sin
 * cambiar una línea de su comportamiento, porque Gmail necesita exactamente el
 * mismo juicio. La regla que decide qué correspondencia puede entrar a un
 * espacio compartido no puede existir dos veces: dos copias son dos reglas en
 * cuanto alguien arregle una sola, y el modo de fallo de esta en concreto es
 * publicar el correo privado de un empleado.
 *
 * `outlook/ingest-thread.ts` sigue re-exportando todo lo de aquí, así que nada
 * de lo que ya importaba de allí tuvo que cambiar.
 */

export interface ThreadAudience {
  /** Addresses on a domain that is not ours. */
  external: string[];
  /** The distinct outside domains, lowercased. */
  externalDomains: string[];
  /** True when INTERNAL_EMAIL_DOMAINS is unset and the question is unanswerable. */
  undecidable: boolean;
}

export function domainOf(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/** Who on this thread is outside the company — the whole archivability test. */
export function classifyAudience(participants: string[]): ThreadAudience {
  if (internalEmailDomains().length === 0) {
    return { external: [], externalDomains: [], undecidable: true };
  }
  const external = participants.filter((a) => !isInternalEmailDomain(a));
  const domains = new Set<string>();
  for (const a of external) {
    const d = domainOf(a);
    if (d) domains.add(d);
  }
  return { external, externalDomains: [...domains], undecidable: false };
}

/**
 * Free mailbox providers. A thread with a client is with `naviera.com.co`; a
 * thread with `hotmail.com` is a person, and their address is not a company we
 * would ever want to attribute correspondence to.
 */
const PERSONAL_MAIL_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'hotmail.com',
  'hotmail.es',
  'hotmail.com.co',
  'outlook.com',
  'outlook.es',
  'live.com',
  'yahoo.com',
  'yahoo.es',
  'icloud.com',
  'me.com',
  'protonmail.com',
  'proton.me',
  'aol.com',
]);

/**
 * The one outside domain this correspondence is with, when there is one.
 *
 * Null when the thread spans several companies or only free mailboxes: an
 * ambiguous attribution is worse than none, because a wrong `client_id` is a
 * fact somebody will later read off a report.
 */
export function counterpartDomainOf(audience: ThreadAudience): string | null {
  const corporate = audience.externalDomains.filter((d) => !PERSONAL_MAIL_DOMAINS.has(d));
  return corporate.length === 1 ? (corporate[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// The client link
// ---------------------------------------------------------------------------

/**
 * Find the client this correspondence belongs to, from the counterpart domain.
 *
 * IT READS A HUMAN'S STATEMENT AND MAKES NO GUESS OF ITS OWN. `client_domains`
 * (migration 0075) holds "this domain belongs to this client", each row signed
 * by the person who vouched for it and unique across the workspace. That is the
 * strongest signal there is for whose mail this is — stronger than the subject,
 * the body, or any similarity between a domain and a company name — precisely
 * because somebody asserted it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is fall back to matching the domain's label
 * against client names. `coltrans.com` looks like "Colombiana de Transportes"
 * and also like "Colombia Transportadora", and 0075's own header states the
 * rule this defers to: a link that was not earned is worse than no link at all.
 * A wrong attribution ends up in a report somebody acts on; a missing one is a
 * gap closed by registering the domain once, which then fixes every future
 * thread from that sender.
 *
 * SO IT RETURNS NULL FAR MORE OFTEN THAN IT MATCHES, and the whole lookup is
 * wrapped: a workspace that has registered no domains, or a deployment where
 * migration 0075 has not been applied, gets a null link rather than a failed
 * archive.
 */
export async function matchClientByDomain(
  db: SupabaseClient,
  domain: string | null,
): Promise<string | null> {
  if (!domain) return null;
  try {
    const { data, error } = await db
      .from('client_domains')
      .select('client_id')
      .eq('domain', domain.trim().toLowerCase())
      .maybeSingle();
    if (error || !data) return null;
    return ((data as { client_id?: string }).client_id ?? null) as string | null;
  } catch {
    // The table may not exist yet in this environment. A missing link is a
    // normal outcome here; a failed archive would not be.
    return null;
  }
}
