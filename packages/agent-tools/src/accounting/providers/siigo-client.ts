import {
  type ProviderToken,
  type ProviderTokenStore,
  ProviderUncertainError,
  ProviderValidationError,
} from '../types';

/**
 * EL CLIENTE DE SIIGO API (https://api.siigo.com).
 *
 * Lo que dice la documentación oficial (siigoapi.docs.apiary.io), y por qué
 * este archivo tiene la forma que tiene:
 *
 *   - `POST /auth` con `{ username, access_key }` devuelve `access_token`, que
 *     vale 24 horas. Se manda como `Authorization: Bearer <token>` en todo lo
 *     demás. El token se guarda (cifrado, en la conexión) y se reutiliza hasta
 *     media hora antes de vencer: pedir uno por corrida gasta cupo.
 *   - TODA petición lleva la cabecera `Partner-Id`: el nombre de la aplicación
 *     que integra, de 3 a 100 caracteres alfanuméricos, sin espacios. Sale de
 *     `SIIGO_PARTNER_ID` (por defecto «Cortex»).
 *   - Los listados son páginas: `?page=1&page_size=100` (100 es el máximo) y la
 *     respuesta trae `{ pagination: { page, page_size, total_results }, results }`.
 *   - Límite: 100 peticiones por minuto por empresa en producción, 10 en la
 *     empresa de pruebas. Pasarse da 429 (`requests_limit`). Por eso cada
 *     petición espera su turno (`minIntervalMs`, ~85 por minuto) y un 429 se
 *     reintenta con espera creciente (o la que diga `Retry-After`).
 *   - Siigo recomienda esperar hasta 120 s antes de cortar; los listados
 *     tardan en promedio menos de 2 s. Aquí se corta a los 60 s y se reintenta.
 *
 * Los errores salen en español y sin jerga, listos para la tarjeta de
 * Integraciones y para `last_error`: quien los lee es el administrador, no un
 * programador.
 */

export const SIIGO_BASE_URL = 'https://api.siigo.com';
export const SIIGO_PAGE_SIZE = 100;
const DEFAULT_PARTNER_ID = 'Cortex';
/** Margen antes del vencimiento del token para pedir uno nuevo. */
const TOKEN_MARGIN_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * El Partner-Id que exige Siigo, limpio: sólo letras y números, 3 a 100. Un
 * valor mal escrito en el entorno no tumba la integración: cae al nombre por
 * defecto.
 */
export function siigoPartnerId(raw: string | undefined = process.env.SIIGO_PARTNER_ID): string {
  const clean = (raw ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 100);
  return clean.length >= 3 ? clean : DEFAULT_PARTNER_ID;
}

export type SiigoErrorKind = 'credentials' | 'forbidden' | 'rate' | 'unavailable' | 'other';

export class SiigoError extends Error {
  constructor(
    message: string,
    readonly kind: SiigoErrorKind,
    readonly status: number | null = null,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'SiigoError';
  }
}

/** El token de Siigo (24 h). La conexión lo guarda cifrado entre corridas. */
export type SiigoToken = ProviderToken;

export interface SiigoClientOptions {
  username: string;
  accessKey: string;
  partnerId?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  tokenStore?: ProviderTokenStore;
  /** Espera mínima entre peticiones. 700 ms ≈ 85 por minuto. */
  minIntervalMs?: number;
  /** Reintentos ante 429 / 5xx / red. */
  maxRetries?: number;
  timeoutMs?: number;
}

export interface SiigoPage<T> {
  page: number;
  pageSize: number;
  total: number;
  results: T[];
}

type Query = Record<string, string | number | undefined>;

interface SiigoErrorBody {
  Status?: number;
  Errors?: Array<{ Code?: string; Message?: string }>;
  errors?: Array<{ code?: string; message?: string }>;
}

function errorCode(body: unknown): string | null {
  const b = body as SiigoErrorBody | null;
  return b?.Errors?.[0]?.Code ?? b?.errors?.[0]?.code ?? null;
}

const CREDENTIALS_MESSAGE =
  'Siigo no aceptó el usuario API o la access key. Revísalos en Siigo Nube → Alianzas → Mi credencial API y vuelve a conectar.';

