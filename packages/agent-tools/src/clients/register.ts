import { z } from 'zod';
import { registerTool } from '../index';
import {
  CLIENT_SERVICES,
  CLIENT_STATUSES,
  CUSTOMS_ROLES,
  adaptClient,
  clientSchema,
  isPublicDomain,
  normalizeDomain,
} from './shape';
import { addDomain, matchCommitmentsToClients, registerClient } from './store';

/**
 * Put a client on the books.
 *
 * Two things happen here that do not happen anywhere else, and both are the
 * reason this is a tool rather than a form field:
 *
 * 1. THE NIT IS CHECKED. `registerClient` runs the verification digit and
 *    refuses a NIT that contradicts itself, by name, before anything is
 *    written. A transposed digit caught here is a duplicate client that never
 *    exists; caught later it is a card split in half.
 *
 * 2. THE PAST IS ADOPTED. Registering Coltrans immediately attaches the
 *    deadlines whose counterparty already said "Coltrans" — and reports how
 *    many it left alone. That report is the point: a number with no
 *    denominator is a claim, and this one comes with both.
 *
 * Confirmation-gated, like every write. A client is a record other people will
 * rely on and other modules will hang rows off; it should not appear because a
 * model inferred one from a sentence.
 */
export const clientsRegister = registerTool({
  id: 'clients.register',
  description:
    "Register a customer company, or update the one that is already there. The NIT is the identity: give it with its verification digit when you have it (\"830025281-7\") and Cortex refuses the pair if they disagree, which is what stops a mistyped NIT becoming a second copy of the same client. Registering the same NIT or name again UPDATES instead of duplicating. Registering the client's email domain is what makes their mail attach itself afterwards — do it whenever the person can tell you the domain. Only for CUSTOMERS: the DIAN, an insurer or a supplier are counterparties on a commitment, not clients. Requires confirmation.",
  inputSchema: z.object({
    name: z.string().min(2).max(160).describe('What people call them out loud, e.g. "Coltrans"'),
    legalName: z
      .string()
      .max(200)
      .optional()
      .describe('Razón social as the RUT spells it, when it differs from the name'),
    nit: z
      .string()
      .max(30)
      .optional()
      .describe('NIT, with or without the verification digit. Dots and dashes are fine.'),
    status: z.enum(CLIENT_STATUSES).default('active'),
    emailDomains: z
      .array(z.string().max(200))
      .max(10)
      .optional()
      .describe(
        'Domains whose mail belongs to this client, e.g. ["coltrans.com"]. Only register a domain the client actually owns — never gmail.com or another free provider, which Cortex refuses anyway. Everything that arrives from a registered domain is attached to this client with no further review, so this is a statement, not a guess.',
      ),
    city: z.string().max(80).optional(),
    department: z.string().max(80).optional().describe('Departamento, spelt out'),
    phone: z.string().max(40).optional(),
    website: z.string().max(200).optional(),
    services: z
      .array(z.enum(CLIENT_SERVICES))
      .optional()
      .describe('What BBIC does for them: courier, carga, aduana, almacenamiento, última milla'),
    customsRole: z.enum(CUSTOMS_ROLES).optional(),
    paymentTermsDays: z
      .number()
      .int()
      .min(0)
      .max(365)
      .optional()
      .describe('Agreed payment window, in days'),
    notes: z.string().max(4000).optional(),
  }),
  outputSchema: z.object({
    client: clientSchema,
    created: z.boolean().describe('False when the client already existed and was updated'),
    domainsRegistered: z.array(z.string()),
    domainsRefused: z.array(z.string()).describe('Domains that could not be registered, and why'),
    adopted: z.object({
      matched: z.number().describe('Existing commitments now attached to this client'),
      ambiguous: z.number().describe('Left alone because more than one client matched'),
      unmatched: z.number().describe('Left alone because nothing matched'),
    }),
    guidance: z.string(),
  }),
  requiresConfirmation: true,
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    const { client: row, created, nearDuplicates } = await registerClient(ctx.db, {
      name: input.name,
      legalName: input.legalName ?? null,
      nit: input.nit ?? null,
      status: input.status ?? 'active',
      city: input.city ?? null,
      department: input.department ?? null,
      phone: input.phone ?? null,
      website: input.website ?? null,
      services: input.services,
      customsRole: input.customsRole ?? null,
      paymentTermsDays: input.paymentTermsDays ?? null,
      notes: input.notes ?? null,
      createdBy: ctx.userId,
    });

    // Domains are registered one at a time so one refusal does not lose the
    // rest. A refused domain is reported in the words the refusal used —
    // "gmail.com es un correo público" is actionable; "error" is not.
    const domainsRegistered: string[] = [];
    const domainsRefused: string[] = [];
    for (const raw of input.emailDomains ?? []) {
      const domain = normalizeDomain(raw);
      if (!domain) continue;
      try {
        await addDomain(ctx.db, { clientId: row.id, domain, userId: ctx.userId });
        domainsRegistered.push(domain);
      } catch (err) {
        domainsRefused.push(
          `${domain}: ${err instanceof Error ? err.message : 'no se pudo registrar'}`,
        );
      }
    }

    // Adopt what already existed. Restricted to this client, so registering
    // one company does not quietly re-scan and re-attribute the workspace.
    const adopted = await matchCommitmentsToClients(ctx.db, { onlyClientId: row.id });

    const notes: string[] = [
      created
        ? `${row.name} queda registrado.`
        : `${row.name} ya estaba, así que lo actualicé en vez de crear una copia.`,
    ];
    if (nearDuplicates.length > 0) {
      notes.push(
        `Ojo: ya existía ${nearDuplicates.map((c) => c.name).join(', ')}, que se escribe casi igual. Si es la misma empresa, hay que dejar una sola.`,
      );
    }
    if (domainsRegistered.length > 0) {
      notes.push(
        `Desde ahora, lo que llegue de ${domainsRegistered.map((d) => `@${d}`).join(', ')} se le atribuye a este cliente automáticamente.`,
      );
    }
    if (domainsRefused.length > 0) notes.push(domainsRefused.join(' '));
    if (adopted.matched > 0) {
      notes.push(
        `Le colgué ${adopted.matched} vencimiento${adopted.matched === 1 ? '' : 's'} que ya estaba${adopted.matched === 1 ? '' : 'n'} a su nombre en texto.`,
      );
    }
    if (adopted.ambiguous > 0) {
      notes.push(
        `Dejé ${adopted.ambiguous} sin vincular porque emparejaban con más de un cliente. Eso se resuelve a mano, no adivinando.`,
      );
    }
    if (!row.tax_id) {
      notes.push('Falta el NIT. Es la llave real del cliente; el nombre no alcanza.');
    }
    if (domainsRegistered.length === 0 && (input.emailDomains ?? []).length === 0) {
      notes.push(
        'No quedó ningún dominio registrado, así que sus correos no se van a vincular solos. Es lo que más rinde de todo esto.',
      );
    }

    return {
      client: adaptClient(row),
      created,
      domainsRegistered,
      domainsRefused,
      adopted,
      guidance: notes.join(' '),
    };
  },
});

/** Exported for the register form, which warns before the insert rather than after. */
export function domainWarning(domain: string): string | null {
  const normalized = normalizeDomain(domain);
  if (!normalized) return 'Eso no parece un dominio.';
  if (isPublicDomain(normalized)) {
    return `${normalized} es un correo público. Si lo registras, cualquier cuenta personal quedaría atribuida a este cliente.`;
  }
  return null;
}
