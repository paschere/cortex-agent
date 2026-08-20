import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type BrowserContext, chromium } from 'playwright';
// Import circular con browser.ts, y seguro: ninguno usa al otro al evaluar el
// módulo, solo dentro de métodos. BusyError vive allá porque el servidor ya
// sabe traducirlo a 429, y un cupo de perfiles lleno es exactamente ese error.
import { BusyError } from './browser';
import type { Config } from './config';
import { logger } from './logger';
import { LOCATOR_INSTALL_SCRIPT } from './snapshot';

/**
 * El computador del tenant: un perfil Chromium persistente por organización.
 *
 * ===========================================================================
 * POR QUÉ EXISTE
 * ===========================================================================
 * Hasta aquí toda sesión interactiva nacía en un contexto incógnito del
 * Chromium compartido, y eso tiene un costo concreto: el login que una persona
 * hizo a mano en la pestaña viva muere con la sesión. Al día siguiente, el
 * mismo portal, la misma contraseña, el mismo captcha. Un perfil persistente
 * (`chromium.launchPersistentContext` sobre un directorio en el volumen de
 * Railway — la forma viene del openbot de CopilotKit) guarda cookies y
 * localStorage EN DISCO: la sesión iniciada sobrevive a la pestaña, al proceso
 * y al contenedor.
 *
 * Un directorio POR ORGANIZACIÓN, porque el perfil es exactamente el boundary
 * de aislamiento que los contextos incógnitos daban gratis: dos tenants jamás
 * comparten un jar de cookies. Lo que antes garantizaba la memoria ahora lo
 * garantiza el filesystem.
 *
 * ===========================================================================
 * LOS TRÁMITES NO PASAN POR AQUÍ, A PROPÓSITO
 * ===========================================================================
 * `runReplay` sigue en contextos incógnitos. Sus credenciales viajan en cada
 * request y el flujo fue enseñado desde una página sin sesión; replayarlo
 * dentro de un perfil ya logueado cambiaría su semántica — el paso «iniciar
 * sesión» aterrizaría en un portal que ya saltó el login, y cada selector
 * detrás fallaría por una razón que nadie podría ver en la lista de pasos.
 *
 * ===========================================================================
 * EL CUPO ES DE MEMORIA, NO DE DISCO
 * ===========================================================================
 * Cada Chromium persistente es un PROCESO entero (150-300MB); el contenedor
 * está dimensionado en ~1GB. Así que puede haber muchos perfiles en disco pero
 * solo `maxProfiles` abiertos a la vez, con desalojo LRU entre los que no
 * tienen pestañas vivas. Cerrar un perfil NO borra nada: el login queda en el
 * volumen y reabrirlo cuesta un segundo. Borrar de verdad es `reset`, y es
 * otra operación con otro nombre porque es irreversible.
 */

interface OpenProfile {
  context: BrowserContext;
  /** Para el LRU y el sweep. Se toca al pedir el contexto, no al mirarlo. */
  lastUsedAt: number;
}