function describeFailure(status: number, code: string | null, path: string): SiigoError {
  if (status === 401)
    return new SiigoError(
      path === '/auth'
        ? CREDENTIALS_MESSAGE
        : 'Siigo rechazó la sesión. Puede que la access key haya cambiado o que el usuario esté bloqueado: vuelve a conectar.',
      'credentials',
      status,
      code,
    );
  if (status === 403)
    return new SiigoError(
      'Ese usuario de Siigo no tiene permiso para consultar esta información. Pide en Siigo que le den acceso a la API.',
      'forbidden',
      status,
      code,
    );
  if (status === 429)
    return new SiigoError(
      'Siigo pidió bajar el ritmo (límite de peticiones por minuto). Se reintenta sola en la próxima sincronización.',
      'rate',
      status,
      code,
    );
  if (status >= 500)
    return new SiigoError(
      'Siigo no está respondiendo en este momento. Se reintenta sola en la próxima sincronización.',
      'unavailable',
      status,
      code,
    );
  if (path === '/auth' && status === 400)
    return new SiigoError(CREDENTIALS_MESSAGE, 'credentials', status, code);
  return new SiigoError(
    `Siigo respondió con un error (${status}${code ? `, ${code}` : ''}) al consultar ${path}.`,
    'other',
    status,
    code,
  );
}

function isRetryable(err: SiigoError): boolean {
  return err.kind === 'rate' || err.kind === 'unavailable';
}

export class SiigoClient {
  private token: SiigoToken | null = null;
  private lastRequestAt = 0;
  /** Cuántas peticiones HTTP se hicieron (para el registro de la corrida). */
  requests = 0;

