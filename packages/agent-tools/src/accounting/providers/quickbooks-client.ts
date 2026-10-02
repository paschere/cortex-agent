import type { ProviderToken, ProviderTokenStore } from '../types';
import { backoffMs } from './common';

/**
 * EL CLIENTE DE QUICKBOOKS ONLINE (API de contabilidad de Intuit).
 *
 * Lo que dice la documentación oficial (developer.intuit.com › QuickBooks
 * Online), y por qué este archivo tiene la forma que tiene:
 *
 *   - OAuth 2.0 con código de autorización. Quien conecta entra a Intuit
 *     (`appcenter.intuit.com/connect/oauth2`, alcance
 *     `com.intuit.quickbooks.accounting`), elige la empresa y vuelve con
 *     `code`, `state` y `realmId` (el id de la empresa en QuickBooks).
 *   - El código se cambia por tokens en
 *     `oauth.platform.intuit.com/oauth2/v1/tokens/bearer`, con la app en Basic
 *     (`client_id:client_secret`). El access token vale una hora; el refresh
 *     token ~100 días y ROTA: cada renovación puede devolver uno nuevo, y hay
 *     que guardar siempre el último. Por eso aquí una renovación guarda primero
 *     el refresh token (cifrado, en la llave de la conexión) y si eso falla la
 *     corrida falla: un refresh token perdido es una conexión perdida.
 *   - Los datos se leen con el lenguaje de consultas:
 *     `GET /v3/company/{realmId}/query?query=SELECT * FROM Invoice WHERE …
 *     STARTPOSITION n MAXRESULTS 1000` (1000 es el máximo). La respuesta es
 *     `{ QueryResponse: { Invoice: [...], startPosition, maxResults } }`.
 *   - `minorversion=75`: desde agosto de 2025 Intuit responde en la 75 aunque
 *     se pida una menor; se manda explícita para que el día que haya otra no
 *     cambie nada sin que nadie lo decida.
 *   - Límite: 500 peticiones por minuto por empresa (y 10 a la vez). Un 429 se
 *     reintenta con la espera de `Retry-After` o creciente. Un 401 renueva el
 *     access token una vez y repite.
 *
 * Los errores salen en español y sin jerga, listos para la tarjeta y para
 * `last_error`.
 */

export const QUICKBOOKS_AUTHORIZE_URL = 'https://appcenter.intuit.com/connect/oauth2';
export const QUICKBOOKS_TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QUICKBOOKS_REVOKE_URL = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const QUICKBOOKS_SCOPE = 'com.intuit.quickbooks.accounting';
export const QUICKBOOKS_MINOR_VERSION = '75';
export const QUICKBOOKS_PAGE_SIZE = 1000;
const API_BASE = {
  production: 'https://quickbooks.api.intuit.com',
  sandbox: 'https://sandbox-quickbooks.api.intuit.com',
} as const;
/** Margen antes del vencimiento del access token (1 h) para pedir uno nuevo. */
const TOKEN_MARGIN_MS = 5 * 60_000;

export interface QuickBooksAppConfig {
  clientId: string;
  clientSecret: string;
  environment: 'production' | 'sandbox';
  apiBase: string;
}

type EnvLike = Record<string, string | undefined>;

/**
 * La app de QuickBooks de ESTA instalación (una app de Intuit sirve a todas
 * las empresas). `null` si falta el id o el secreto: la tarjeta lo dice y el
 * botón no se habilita; nada se cae.
 */
export function quickbooksAppConfig(env: EnvLike = process.env): QuickBooksAppConfig | null {
  const clientId = env.QUICKBOOKS_CLIENT_ID?.trim();
  const clientSecret = env.QUICKBOOKS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const environment =
    env.QUICKBOOKS_ENVIRONMENT?.trim().toLowerCase() === 'sandbox' ? 'sandbox' : 'production';
  return { clientId, clientSecret, environment, apiBase: API_BASE[environment] };
}

