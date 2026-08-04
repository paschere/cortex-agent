import { z } from 'zod';
import { registerTool } from '../index';
import { type PersonResult, adaptPerson, peopleGet } from './client';

const DIRECTORY_READONLY = 'https://www.googleapis.com/auth/directory.readonly';
const CONTACTS_READONLY = 'https://www.googleapis.com/auth/contacts.readonly';

const READ_MASK = 'names,emailAddresses,organizations';

interface SearchResponse {
  results?: Array<{ person?: Parameters<typeof adaptPerson>[0] }>;
}

/**
 * Resolve a person mentioned by name to their email + role, searching the
 * company's Google Workspace directory first (every colleague on it) and the
 * caller's personal contacts as a fallback. Use this whenever the user refers
 * to someone by name and you need their email — e.g. before drafting an email
 * or scheduling a meeting.
 */
export const peopleSearch = registerTool({
  id: 'people.search',
  description:
    "Resolve a person's name to their EMAIL ADDRESS. Searches the company's Google Workspace directory (internal colleagues) and the user's personal Google contacts — which includes people outside the company. Call this when the user mentions someone by name and you need an address to write to or invite — e.g. before gmail.draft or gcal.create_event. Returns up to `limit` matches; if more than one matches, ask the user which one. " +
    'It returns a name, an email and whatever job title Google holds, and nothing else — no client placement, no manager, no hire date, no pay. For who is placed with which client and what that costs, payroll.team_assignments is the system that knows.',
  inputSchema: z.object({
    query: z.string().min(1).describe('Full or partial name (or email) to look up'),
    limit: z.number().int().min(1).max(10).default(5),
  }),
  outputSchema: z.object({
    matches: z.array(
      z.object({
        name: z.string().nullable(),
        email: z.string().nullable(),
        title: z.string().nullable(),
        department: z.string().nullable(),
        source: z.enum(['directory', 'contacts']),
      }),
    ),
    markdown: z.string(),
  }),
  requiredScopes: [{ provider: 'google', scopes: [DIRECTORY_READONLY] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const limit = input.limit ?? 5;
    const dedupe = new Map<string, PersonResult>();

    // 1) Workspace directory (colleagues).
    try {
      const dir = await peopleGet<SearchResponse>(ctx, '/people:searchDirectoryPeople', {
        query: input.query,
        readMask: READ_MASK,
        sources: 'DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE',
        pageSize: String(limit),
      });
      for (const r of dir.results ?? []) {
        if (!r.person) continue;
        const p = adaptPerson(r.person, 'directory');
        if (p.email) dedupe.set(p.email.toLowerCase(), p);
      }
    } catch {
      // Directory may be unavailable (scope not granted / not a Workspace org) — fall through.
    }

    // 2) Personal contacts (only if we have room for more matches).
    if (dedupe.size < limit) {
      try {
        const con = await peopleGet<SearchResponse>(ctx, '/people:searchContacts', {
          query: input.query,
          readMask: READ_MASK,
          pageSize: String(limit),
        });
        for (const r of con.results ?? []) {
          if (!r.person) continue;
          const p = adaptPerson(r.person, 'contacts');
          if (p.email && !dedupe.has(p.email.toLowerCase())) {
            dedupe.set(p.email.toLowerCase(), p);
          }
        }
      } catch {
        // Contacts scope may not be granted — ignore.
      }
    }

    const matches = [...dedupe.values()].slice(0, limit);
    const markdown =
      matches.length === 0
        ? `No people found matching "${input.query}".`
        : matches
            .map((m) => {
              const role = [m.title, m.department].filter(Boolean).join(', ');
              return `- **${m.name ?? 'Unknown'}** — ${m.email ?? 'no email'}${role ? ` · ${role}` : ''}`;
            })
            .join('\n');

    return { matches, markdown };
  },
});