  private readonly baseUrl: string;
  private readonly partnerId: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: SiigoClientOptions) {
    this.baseUrl = (opts.baseUrl ?? SIIGO_BASE_URL).replace(/\/+$/, '');
    this.partnerId = siigoPartnerId(opts.partnerId);
    this.doFetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
    this.minIntervalMs = opts.minIntervalMs ?? 700;
    this.maxRetries = opts.maxRetries ?? 4;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  /** El turno de cada petición: nunca más rápido que el límite de Siigo. */
  private async pace(): Promise<void> {
    const wait = this.lastRequestAt + this.minIntervalMs - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  /** Una petición, con reintentos ante 429, 5xx y fallas de red. */
  private async send(path: string, init: RequestInit): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      await this.pace();
      this.requests += 1;
      let res: Response;
      try {
        res = await this.doFetch(`${this.baseUrl}${path}`, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        if (attempt < Math.min(this.maxRetries, 2)) {
          attempt += 1;
          await this.sleep(2_000 * attempt);
          continue;
        }
        throw new SiigoError(
          'No se pudo conectar con Siigo (la red o el servicio no respondieron). Se reintenta sola en la próxima sincronización.',
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
      if (res.ok) return body;

      const failure = describeFailure(res.status, errorCode(body), path.split('?')[0] ?? path);
      if (isRetryable(failure) && attempt < this.maxRetries) {
        attempt += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff =
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 120_000)
            : Math.min(5_000 * 2 ** (attempt - 1), 60_000);
        await this.sleep(backoff);
        continue;
      }
      throw failure;
    }
  }

  /** Pide un token nuevo, o devuelve el vigente (de memoria o del almacén). */
  async authenticate(force = false): Promise<string> {
    const fresh = (t: SiigoToken | null) => t && t.expiresAt - this.now() > TOKEN_MARGIN_MS;
    if (!force && fresh(this.token)) return (this.token as SiigoToken).token;
    if (!force && this.opts.tokenStore) {
      const stored = await this.opts.tokenStore.load().catch(() => null);
      if (fresh(stored)) {
        this.token = stored;
        return (stored as SiigoToken).token;
      }
    }
    const body = (await this.send('/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Partner-Id': this.partnerId },
      body: JSON.stringify({ username: this.opts.username, access_key: this.opts.accessKey }),
    })) as { access_token?: string; expires_in?: number } | null;
    const token = body?.access_token;
    if (!token) throw new SiigoError(CREDENTIALS_MESSAGE, 'credentials');
    // La documentación dice 86400 «milisegundos», que son en realidad segundos
    // (24 horas). Si algún día llega en milisegundos, se nota por el tamaño.
    let seconds = Number(body?.expires_in) || 86_400;
    if (seconds > 7 * 86_400) seconds = seconds / 1000;
    const expiresAt = this.now() + Math.min(seconds * 1000, DAY_MS);
    this.token = { token, expiresAt };
    await this.opts.tokenStore?.save(this.token).catch(() => undefined);
    return token;
  }

  /** GET autenticado. Un 401 con un token guardado pide uno nuevo una vez. */
  async get<T>(path: string, query: Query = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query))
      if (v !== undefined && v !== '') qs.set(k, String(v));
    const search = qs.toString();
    const url = search ? `${path}?${search}` : path;
    const call = async (token: string) =>
      (await this.send(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Partner-Id': this.partnerId,
          'Content-Type': 'application/json',
        },
      })) as T;
    const token = await this.authenticate();
    try {
      return await call(token);
    } catch (err) {
      // Un token guardado que Siigo ya no reconoce: uno nuevo, una sola vez.
      if (err instanceof SiigoError && err.status === 401)
        return call(await this.authenticate(true));
      throw err;
    }
  }

  /** Una página de un listado. */
  async page<T>(path: string, query: Query, page: number, pageSize = SIIGO_PAGE_SIZE) {
    const body = await this.get<{
      pagination?: { page?: number; page_size?: number; total_results?: number };
      results?: T[];
    }>(path, { ...query, page, page_size: Math.min(pageSize, SIIGO_PAGE_SIZE) });
    const results = Array.isArray(body?.results) ? body.results : [];
    return {
      page,
      pageSize: Math.min(pageSize, SIIGO_PAGE_SIZE),
      total: Number(body?.pagination?.total_results ?? results.length) || 0,
      results,
    } satisfies SiigoPage<T>;
  }

  /** Todas las páginas de un listado, una tras otra, desde `startPage`. */
  async *pages<T>(
    path: string,
    query: Query,
    opts: { startPage?: number; pageSize?: number; maxPages?: number } = {},
  ): AsyncGenerator<SiigoPage<T>> {
    const pageSize = Math.min(opts.pageSize ?? SIIGO_PAGE_SIZE, SIIGO_PAGE_SIZE);
    const maxPages = opts.maxPages ?? 2_000;
    let page = opts.startPage ?? 1;
    for (let n = 0; n < maxPages; n++) {
      const current = await this.page<T>(path, query, page, pageSize);
      yield current;
      if (!hasMorePages(current)) return;
      page += 1;
    }
  }

  /**
   * POST autenticado (migración 0182: la factura de venta). A diferencia de
   * `get`, NO reintenta ante una falla de red ni un 5xx: la factura pudo haber
   * quedado creada y una segunda petición sería una segunda factura. Sólo un
   * 429 (Siigo rechaza ANTES de procesar) espera y repite. La cabecera
   * `Idempotency-Key` (alfanumérica, máximo 30) hace que Siigo devuelva la
   * misma factura si la misma llave llega dos veces.
   *
   * Un 400/422 sale como `ProviderValidationError` con el porqué en español;
   * una red cortada o un 5xx, como `ProviderUncertainError` («no sé si llegó»).
   */
  async post<T>(path: string, body: unknown, opts: { idempotencyKey?: string } = {}): Promise<T> {
    const token = await this.authenticate();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Partner-Id': this.partnerId,
      'Content-Type': 'application/json',
    };
    const key = (opts.idempotencyKey ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 30);
    if (key) headers['Idempotency-Key'] = key;
    let attempt = 0;
    let refreshed = false;
    for (;;) {
      await this.pace();
      this.requests += 1;
      let res: Response;
      try {
        res = await this.doFetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs * 2),
        });
      } catch {
        throw new ProviderUncertainError(
          'La conexión con Siigo se cortó mientras se enviaba la factura: no se sabe si quedó creada. Revisa en Siigo antes de volver a intentarlo (si se reintenta desde Cortex, Siigo reconoce la misma factura y no la duplica).',
        );
      }
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (res.ok) return parsed as T;
      // Un token guardado que Siigo ya no reconoce: no se procesó nada, así
      // que pedir uno nuevo y repetir una vez es seguro.
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        headers.Authorization = `Bearer ${await this.authenticate(true)}`;
        continue;
      }
      if (res.status === 429 && attempt < this.maxRetries) {
        attempt += 1;
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(retryAfter * 1000, 120_000)
            : Math.min(5_000 * 2 ** (attempt - 1), 60_000),
        );
        continue;
      }
      if (res.status === 400 || res.status === 422 || res.status === 409)
        throw describeSiigoValidation(parsed, res.status);
      if (res.status >= 500)
        throw new ProviderUncertainError(
          `Siigo respondió con un error interno (${res.status}) al recibir la factura: no se sabe si quedó creada. Revisa en Siigo antes de volver a intentarlo.`,
        );
      throw describeFailure(res.status, errorCode(parsed), path);
    }
  }

  /**
   * «Probar y conectar»: pide un token y lee una sola fila de clientes. Si las
   * dos cosas funcionan, la llave sirve y el usuario puede leer datos.
   */
  async verify(): Promise<{ token: SiigoToken }> {
    await this.authenticate(true);
    await this.get('/v1/customers', { page: 1, page_size: 1 });
    return { token: this.token as SiigoToken };
  }
}

