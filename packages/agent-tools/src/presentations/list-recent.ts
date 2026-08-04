import { z } from 'zod';
import { registerTool } from '../index';
import { type ToolMeta, buildMeta, metaSchema, provenanceFooter } from './provenance';
import { downloadUrlFor, expiresIn, formatBytes } from './storage';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 10;

interface FileRow {
  token: string;
  candidate_id: string;
  candidate_name: string | null;
  job_id: string | null;
  filename: string;
  size_bytes: number | null;
  downloads: number;
  expires_at: string;
  created_at: string;
  created_by: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMarkdown(files: any[], scopeLabel: string, meta: ToolMeta): string {
  if (files.length === 0) {
    return [
      `No presentation PDFs have been prepared ${scopeLabel} yet.`,
      '',
      provenanceFooter(meta),
    ].join('\n');
  }
  const lines: string[] = [];
  lines.push(`**Presentation PDFs prepared ${scopeLabel}** — most recent first.`);
  lines.push('');
  for (const f of files) {
    const state = f.expired
      ? 'link has expired — create a fresh one'
      : `link expires ${expiresIn(f.expiresAt)}`;
    const who = f.createdByName ? ` by ${f.createdByName}` : '';
    lines.push(
      `- ${
        f.expired
          ? `**${f.candidateName ?? 'Unnamed candidate'}** (expired)`
          : `[Download ${f.candidateName ?? 'presentation'} — presentation.pdf](${f.downloadUrl})`
      } — prepared ${String(f.createdAt).slice(0, 10)}${who}, ${formatBytes(f.sizeBytes ?? 0)}, downloaded ${f.downloads} time${f.downloads === 1 ? '' : 's'}, ${state}.`,
    );
  }
  lines.push('');
  lines.push(provenanceFooter(meta));
  return lines.join('\n');
}

export const listRecent = registerTool({
  id: 'presentations.list_recent',
  description:
    'List presentation PDFs that have already been prepared — for one candidate, or across the whole team. Use it when someone says "resend me that PDF", "did we already send the client a write-up for her?", or "what did we prepare last week", so you can re-share an existing link instead of paying to rebuild the same document. ' +
    'Each entry shows who prepared it, when, the file size, how many times it has been downloaded, and whether its link still works. Expired entries are listed WITHOUT a link — say so and offer to prepare a fresh one with presentations.create_pdf. Read-only. ' +
    'Speak about these as "the write-up we prepared for Ana on Tuesday", never as file rows, tokens or storage paths.',
  inputSchema: z.object({
    candidateId: z
      .string()
      .optional()
      .describe('Limit to one person. Omit to see everything the team has prepared.'),
    mine: z
      .boolean()
      .default(false)
      .describe('Only the files the current user prepared themselves.'),
    includeExpired: z.boolean().default(true),
    limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  }),
  outputSchema: z.object({
    files: z.array(z.any()),
    meta: metaSchema,
    markdown: z.string(),
  }),
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const limit = input.limit ?? DEFAULT_LIMIT;

    let query = ctx.db
      .from('presentation_files')
      .select(
        'token, candidate_id, candidate_name, job_id, filename, size_bytes, downloads, expires_at, created_at, created_by',
        { count: 'exact' },
      )
      .order('created_at', { ascending: false })
      .limit(limit);

    if (input.candidateId) query = query.eq('candidate_id', input.candidateId);
    if (input.mine) query = query.eq('created_by', ctx.userId);
    if (!input.includeExpired) query = query.gt('expires_at', new Date().toISOString());

    const { data, error, count } = await query;
    if (error) throw new Error(`Could not read the prepared presentations: ${error.message}`);

    const rows = (data ?? []) as unknown as FileRow[];

    // Resolve the author ids to names in one round-trip so the markdown can say
    // "prepared by Marta" instead of showing a uuid.
    const authorIds = [...new Set(rows.map((r) => r.created_by).filter(Boolean))] as string[];
    const names = new Map<string, string>();
    if (authorIds.length > 0) {
      const { data: users } = await ctx.db.from('users').select('id, name').in('id', authorIds);
      for (const u of (users ?? []) as { id: string; name: string | null }[]) {
        if (u.name) names.set(u.id, u.name);
      }
    }

    const now = Date.now();
    const files = rows.map((r) => {
      const expired = Date.parse(r.expires_at) <= now;
      return {
        candidateId: r.candidate_id,
        candidateName: r.candidate_name,
        jobId: r.job_id,
        filename: r.filename,
        sizeBytes: r.size_bytes,
        downloads: r.downloads,
        createdAt: r.created_at,
        createdByName: r.created_by ? (names.get(r.created_by) ?? null) : null,
        expiresAt: r.expires_at,
        expired,
        // A dead token is not a link — never hand the user a URL that 410s.
        downloadUrl: expired ? null : downloadUrlFor(r.token),
      };
    });

    const expiredCount = files.filter((f) => f.expired).length;

    const meta = buildMeta({
      endpoint: 'presentation_files (Cortex DB)',
      totalAvailable: count ?? files.length,
      returned: files.length,
      limit,
      truncated: (count ?? files.length) > files.length,
      provenance: {
        'candidateName, filename, sizeBytes, createdAt':
          'Cortex DB — recorded when the PDF was prepared',
        downloads: 'Cortex DB — counted on every click of the download link',
        'the document itself': 'AI-written by the matcher service at the time it was prepared',
      },
      dataQuality: [
        "These files are snapshots. If the candidate's profile or the write-up changed since, the PDF still shows the older version — prepare a fresh one when in doubt.",
        ...(expiredCount > 0
          ? [
              `${expiredCount} of ${files.length} entries have expired links and can only be re-shared by preparing a new PDF.`,
            ]
          : []),
      ],
    });

    const scopeLabel = input.candidateId
      ? 'for this candidate'
      : input.mine
        ? 'by you'
        : 'across the team';

    return { files, meta, markdown: renderMarkdown(files, scopeLabel, meta) };
  },
});
