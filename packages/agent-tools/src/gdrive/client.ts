import { IntegrationError } from '@cortex/core';
import type { ToolContext } from '../types';

const BASE = 'https://www.googleapis.com/drive/v3';

/** GET a Drive API endpoint and parse the JSON response. */
export async function driveGet<T>(
  ctx: ToolContext,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Drive ${r.status} ${path}: ${await r.text()}`, 'google');
  return r.json() as Promise<T>;
}

/** GET a Drive API endpoint and return the raw text body (exports / media downloads). */
export async function driveGetText(
  ctx: ToolContext,
  path: string,
  params: Record<string, string> = {},
): Promise<string> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Drive ${r.status} ${path}: ${await r.text()}`, 'google');
  return r.text();
}

/** GET a Drive API endpoint and return the raw bytes (binary media downloads, alt=media). */
export async function driveGetBytes(
  ctx: ToolContext,
  path: string,
  params: Record<string, string> = {},
): Promise<Buffer> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
    signal: ctx.signal,
  });
  if (!r.ok) throw new IntegrationError(`Drive ${r.status} ${path}: ${await r.text()}`, 'google');
  return Buffer.from(await r.arrayBuffer());
}

/**
 * ESCRIBIR EN DRIVE: subida reanudable de un archivo a una carpeta que YA existe.
 *
 * Dos pasos (iniciar la sesión con los metadatos y mandar los bytes) en vez de
 * la subida «multipart»: la reanudable sirve igual para un PDF de 200 KB que
 * para uno de 20 MB, y así no hay dos caminos. `appProperties` lleva la llave
 * de idempotencia (ver `upload-file.ts`): Drive mismo es el registro de qué se
 * subió, con el id del archivo.
 */
export async function driveUploadFile(
  ctx: ToolContext,
  input: {
    folderId: string;
    name: string;
    mime: string;
    bytes: Buffer;
    appProperties?: Record<string, string>;
  },
): Promise<{ id: string; name: string; webViewLink: string | null }> {
  const { token } = await ctx.integrations.getAccessToken('google');
  const start = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,webViewLink',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': input.mime,
        'X-Upload-Content-Length': String(input.bytes.byteLength),
      },
      body: JSON.stringify({
        name: input.name,
        parents: [input.folderId],
        ...(input.appProperties ? { appProperties: input.appProperties } : {}),
      }),
      signal: ctx.signal,
    },
  );
  if (!start.ok)
    throw new IntegrationError(
      `Drive ${start.status} al iniciar la subida: ${await start.text()}`,
      'google',
    );
  const location = start.headers.get('location');
  if (!location) throw new IntegrationError('Drive no devolvió dónde subir el archivo.', 'google');
  const put = await fetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': input.mime, 'Content-Length': String(input.bytes.byteLength) },
    body: new Uint8Array(input.bytes),
    signal: ctx.signal,
  });
  if (!put.ok)
    throw new IntegrationError(
      `Drive ${put.status} al subir el archivo: ${await put.text()}`,
      'google',
    );
  const out = (await put.json()) as { id: string; name: string; webViewLink?: string };
  return { id: out.id, name: out.name, webViewLink: out.webViewLink ?? null };
}