/**
 * Lo que Siigo dijo de una factura que no aceptó, en español. La respuesta
 * oficial es `{ Status, Errors: [{ Code, Message, Params, Detail }] }`; cada
 * error se traduce por el campo que nombra (`Params`) y su código, y si no se
 * reconoce se deja el mensaje de Siigo entre comillas: mejor un mensaje en
 * inglés que uno inventado.
 */
export function describeSiigoValidation(body: unknown, status: number): ProviderValidationError {
  const b = body as {
    Errors?: Array<{ Code?: string; Message?: string; Params?: string[] }>;
    errors?: Array<{ code?: string; message?: string; params?: string[] }>;
  } | null;
  const raw = (b?.Errors ?? []).map((e) => ({
    code: e.Code ?? '',
    message: e.Message ?? '',
    params: e.Params ?? [],
  }));
  for (const e of b?.errors ?? [])
    raw.push({ code: e.code ?? '', message: e.message ?? '', params: e.params ?? [] });
  const reasons = raw.map(({ code, message, params }) => {
    const where = `${params.join(' ')} ${message}`.toLowerCase();
    if (/customer|identification|cliente/.test(where))
      return 'el cliente no existe en Siigo con ese NIT (créalo en Siigo o corrige el NIT)';
    if (/items?\.?code|product|producto/.test(where))
      return 'uno de los productos no existe en Siigo (cada línea tiene que tener un producto de Siigo)';
    if (/payment|pago/.test(where))
      return 'la forma de pago no sirve o su valor no coincide con el total de la factura';
    if (/seller|vendedor/.test(where)) return 'falta el vendedor o no existe en Siigo';
    if (/document|consecutive|numbering|resolution/.test(where))
      return 'el tipo de documento de factura no está bien configurado en Siigo (revisa la resolución de facturación)';
    if (/tax|impuesto/.test(where))
      return 'un impuesto de la factura no existe o no aplica en Siigo';
    if (/cost_center/.test(where)) return 'el tipo de documento exige centro de costo';
    if (/date|fecha/.test(where)) return 'la fecha de la factura no es válida para Siigo';
    if (code === 'already_exists') return 'Siigo dice que esa factura ya existe';
    return message ? `Siigo dijo: «${message.slice(0, 200)}»` : `error ${code || status}`;
  });
  const unique = [...new Set(reasons)];
  return new ProviderValidationError(
    unique.length
      ? `Siigo no aceptó la factura: ${unique.join('; ')}.`
      : `Siigo no aceptó la factura (error ${status}) y no dijo por qué.`,
    raw.map((r) => `${r.code}: ${r.message}`.slice(0, 300)),
    status,
  );
}

/** ¿Hay otra página después de ésta? */
export function hasMorePages(page: SiigoPage<unknown>): boolean {
  if (page.results.length === 0) return false;
  return page.page * page.pageSize < page.total;
}