// Lo lee un dueño en la tarjeta de «Programas contables»: no puede hacer nada
// con nombres de variables de entorno. Lo que necesita saber es que esto lo
// habilita Cortex, no él. (Para quien opera la instalación: faltan
// QUICKBOOKS_CLIENT_ID y QUICKBOOKS_CLIENT_SECRET, de developer.intuit.com.)
export const QUICKBOOKS_SETUP_MESSAGE =
  'QuickBooks todavía no está habilitado en tu cuenta de Cortex. Lo activa el equipo de Cortex una sola vez: pídeselo y después lo conectas aquí entrando con tu usuario de Intuit.';

export function quickbooksSetupMissing(env: EnvLike = process.env): string | null {
  return quickbooksAppConfig(env) ? null : QUICKBOOKS_SETUP_MESSAGE;
}

/** La dirección de Intuit a la que se manda a quien conecta. */
export function quickbooksAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(QUICKBOOKS_AUTHORIZE_URL);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', QUICKBOOKS_SCOPE);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.toString();
}

export type QuickBooksErrorKind =
  | 'credentials'
  | 'setup'
  | 'forbidden'
  | 'rate'
  | 'unavailable'
  | 'other';

export class QuickBooksError extends Error {
  constructor(
    message: string,
    readonly kind: QuickBooksErrorKind,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'QuickBooksError';
  }
}

const RECONNECT_MESSAGE =
  'QuickBooks ya no acepta la conexión (se venció o la quitaron desde Intuit). Vuelve a conectar desde Integraciones.';

