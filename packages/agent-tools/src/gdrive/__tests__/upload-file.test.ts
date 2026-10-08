import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../types';
import { MISSING_WRITE_SCOPE_MESSAGE, gdriveUploadFile, uploadKey } from '../upload-file';

const FILE = { url: '/api/files/blob/abc.def', name: 'AWB.pdf', mime: 'application/pdf', size: 10 };

function ctx(over: Partial<ToolContext> = {}, write = true): ToolContext {
  return {
    integrations: {
      getAccessToken: async () => ({ token: 't', scopes: [] }),
      hasScopes: async () => write,
    },
    readStoredFile: async () => ({ bytes: Buffer.from('%PDF'), mime: 'application/pdf' }),
    ...over,
  } as unknown as ToolContext;
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

let calls: Array<{ url: string; method: string }>;
let existing: Array<{ id: string; webViewLink: string }>;
let folder: Record<string, unknown>;

beforeEach(() => {
  calls = [];
  existing = [];
  folder = {
    id: 'F1',
    name: 'guia 045',
    mimeType: 'application/vnd.google-apps.folder',
    capabilities: { canAddChildren: true },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method });
      if (url.includes('uploadType=resumable'))
        return new Response('', { status: 200, headers: { location: 'https://up/session' } });
      if (url === 'https://up/session')
        return json({ id: 'D9', name: 'AWB.pdf', webViewLink: 'https://drive/D9' });
      if (url.includes('/files?')) return json({ files: existing });
      return json(folder);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const run = (c: ToolContext, input: Record<string, unknown> = {}) =>
  gdriveUploadFile.handler({ folderId: 'F1abc', file: FILE, ...input } as never, c);

describe('gdrive.upload_file', () => {
  it('sin permiso de escritura dice cómo reconectar y no toca Drive', async () => {
    await expect(run(ctx({}, false))).rejects.toThrow(MISSING_WRITE_SCOPE_MESSAGE);
    expect(calls).toHaveLength(0);
  });

  it('sube a una carpeta existente y devuelve id y enlace', async () => {
    const r = await run(ctx());
    expect(r.files[0]).toMatchObject({
      status: 'uploaded',
      driveFileId: 'D9',
      link: 'https://drive/D9',
    });
    expect(calls.some((c) => c.method === 'PUT')).toBe(true);
  });

  it('idempotente: si Drive ya tiene el archivo con la misma llave, no sube otra vez', async () => {
    existing = [{ id: 'D1', webViewLink: 'https://drive/D1' }];
    const r = await run(ctx());
    expect(r.files[0]).toMatchObject({ status: 'already_there', driveFileId: 'D1' });
    expect(calls.some((c) => c.method === 'PUT' || c.url.includes('resumable'))).toBe(false);
  });

  it('la llave depende de la carpeta y del archivo', () => {
    expect(uploadKey('F1', FILE.url)).toBe(uploadKey('F1', FILE.url));
    expect(uploadKey('F1', FILE.url)).not.toBe(uploadKey('F2', FILE.url));
  });

  it('rechaza lo que no es carpeta o donde no se puede escribir', async () => {
    folder = { ...folder, mimeType: 'application/pdf' };
    await expect(run(ctx())).rejects.toThrow(/carpeta/);
    folder = {
      id: 'F1',
      name: 'x',
      mimeType: 'application/vnd.google-apps.folder',
      capabilities: { canAddChildren: false },
    };
    await expect(run(ctx())).rejects.toThrow(/permiso/);
  });

  it('un archivo que ya no está en Cortex falla sólo ese archivo', async () => {
    const r = await run(ctx({ readStoredFile: async () => null }));
    expect(r.files[0]).toMatchObject({ status: 'failed' });
  });
});
