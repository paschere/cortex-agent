import { IntegrationError } from '@cortex/core';
import { z } from 'zod';
import { assertPublicHost } from '../external-mcp';
import { registerTool } from '../index';

/**
 * String/hostname-based SSRF guard. Blocks loopback, link-local, cloud metadata,
 * and RFC1918 private ranges. (DNS-resolution-based checking is a Track 4 concern
 * for the Node egress path; the string check is sufficient here.)
 */
function isPrivateUrl(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return true; // unparseable → treat as unsafe
  }

  // strip IPv6 brackets
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === 'localhost' || host === '0.0.0.0' || host === '::1' || host.endsWith('.localhost')) {
    return true;
  }

  // IPv4 dotted-quad checks
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + metadata
    if (a === 0) return true; // 0.0.0.0/8
  }

  // cloud metadata host
  if (host === 'metadata.google.internal' || host === 'metadata') return true;

  return false;
}

export const webScrape = registerTool({
  id: 'web.scrape',
  description:
    'Fetch and extract the main text content of a public web page as markdown/plain text. Uses Firecrawl when configured, otherwise the Jina Reader fallback. Output is truncated to maxChars.',
  inputSchema: z.object({
    url: z.string().url(),
    maxChars: z.number().int().min(500).max(20000).default(5000),
  }),
  outputSchema: z.object({
    url: z.string(),
    content: z.string(),
    truncated: z.boolean(),
    source: z.enum(['firecrawl', 'jina']),
  }),
  rateLimit: { perMinute: 10 },
  handler: async (input, ctx) => {
    if (isPrivateUrl(input.url)) {
      throw new IntegrationError('URL not allowed', 'web');
    }
    if (new URL(input.url).hostname.includes('linkedin.com')) {
      throw new IntegrationError(
        "LinkedIn URLs return a login wall — use web_search with the person's name instead",
        'web',
      );
    }
    // DNS-resolution SSRF guard (catches hostnames that resolve to private IPs).
    try {
      await assertPublicHost(input.url);
    } catch (err) {
      throw new IntegrationError(err instanceof Error ? err.message : 'URL not allowed', 'web');
    }

    const firecrawlKey = process.env.FIRECRAWL_API_KEY;
    let raw: string;
    let source: 'firecrawl' | 'jina';

    if (firecrawlKey) {
      source = 'firecrawl';
      type FirecrawlResponse = { data?: { markdown?: string; content?: string } };
      const r = await fetch('https://api.firecrawl.dev/v0/scrape', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${firecrawlKey}`,
        },
        body: JSON.stringify({ url: input.url, pageOptions: { onlyMainContent: true } }),
        signal: ctx.signal,
      });
      if (!r.ok) throw new IntegrationError(`Firecrawl ${r.status}: ${await r.text()}`, 'web');
      const data = (await r.json()) as FirecrawlResponse;
      raw = data.data?.markdown ?? data.data?.content ?? '';
    } else {
      source = 'jina';
      const r = await fetch(`https://r.jina.ai/${encodeURIComponent(input.url)}`, {
        signal: ctx.signal,
      });
      if (!r.ok) throw new IntegrationError(`Jina ${r.status}: ${await r.text()}`, 'web');
      raw = await r.text();
    }

    const maxChars = input.maxChars ?? 5000;
    const truncated = raw.length > maxChars;
    const content = truncated ? clip(raw, maxChars) : raw;

    return { url: input.url, content, truncated, source };
  },
});

/**
 * PRINCIPIO Y FINAL, NUNCA SÓLO EL PRINCIPIO.
 *
 * ===========================================================================
 * EL CASO QUE LO OBLIGÓ, MEDIDO
 * ===========================================================================
 * `www.bbicolombia.com` devuelve 21.693 caracteres. Su razón social está en el
 * carácter 9.885 y **su NIT en el 20.916**. Con el corte en 20.000 —que además
 * es el máximo que este esquema permite, no una elección de quien llama— el NIT
 * se perdía por 916 caracteres, y la pantalla que lo buscaba decía «no encontré
 * nada» sin que nadie pudiera saber por qué.
 *
 * Y eso NO es mala suerte: el NIT, la razón social, la dirección y el teléfono
 * viven en el PIE DE PÁGINA. En cualquier sitio, siempre. Recortar desde el
 * principio es exactamente la estrategia equivocada para buscar la identidad de
 * una empresa, y lo era en todas las páginas largas, no sólo en ésta.
 *
 * Así que cuando hay que recortar se conservan los dos extremos: el principio,
 * que es de lo que trata la página, y el final, que es quién la firma. Se dice
 * en medio, con la cuenta de lo que falta, para que ni una persona ni un modelo
 * lean los dos trozos como si fueran seguidos — un salto silencioso pegaría la
 * primera mitad de una frase con la segunda de otra.
 *
 * Un cuarto para el pie: es de sobra para un bloque de contacto y deja tres
 * cuartos para el contenido, que sigue siendo la razón por la que alguien pide
 * una página.
 */
const TAIL_SHARE = 0.25;

export function clip(raw: string, maxChars: number): string {
  const tail = Math.floor(maxChars * TAIL_SHARE);
  const head = maxChars - tail;
  const dropped = raw.length - maxChars;
  return `${raw.slice(0, head)}\n\n... [se omitieron ${dropped} caracteres del medio] ...\n\n${raw.slice(-tail)}`;
}