export class ProfileManager {
  /** Perfiles con su Chromium vivo ahora mismo, por clave saneada. */
  private readonly open = new Map<string, OpenProfile>();
  /**
   * Lanzamientos en vuelo, mismo patrón que `launching` en ensureBrowser: dos
   * openSession simultáneos del mismo tenant deben compartir UN launch, no
   * pelearse por el SingletonLock del mismo directorio.
   */
  private readonly launching = new Map<string, Promise<BrowserContext>>();
  /**
   * Y los lanzamientos de tenants DISTINTOS van en fila india: el cupo se
   * decide mirando `open`, y dos launches corriendo a la vez lo verían
   * desactualizado y lo excederían — 300MB de exceso en una caja de 1GB no es
   * un detalle. Lanzar es raro (una vez por tenant por ciclo de LRU), así que
   * la fila no le cuesta nada a nadie.
   */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    /** El volumen. Quien me construye ya comprobó que la feature está encendida. */
    private readonly root: string,
    private readonly config: Config,
    /**
     * El user-agent llega como supplier y no como valor porque se calcula del
     * Chromium compartido, que puede no haber arrancado aún cuando este
     * manager se construye. Se pregunta en cada launch, cuando ya está tibio.
     */
    private readonly userAgent: () => string | undefined,
  ) {}

  /** Cuántos computadores están encendidos, para /health. */
  size(): number {
    return this.open.size;
  }

  async contextFor(owner: string): Promise<BrowserContext> {
    const key = profileKey(owner);
    const abierto = this.open.get(key);
    if (abierto) {
      abierto.lastUsedAt = Date.now();
      return abierto.context;
    }
    const enVuelo = this.launching.get(key);
    if (enVuelo) return enVuelo;
    const launch = this.enqueue(() => this.launch(key));
    this.launching.set(key, launch);
    try {
      return await launch;
    } finally {
      this.launching.delete(key);
    }
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job);
    // La fila no se envenena: un launch fallido rechaza SU promesa (la que el
    // llamador espera) y la fila sigue limpia para el siguiente tenant.
    this.chain = result.catch(() => undefined);
    return result;
  }

  private async launch(key: string): Promise<BrowserContext> {
    await this.makeRoom();
    const dir = join(this.root, key);
    await mkdir(dir, { recursive: true });
    // Un crash deja SingletonLock/Socket/Cookie huérfanos en el perfil y el
    // siguiente Chromium se niega a arrancar sobre ellos («profile in use»).
    // openbot hace exactamente este barrido antes de cada launch; el lock solo
    // protege contra un proceso concurrente, y la fila india de arriba ya
    // garantiza que no lo hay.
    for (const stale of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      await rm(join(dir, stale), { force: true }).catch(() => undefined);
    }
    const userAgent = this.userAgent();
    const context = await chromium.launchPersistentContext(dir, {
      headless: true,
      // Los mismos args que ensureBrowser (browser.ts documenta cada uno) más
      // --password-store=basic: sin él Chromium cifra las cookies contra el
      // keyring del SO, que en un contenedor recién redeployado es OTRO
      // keyring — y el perfil «persistente» despierta amnésico tras cada
      // restart. Con basic las cookies van ofuscadas pero legibles. No es una
      // pérdida de protección real: el cifrado por keyring dentro de un
      // contenedor es ofuscación de todos modos; el boundary de verdad es
      // quién puede leer el volumen.
      args: [
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--password-store=basic',
      ],
      // Y las mismas opciones de contexto que newContext en browser.ts, por
      // las mismas razones que allá: viewport fijo, identidad coherente de
      // visitante bogotano, certificados estatales vencidos que igual hay que
      // aceptar.
      viewport: { width: this.config.viewportWidth, height: this.config.viewportHeight },
      ...(userAgent ? { userAgent } : {}),
      extraHTTPHeaders: { 'Accept-Language': 'es-CO,es;q=0.9,en;q=0.8' },
      acceptDownloads: true,
      ignoreHTTPSErrors: true,
      locale: 'es-CO',
      timezoneId: 'America/Bogota',
    });
    // Cómo se describe un elemento, instalado antes de que corra documento
    // alguno — igual que en newContext, porque las sesiones que vivan aquí
    // usan los mismos snapshots.
    await context.addInitScript({ content: LOCATOR_INSTALL_SCRIPT });
    // Si el Chromium del perfil muere solo (OOM del renderer, señal), la
    // entrada no puede quedar apuntando a un cadáver: el siguiente contextFor
    // debe relanzar, no repartir páginas de un contexto cerrado.
    context.on('close', () => {
      if (this.open.get(key)?.context === context) this.open.delete(key);
    });
    this.open.set(key, { context, lastUsedAt: Date.now() });
    logger.info({ profile: key, open: this.open.size }, 'perfil persistente abierto');
    return context;
  }

  /**
   * El desalojo LRU. Cierra (NO borra) el perfil menos usado sin pestañas
   * vivas; si todos tienen páginas abiertas, el tenant nuevo recibe el mismo
   * BusyError que el resto de cupos de este servicio — 429, reintenta luego —
   * antes que cerrarle la pestaña a alguien a mitad de un formulario.
   */
  private async makeRoom(): Promise<void> {
    while (this.open.size >= this.config.maxProfiles) {
      let victim: [string, OpenProfile] | null = null;
      for (const entry of this.open) {
        if (entry[1].context.pages().length > 0) continue;
        if (!victim || entry[1].lastUsedAt < victim[1].lastUsedAt) victim = entry;
      }
      if (!victim) throw new BusyError();
      this.open.delete(victim[0]);
      await victim[1].context.close().catch(() => undefined);
      logger.info({ profile: victim[0] }, 'perfil desalojado por el cupo (el disco se conserva)');
    }
  }

  /**
   * El barrendero de perfiles, colgado del sweep de sesiones: un perfil sin
   * pestañas y sin uso reciente es un Chromium entero calentando el rack para
   * nadie. Cerrarlo conserva el login en disco; reabrirlo es barato.
   */
  async sweep(idleMs: number): Promise<void> {
    const cutoff = Date.now() - idleMs;
    for (const [key, entry] of [...this.open]) {
      if (entry.context.pages().length > 0 || entry.lastUsedAt >= cutoff) continue;
      this.open.delete(key);
      await entry.context.close().catch(() => undefined);
      logger.info({ profile: key }, 'perfil persistente cerrado por inactividad');
    }
  }

  /**
   * El «Reset» de openbot: borrar el computador del tenant. Cierra el contexto
   * si está vivo y elimina el directorio entero — cookies, logins, todo — de
   * forma irreversible. Separado de cerrar A PROPÓSITO: cerrar es
   * mantenimiento y conserva el disco; esto es una decisión del dueño.
   */
  async reset(owner: string): Promise<void> {
    const key = profileKey(owner);
    // Un launch a medio camino no puede quedar escribiendo en un directorio
    // que estamos borrando: se espera a que termine (o falle) y luego se poda.
    await this.launching.get(key)?.catch(() => undefined);
    const entry = this.open.get(key);
    if (entry) {
      this.open.delete(key);
      await entry.context.close().catch(() => undefined);
    }
    await rm(join(this.root, key), { recursive: true, force: true });
    logger.warn({ profile: key }, 'perfil persistente BORRADO a pedido del dueño');
  }

  /**
   * Cierre ordenado para el shutdown. Tras cerrar, un settle de ~2s: Chromium
   * escribe las cookies al disco de forma asíncrona al cerrarse, y Railway da
   * una ventana corta tras el SIGTERM antes del SIGKILL — salir en el mismo
   * tick que el close es apostar el login del tenant a una carrera que a veces
   * se pierde. Dos segundos caben en la ventana y compran el flush.
   */
  async closeAll(): Promise<void> {
    const abiertos = [...this.open.values()];
    this.open.clear();
    for (const { context } of abiertos) {
      await context.close().catch(() => undefined);
    }
    if (abiertos.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
}

/**
 * El dueño llega de un header y el directorio se llama como él: sin sanear,
 * `../` en un owner sería un path traversal dentro del volumen. Todo lo que no
 * sea [A-Za-z0-9_-] se aplana a `_`; los ids de organización reales ya viven
 * en ese alfabeto, así que la colisión teórica no tiene caso práctico.
 */
function profileKey(owner: string): string {
  return owner.replace(/[^A-Za-z0-9_-]/g, '_') || '_';
}
