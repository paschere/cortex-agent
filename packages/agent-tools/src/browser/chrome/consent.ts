import { blockedUrlReason, hostInSite, siteOfUrl } from './domain';

/**
 * Quién decide si Cortex puede actuar en un sitio de tu Chrome.
 *
 * Una función pura, a propósito: la corre LA EXTENSIÓN antes de cada orden (es
 * la que manda, porque vive en el navegador de la persona y un servidor
 * comprometido no la puede saltar) y la corre el servidor antes de encolar
 * (para fallar rápido y para no proponer lo que ya se dijo que no).
 *
 * Orden de precedencia, de más fuerte a más débil:
 *   1. dirección bloqueada (páginas del navegador, red privada, Cortex mismo)
 *   2. «nunca» en este sitio
 *   3. «siempre» en este sitio
 *   4. «solo esta vez» concedido en ESTA sesión
 *   5. preguntar
 * «Nunca» le gana a «solo esta vez»: si la persona cambió de idea, vale lo
 * último que dijo en firme.
 */

export type SiteDecision = 'always' | 'never';
export interface SiteRule {
  site: string;
  decision: SiteDecision;
}

export type ConsentVerdict =
  | { kind: 'allow'; via: 'always' | 'once'; site: string }
  | { kind: 'deny'; reason: 'blocked' | 'never'; site: string | null; message: string }
  | { kind: 'ask'; site: string };

export function decideConsent(input: {
  url: string;
  rules: readonly SiteRule[];
  /** Sitios concedidos «solo esta vez» a ESTA sesión. */
  onceSites: readonly string[];
  /** Sitios de Cortex mismo, que no se tocan. */
  protectedSites?: readonly string[];
}): ConsentVerdict {
  const blocked = blockedUrlReason(input.url, input.protectedSites ?? []);
  if (blocked) {
    return { kind: 'deny', reason: 'blocked', site: siteOfUrl(input.url), message: blocked };
  }
  const site = siteOfUrl(input.url);
  if (!site) {
    return {
      kind: 'deny',
      reason: 'blocked',
      site: null,
      message: 'No pude identificar el sitio de esa dirección.',
    };
  }
  const host = new URL(input.url).hostname.toLowerCase();
  const rule = input.rules.find((r) => hostInSite(host, r.site));
  if (rule?.decision === 'never') {
    return {
      kind: 'deny',
      reason: 'never',
      site,
      message: `Dijiste que Cortex nunca actúe en ${site}.`,
    };
  }
  if (rule?.decision === 'always') return { kind: 'allow', via: 'always', site };
  if (input.onceSites.some((s) => hostInSite(host, s))) return { kind: 'allow', via: 'once', site };
  return { kind: 'ask', site };
}

/** Agrega o reemplaza la regla de un sitio; devuelve una lista nueva. */
export function withRule(rules: readonly SiteRule[], rule: SiteRule): SiteRule[] {
  return [...rules.filter((r) => r.site !== rule.site), rule];
}
