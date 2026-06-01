import { z } from 'zod';
import { registerTool } from '../index';
import { driveGet } from './client';

const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';

export const gdriveSearchFiles = registerTool({
  id: 'gdrive.search_files',
  description:
    "Search the user's Google Drive for files whose name contains the query. Optionally filter by mimeType. Returns id, name, mimeType, webViewLink, and modifiedTime per file.",
  inputSchema: z.object({
    query: z.string().min(1),
    mimeType: z
      .string()
      .optional()
      .describe(
        'e.g. application/vnd.google-apps.document for Docs, application/vnd.google-apps.spreadsheet for Sheets',
      ),
    limit: z.number().int().min(1).max(30).default(10),
  }),
  outputSchema: z.object({
    files: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        mimeType: z.string(),
        webViewLink: z.string().nullable(),
        modifiedTime: z.string().nullable(),
      }),
    ),
  }),
  requiredScopes: [{ provider: 'google', scopes: [DRIVE_READONLY] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    type DriveFile = {
      id: string;
      name: string;
      mimeType: string;
      webViewLink?: string;
      modifiedTime?: string;
    };
    type R = { files?: DriveFile[] };

    const escaped = input.query.replace(/'/g, "\\'");
    const clauses = [`name contains '${escaped}'`];
    if (input.mimeType) clauses.push(`mimeType = '${input.mimeType.replace(/'/g, "\\'")}'`);
    const q = clauses.join(' and ');

    const r = await driveGet<R>(ctx, '/files', {
      q,
      fields: 'files(id,name,mimeType,webViewLink,modifiedTime,owners)',
      pageSize: String(input.limit),
    });

    return {
      files: (r.files ?? []).map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        webViewLink: f.webViewLink ?? null,
        modifiedTime: f.modifiedTime ?? null,
      })),
    };
  },
});