function basic(config: QuickBooksAppConfig): string {
  return `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`, 'utf8').toString('base64')}`;
}

function sleepFor(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export interface QuickBooksTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms del vencimiento del access token. */
  expiresAt: number;
}

/**
 * Pide tokens al endpoint de Intuit: con el código (al conectar) o con el
 * refresh token (al renovar). Los errores no repiten nada de la respuesta.
 */
export async function requestQuickbooksTokens(input: {
  config: QuickBooksAppConfig;
  body: Record<string, string>;
  fetch?: typeof fetch;
  now?: () => number;
}): Promise<QuickBooksTokens> {
  const doFetch = input.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(QUICKBOOKS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: basic(input.config),
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(input.body).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new QuickBooksError(
      'No se pudo conectar con Intuit para renovar el acceso. Se reintenta sola en la próxima sincronización.',
      'unavailable',
    );
  }
  const body = (await res.json().catch(() => null)) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  } | null;
  if (!res.ok || !body?.access_token || !body.refresh_token) {
    if (res.status === 401 || body?.error === 'invalid_client')
      throw new QuickBooksError(
        'Intuit no reconoce la app de QuickBooks de esta instalación (revisa QUICKBOOKS_CLIENT_ID y QUICKBOOKS_CLIENT_SECRET).',
        'setup',
        res.status,
        body?.error ?? null,
      );
    if (res.status >= 500)
      throw new QuickBooksError(
        'Intuit no está respondiendo en este momento. Se reintenta sola en la próxima sincronización.',
        'unavailable',
        res.status,
      );
    throw new QuickBooksError(RECONNECT_MESSAGE, 'credentials', res.status, body?.error ?? null);
  }
  const seconds = Number(body.expires_in) || 3600;
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: (input.now ?? Date.now)() + Math.min(seconds, 3600) * 1000,
  };
}

/** Cambia el código de la vuelta de Intuit por tokens (al conectar). */
export function exchangeQuickbooksCode(input: {
  config: QuickBooksAppConfig;
  code: string;
  redirectUri: string;
  fetch?: typeof fetch;
}): Promise<QuickBooksTokens> {
  return requestQuickbooksTokens({
    config: input.config,
    fetch: input.fetch,
    body: { grant_type: 'authorization_code', code: input.code, redirect_uri: input.redirectUri },
  });
}

interface FaultBody {
  Fault?: { Error?: Array<{ code?: string; Message?: string }>; type?: string };
  fault?: { error?: Array<{ code?: string; message?: string }>; type?: string };
}

function faultCode(body: unknown): string | null {
  const b = body as FaultBody | null;
  return b?.Fault?.Error?.[0]?.code ?? b?.fault?.error?.[0]?.code ?? null;
}

function describeFailure(status: number, code: string | null, what: string): QuickBooksError {
  if (status === 401) return new QuickBooksError(RECONNECT_MESSAGE, 'credentials', status, code);
  if (status === 403)
    return new QuickBooksError(
      'Ese usuario de QuickBooks no tiene permiso para leer la contabilidad de la empresa. Conecta con un usuario administrador.',
      'forbidden',
      status,
      code,
    );
  if (status === 429)
    return new QuickBooksError(
      'QuickBooks pidió bajar el ritmo (límite de peticiones por minuto). Se reintenta sola en la próxima sincronización.',
      'rate',
      status,
      code,
    );
  if (status >= 500)
    return new QuickBooksError(
      'QuickBooks no está respondiendo en este momento. Se reintenta sola en la próxima sincronización.',
      'unavailable',
      status,
      code,
    );
  return new QuickBooksError(
    `QuickBooks respondió con un error (${status}${code ? `, ${code}` : ''}) al consultar ${what}.`,
    'other',
    status,
    code,
  );
}

export interface QuickBooksClientOptions {
  realmId: string;
  refreshToken: string;
  config: QuickBooksAppConfig;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** El access token, cifrado entre corridas (`token_enc`). */
  tokenStore?: ProviderTokenStore;
  /** Guarda el refresh token nuevo. Si lanza, la renovación falla. */
  onRefreshToken?: (refreshToken: string) => Promise<void>;
  /** Espera mínima entre peticiones. 150 ms ≈ 400 por minuto. */
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export class QuickBooksClient {
  private token: ProviderToken | null = null;
  private refreshToken: string;
  private lastRequestAt = 0;
  /** Cuántas peticiones HTTP se hicieron (para el registro de la corrida). */
  requests = 0;

  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: QuickBooksClientOptions) {
    this.refreshToken = opts.refreshToken;
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? sleepFor;
    this.now = opts.now ?? Date.now;
    this.minIntervalMs = opts.minIntervalMs ?? 150;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  /**
   * El access token vigente: de memoria, del almacén, o renovado con el
   * refresh token. Al renovar, el refresh token nuevo se guarda ANTES de usar
   * el access token: si no se pudo guardar, no se sigue.
   */
  async accessToken(force = false): Promise<string> {
    const fresh = (t: ProviderToken | null) => t && t.expiresAt - this.now() > TOKEN_MARGIN_MS;
    if (!force && fresh(this.token)) return (this.token as ProviderToken).token;
    if (!force && this.opts.tokenStore) {
      const stored = await this.opts.tokenStore.load().catch(() => null);
      if (fresh(stored)) {
        this.token = stored;
        return (stored as ProviderToken).token;
      }
    }
    this.requests += 1;
    const tokens = await requestQuickbooksTokens({
      config: this.opts.config,
      fetch: this.doFetch,
      now: this.now,
      body: { grant_type: 'refresh_token', refresh_token: this.refreshToken },
    });
    if (tokens.refreshToken !== this.refreshToken) {
      await this.opts.onRefreshToken?.(tokens.refreshToken);
      this.refreshToken = tokens.refreshToken;
    }
    this.token = { token: tokens.accessToken, expiresAt: tokens.expiresAt };
    await this.opts.tokenStore?.save(this.token).catch(() => undefined);
    return tokens.accessToken;
  }

  /** Una petición GET a la API, con reintentos ante 429, 5xx y red; un 401 renueva una vez. */
  async get<T>(path: string, params: Record<string, string>, what: string): Promise<T> {
    const qs = new URLSearchParams({ ...params, minorversion: QUICKBOOKS_MINOR_VERSION });
    const url = `${this.opts.config.apiBase}/v3/company/${encodeURIComponent(this.opts.realmId)}${path}?${qs}`;
    let attempt = 0;
    let renewed = false;
    let token = await this.accessToken();
    for (;;) {
      await this.pace();
      this.requests += 1;
      let res: Response;
      try {
        res = await this.doFetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt < Math.min(this.maxRetries, 2)) {
          attempt += 1;
          await this.sleep(2_000 * attempt);
          continue;
        }
        throw new QuickBooksError(
          'No se pudo conectar con QuickBooks (la red o el servicio no respondieron). Se reintenta sola en la próxima sincronización.',
          'unavailable',
        );
      }
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (res.ok) return body as T;
      if (res.status === 401 && !renewed) {
        // Un access token que Intuit ya no reconoce: uno nuevo, una sola vez.
        renewed = true;
        token = await this.accessToken(true);
        continue;
      }
      const failure = describeFailure(res.status, faultCode(body), what);
      if (
        (failure.kind === 'rate' || failure.kind === 'unavailable') &&
        attempt < this.maxRetries
      ) {
        attempt += 1;
        await this.sleep(backoffMs(res.headers, attempt));
        continue;
      }
      throw failure;
    }
  }

  /** Una consulta del lenguaje de QuickBooks; devuelve la lista de la entidad. */
  async query<T>(entity: string, sql: string): Promise<T[]> {
    const body = await this.get<{ QueryResponse?: Record<string, unknown> } | null>(
      '/query',
      { query: sql },
      entity,
    );
    const list = body?.QueryResponse?.[entity];
    return Array.isArray(list) ? (list as T[]) : [];
  }

  /** Una página: `STARTPOSITION` sale del número de página (desde 1). */
  async page<T>(
    entity: string,
    where: string | undefined,
    orderBy: string | undefined,
    page: number,
  ): Promise<{ results: T[]; hasMore: boolean }> {
    const start = (Math.max(page, 1) - 1) * QUICKBOOKS_PAGE_SIZE + 1;
    const sql = [
      `SELECT * FROM ${entity}`,
      where ? `WHERE ${where}` : '',
      orderBy ? `ORDERBY ${orderBy}` : '',
      `STARTPOSITION ${start} MAXRESULTS ${QUICKBOOKS_PAGE_SIZE}`,
    ]
      .filter(Boolean)
      .join(' ');
    const results = await this.query<T>(entity, sql);
    return { results, hasMore: results.length >= QUICKBOOKS_PAGE_SIZE };
  }

  /** El nombre de la empresa conectada (lo que la tarjeta muestra como «Cuenta»). */
  async companyName(): Promise<string | null> {
    const [info] = await this.query<{ CompanyName?: string; LegalName?: string }>(
      'CompanyInfo',
      'SELECT * FROM CompanyInfo',
    );
    return info?.CompanyName?.trim() || info?.LegalName?.trim() || null;
  }

  /** La moneda de la empresa en QuickBooks (la de un documento sin `CurrencyRef`). */
  async homeCurrency(): Promise<string | null> {
    const [prefs] = await this.query<{
      CurrencyPrefs?: { HomeCurrency?: { value?: string } };
    }>('Preferences', 'SELECT * FROM Preferences');
    return prefs?.CurrencyPrefs?.HomeCurrency?.value ?? null;
  }

  /** «Probar»: renueva el acceso y lee la empresa. */
  async verify(): Promise<{ token: ProviderToken }> {
    await this.accessToken(true);
    await this.companyName();
    return { token: this.token as ProviderToken };
  }

  /** Al desconectar: Intuit invalida el refresh token. Nunca lanza. */
  async revoke(): Promise<void> {
    try {
      await this.doFetch(QUICKBOOKS_REVOKE_URL, {
        method: 'POST',
        headers: {
          Authorization: basic(this.opts.config),
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ token: this.refreshToken }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Si Intuit no contesta, la llave igual se borra de Cortex.
    }
  }
}
