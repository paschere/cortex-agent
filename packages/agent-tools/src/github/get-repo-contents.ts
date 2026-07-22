import { z } from 'zod';
import { registerTool } from '../index';
import { githubFetch } from './client';

const EntryOut = z.object({
  name: z.string(),
  path: z.string(),
  type: z.string(),
  size: z.number(),
  url: z.string(),
});

const Output = z.object({
  kind: z.enum(['file', 'dir']),
  path: z.string(),
  // Populated when kind === 'file': decoded text content (base64-decoded as UTF-8).
  content: z.string().nullable(),
  encoding: z.string().nullable(),
  // Populated when kind === 'dir': the directory listing.
  entries: z.array(EntryOut),
});

export const getRepoContents = registerTool({
  id: 'github.get_repo_contents',
  description:
    'Read a file or directory from a GitHub repo. With no path (or a directory path) returns a directory listing; with a file path returns the file content base64-decoded to UTF-8. Defaults to the repo README when path is omitted. Used to gather documentation.',
  inputSchema: z.object({
    owner: z.string().min(1),
    repo: z.string().min(1),
    path: z.string().optional(),
    ref: z.string().optional(),
  }),
  outputSchema: Output,
  requiredScopes: [{ provider: 'github', scopes: ['repo'] }],
  rateLimit: { perMinute: 60 },
  handler: async (input, ctx) => {
    const base = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    const refQuery = input.ref ? `?ref=${encodeURIComponent(input.ref)}` : '';

    // No path → fetch the repo README (the canonical documentation entry point).
    if (input.path === undefined) {
      type Readme = { path: string; content: string; encoding: string };
      const readme = await githubFetch<Readme>(ctx, `${base}/readme${refQuery}`);
      return {
        kind: 'file' as const,
        path: readme.path,
        content:
          readme.encoding === 'base64'
            ? Buffer.from(readme.content, 'base64').toString('utf-8')
            : readme.content,
        encoding: readme.encoding,
        entries: [],
      };
    }

    type FileEntry = {
      name: string;
      path: string;
      type: string;
      size: number;
      html_url: string | null;
      content?: string;
      encoding?: string;
    };
    const data = await githubFetch<FileEntry | FileEntry[]>(
      ctx,
      `${base}/contents/${input.path.split('/').map(encodeURIComponent).join('/')}${refQuery}`,
    );

    if (Array.isArray(data)) {
      return {
        kind: 'dir' as const,
        path: input.path,
        content: null,
        encoding: null,
        entries: data.map((e) => ({
          name: e.name,
          path: e.path,
          type: e.type,
          size: e.size,
          url: e.html_url ?? '',
        })),
      };
    }

    return {
      kind: 'file' as const,
      path: data.path,
      content:
        data.encoding === 'base64' && data.content != null
          ? Buffer.from(data.content, 'base64').toString('utf-8')
          : (data.content ?? null),
      encoding: data.encoding ?? null,
      entries: [],
    };
  },
});
