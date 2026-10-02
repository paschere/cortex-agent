import { backoffMs } from './common';

/**
 * EL CLIENTE DE LA API DE ALEGRA (https://api.alegra.com/api/v1).
 *
 * Lo que dice la documentación oficial (developer.alegra.com), y por qué este
 * archivo tiene la forma que tiene:
 *
 *   - Autenticación HTTP Basic: el correo de la cuenta y el token de la API,
 *     separados por dos puntos y en base64, en `Authorization`. No hay token de
 *     sesión que pedir ni renovar. El token se saca en Alegra → Configuración →
 *     «API - Integraciones con otros sistemas». Una llave mala da 401; una
 *     cuenta suspendida o un plan sin API, 402.
 *   - Los listados son por posición: `?start=0&limit=30` (30 es el máximo:
 *     más da el error 903). Con `metadata=true` la respuesta llega como
 *     `{ metadata: { total }, data: [...] }`; sin él, una lista.
 *   - Límite: 150 peticiones por minuto por usuario. Pasarse da 429, con
 *     `X-Rate-Limit-Reset` (segundos que le quedan al minuto). Por eso cada
 *     petición espera su turno (`minIntervalMs`, ~130 por minuto) y un 429
 *     espera lo que diga esa cabecera (o `Retry-After`) y reintenta.
 *
 * Los errores salen en español y sin jerga, listos para la tarjeta de
 * Integraciones y para `last_error`.
 */

export const ALEGRA_BASE_URL = 'https://api.alegra.com/api/v1';
export const ALEGRA_PAGE_SIZE = 30;

export type AlegraErrorKind = 'credentials' | 'forbidden' | 'rate' | 'unavailable' | 'other';

export class AlegraError extends Error {
  constructor(
    message: string,
    readonly kind: AlegraErrorKind,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AlegraError';
  }
}

export interface AlegraClientOptions {
  email: string;
  token: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Espera mínima entre peticiones. 450 ms ≈ 130 por minuto. */
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
}

export interface AlegraPage<T> {
  page: number;
  pageSize: number;
  /** El total que dice `metadata`, si lo dijo. */
  total: number | null;
  results: T[];
}

type Query = Record<string, string | number | undefined>;

const CREDENTIALS_MESSAGE =
  'Alegra no aceptó el correo o el token. Revísalos en Alegra → Configuración → «API - Integraciones con otros sistemas» y vuelve a conectar.';

function describeFailure(status: number, path: string): AlegraError {
  if (status === 401) return new AlegraError(CREDENTIALS_MESSAGE, 'credentials', status);
  if (status === 402)
    return new AlegraError(
      'Alegra no deja usar la API en esta cuenta: está suspendida o su plan no la incluye. Revísalo en Alegra y vuelve a conectar.',
      'forbidden',
      status,
    );
  if (status === 403)
    return new AlegraError(
      'Ese usuario de Alegra no tiene permiso para consultar esta información. Pide en Alegra que le den acceso.',
      'forbidden',
      status,
    );
  if (status === 429)
    return new AlegraError(
      'Alegra pidió bajar el ritmo (límite de peticiones por minuto). Se reintenta sola en la próxima sincronización.',
      'rate',
      status,
    );
  if (status >= 500)
    return new AlegraError(
      'Alegra no está respondiendo en este momento. Se reintenta sola en la próxima sincronización.',
      'unavailable',
      status,
    );
  return new AlegraError(
    `Alegra respondió con un error (${status}) al consultar ${path}.`,
    'other',
    status,
  );
}

/** `Basic base64(correo:token)`, como lo pide Alegra. */
export function alegraAuthorization(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`, 'utf8').toString('base64')}`;
}

export class AlegraClient {
  private lastRequestAt = 0;
  /** Cuántas peticiones HTTP se hicieron (para el registro de la corrida). */
  requests = 0;

  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(opts: AlegraClientOptions) {
    this.baseUrl = (opts.baseUrl ?? ALEGRA_BASE_URL).replace(/\/+$/, '');
    this.authorization = alegraAuthorization(opts.email, opts.token);
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
    this.minIntervalMs = opts.minIntervalMs ?? 450;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  /** GET con reintentos ante 429, 5xx y fallas de red. */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== '') qs.set(k, String(v));
    const search = qs.toString();
    const url = `${this.baseUrl}${path}${search ? `?${search}` : ''}`;
    let attempt = 0;
    for (;;) {
      await this.pace();
      this.requests += 1;
      let res: Response;
      try {
        res = await this.doFetch(url, {
          method: 'GET',
          headers: { Authorization: this.authorization, Accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt < Math.min(this.maxRetries, 2)) {
          attempt += 1;
          await this.sleep(2_000 * attempt);
          continue;
        }
        throw new AlegraError(
          'No se pudo conectar con Alegra (la red o el servicio no respondieron). Se reintenta sola en la próxima sincronización.',
          'unavailable',
        );
      }
      const text = await res.text();
      if (res.ok) {
        try {
          return (text ? JSON.parse(text) : null) as T;
        } catch {
          throw new AlegraError('Alegra devolvió una respuesta que no se pudo leer.', 'other');
        }
      }
      const failure = describeFailure(res.status, path);
      if (
        (failure.kind === 'rate' || failure.kind === 'unavailable') &&
        attempt < this.maxRetries
      ) {
        attempt += 1;
        await this.sleep(backoffMs(res.headers, attempt, 'x-rate-limit-reset'));
        continue;
      }
      throw failure;
    }
  }

  /** Una página de un listado: `start` sale del número de página (desde 1). */
  async page<T>(path: string, query: Query, page: number): Promise<AlegraPage<T>> {
    const body = await this.get<{ metadata?: { total?: number | string }; data?: T[] } | T[]>(
      path,
      {
        ...query,
        start: (Math.max(page, 1) - 1) * ALEGRA_PAGE_SIZE,
        limit: ALEGRA_PAGE_SIZE,
        metadata: 'true',
      },
    );
    const results = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
    const rawTotal = Array.isArray(body) ? undefined : body?.metadata?.total;
    const total = rawTotal === undefined || rawTotal === null ? null : Number(rawTotal);
    return {
      page,
      pageSize: ALEGRA_PAGE_SIZE,
      total: Number.isFinite(total) ? total : null,
      results,
    };
  }

  /**
   * «Probar y conectar»: lee un contacto. Con Basic no hay paso de login
   * aparte; si esto responde, el correo y el token sirven y pueden leer datos.
   */
  async verify(): Promise<void> {
    await this.get('/contacts', { start: 0, limit: 1 });
  }
}

/** ¿Hay otra página después de ésta? */
export function alegraHasMore(page: AlegraPage<unknown>): boolean {
  if (page.results.length === 0) return false;
  if (page.total !== null) return page.page * page.pageSize < page.total;
  return page.results.length >= page.pageSize;
}
