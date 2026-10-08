import { z } from 'zod';
import { registerTool } from '../index';
import type { ToolContext } from '../types';
import { driveGet } from './client';
import {
  type FolderRef,
  cleanLevels,
  compact,
  pickFolder,
  resolveFolderPath,
} from './folder-match';

const DRIVE_READONLY = 'https://www.googleapis.com/auth/drive.readonly';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

interface DriveFolder {
  id: string;
  name: string;
}

/** Subcarpetas directas de una carpeta (sin la papelera). */
export async function listSubfolders(ctx: ToolContext, parentId: string): Promise<FolderRef[]> {
  const out: FolderRef[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, string> = {
      q: `'${esc(parentId)}' in parents and mimeType = '${FOLDER_MIME}' and trashed = false`,
      fields: 'nextPageToken,files(id,name)',
      pageSize: '1000',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    };
    if (pageToken) params.pageToken = pageToken;
    const page = await driveGet<{ nextPageToken?: string; files?: DriveFolder[] }>(
      ctx,
      '/files',
      params,
    );
    out.push(...(page.files ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && out.length < 3000);
  return out;
}

/** Carpetas de todo Drive cuyo nombre empieza una palabra con lo buscado (y luego se afina en código). */
async function searchFoldersByName(ctx: ToolContext, name: string): Promise<FolderRef[]> {
  const word = name.split(/\s+/).find((w) => compact(w).length >= 2) ?? name;
  const page = await driveGet<{ files?: DriveFolder[] }>(ctx, '/files', {
    q: `mimeType = '${FOLDER_MIME}' and trashed = false and name contains '${esc(word)}'`,
    fields: 'files(id,name)',
    pageSize: '200',
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  });
  return page.files ?? [];
}

export const gdriveFindFolder = registerTool({
  id: 'gdrive.find_folder',
  description:
    'Find an EXISTING folder in the user\'s Google Drive by name or by a path of names, tolerant of capitals, accents, hyphens and spaces ("AV204" finds "av 204 - 12 oct"; "045-12345678" finds "04512345678 Nexa"). Give `root` (the top folder, a name like "Vuelos" or a folder id via rootFolderId) and `path` (one name per level, e.g. ["AV204", "045-12345678"]: each level is searched INSIDE the previous one). Never creates anything. If nothing matches, or several folders match equally, it says so and lists the candidates — do not guess and do not upload to a folder that is not clearly the right one. Returns the folder id to use with gdrive.upload_file. Read-only.',
  inputSchema: z.object({
    root: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe('Name of the top folder, e.g. "Vuelos"'),
    rootFolderId: z.string().trim().min(5).max(120).optional().describe('Or its Drive id'),
    path: z
      .array(z.string().max(200))
      .max(6)
      .default([])
      .describe('One name (or part of a name) per level below the root'),
  }),
  outputSchema: z.object({
    found: z.boolean(),
    folderId: z.string().nullable(),
    folderName: z.string().nullable(),
    trail: z.array(z.string()),
    webViewLink: z.string().nullable(),
    reason: z.string().nullable(),
    candidates: z.array(z.object({ id: z.string(), name: z.string() })),
  }),
  requiredScopes: [{ provider: 'google', scopes: [DRIVE_READONLY] }],
  rateLimit: { perMinute: 30 },
  handler: async (input, ctx) => {
    const none = (reason: string, trail: FolderRef[] = [], candidates: FolderRef[] = []) => ({
      found: false,
      folderId: null,
      folderName: null,
      trail: trail.map((f) => f.name),
      webViewLink: null,
      reason,
      candidates,
    });
    if (!input.root && !input.rootFolderId)
      return none('Falta la carpeta de arriba: dime su nombre (root) o su id (rootFolderId).');

    let root: FolderRef;
    if (input.rootFolderId) {
      const meta = await driveGet<{ id: string; name: string; mimeType: string }>(
        ctx,
        `/files/${encodeURIComponent(input.rootFolderId)}`,
        { fields: 'id,name,mimeType', supportsAllDrives: 'true' },
      );
      if (meta.mimeType !== FOLDER_MIME) return none('Ese id no es una carpeta.');
      root = { id: meta.id, name: meta.name };
    } else {
      const wanted = input.root as string;
      const pick = pickFolder(await searchFoldersByName(ctx, wanted), wanted);
      if (pick.kind === 'none') return none(`No encuentro la carpeta «${wanted}» en tu Drive.`);
      if (pick.kind === 'ambiguous')
        return none(
          `Hay varias carpetas que coinciden con «${wanted}»: dame la ruta exacta o su id.`,
          [],
          pick.candidates,
        );
      root = pick.folder;
    }

    const res = await resolveFolderPath(
      (parentId) => listSubfolders(ctx, parentId),
      root,
      cleanLevels(input.path ?? []),
    );
    if (!res.found) return none(res.reason, res.trail, res.candidates ?? []);
    const meta = await driveGet<{ webViewLink?: string }>(
      ctx,
      `/files/${encodeURIComponent(res.folder.id)}`,
      { fields: 'webViewLink', supportsAllDrives: 'true' },
    ).catch(() => ({ webViewLink: undefined }));
    return {
      found: true,
      folderId: res.folder.id,
      folderName: res.folder.name,
      trail: res.trail.map((f) => f.name),
      webViewLink: meta.webViewLink ?? null,
      reason: null,
      candidates: [],
    };
  },
});
