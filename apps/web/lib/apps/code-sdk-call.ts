/** Llama a la puerta `/sdk` del servidor y devuelve `{ok,data|error,status}`; con `file`, como multipart. */
export async function callSdk(
  url: string,
  op: string,
  args: unknown,
  file?: File,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string; status?: number }> {
  let init: RequestInit;
  if (file) {
    const form = new FormData();
    form.set('op', op);
    form.set('args', JSON.stringify(args ?? null));
    form.set('file', file, file.name);
    init = { method: 'POST', body: form };
  } else {
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, args: args ?? null }),
    };
  }
  const res = await fetch(url, init);
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    data?: unknown;
    error?: string;
  } | null;
  if (!res.ok || json?.ok === false || json?.error) {
    return {
      ok: false,
      status: res.status,
      error: json?.error ?? 'No se pudo completar la operación. Intenta de nuevo.',
    };
  }
  return { ok: true, data: json && 'data' in json ? json.data : json };
}
