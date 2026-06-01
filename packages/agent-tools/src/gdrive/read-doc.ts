import { z } from 'zod';
import { registerTool } from '../index';
import { driveGet, driveGetText } from './client';

const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';

export const gdriveReadDoc = registerTool({
  id: 'gdrive.read_doc',
  description:
    'Read the plain-text contents of a Google Drive file by ID. Google Docs are exported as text; other files are downloaded as raw media. Output is truncated to maxChars.',
  inputSchema: z.object({
    fileId: z.string().min(1),
    maxChars: z.number().int().min(100).max(50000).default(10000),
  }),
  outputSchema: z.object({
    fileId: z.string(),
    name: z.string().nullable(),
    mimeType: z.string().nullable(),
    content: z.string(),
    truncated: z.boolean(),
  }),
  requiredScopes: [{ provider: 'google', scopes: [DRIVE_READONLY] }],
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    type Meta = { id: string; name?: string; mimeType?: string };
    const meta = await driveGet<Meta>(ctx, `/files/${encodeURIComponent(input.fileId)}`, {
      fields: 'id,name,mimeType',
    });

    const isGoogleDoc = (meta.mimeType ?? '').startsWith('application/vnd.google-apps');

    let raw: string;
    if (isGoogleDoc) {
      raw = await driveGetText(ctx, `/files/${encodeURIComponent(input.fileId)}/export`, {
        mimeType: 'text/plain',
      });
    } else {
      raw = await driveGetText(ctx, `/files/${encodeURIComponent(input.fileId)}`, {
        alt: 'media',
      });
    }

    const maxChars = input.maxChars ?? 10000;
    const truncated = raw.length > maxChars;
    const content = truncated ? `${raw.slice(0, maxChars)}\n\n... [truncated]` : raw;

    return {
      fileId: input.fileId,
      name: meta.name ?? null,
      mimeType: meta.mimeType ?? null,
      content,
      truncated,
    };
  },
});
