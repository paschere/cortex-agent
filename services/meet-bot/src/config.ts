/**
 * Todo lo que el bot de reuniones necesita saber, leído una vez y validado
 * fuerte. Mismo patrón que services/browser y services/whatsapp: un proceso que
 * corre desatendido no puede descubrir a los cuarenta minutos que le faltaba
 * una variable — para. Con una frase que la nombra.
 */

function required(name: string, hint: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(
      `\n[cortex-meet] ${name} no está puesto, así que este servicio no puede arrancar.\n  ${hint}\n`,
    );
    process.exit(1);
  }
  return value;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface Config {
  /** Secreto compartido con Cortex — la misma forma que el browser service. */
  serviceToken: string;
  /** La API key de Deepgram, para STT en vivo y (después) TTS. */
  deepgramKey: string;
  /** A dónde Cortex escucha los avisos de transcript/estado (webhook firmado). */
  cortexBaseUrl: string;
  port: number;
  /** Directorio del perfil por tenant; el volumen de Railway se monta aquí. */
  profilesDir: string;
  /** Techo de reuniones vivas a la vez en este contenedor. */
  maxConcurrent: number;
  /** Idioma del STT. Deepgram usa 'es' para español; nova-2 lo hace bien. */
  sttLanguage: string;
  /** Cuenta de Google dedicada del bot, para auto-login en Railway. */
  googleEmail: string | null;
  googlePassword: string | null;
  /**
   * Proxy residencial. LA pieza que hace que Google Meet acepte al bot desde
   * un datacenter: Meet rebota las IPs de hosting (AWS/GCP/Railway) aunque la
   * sesión sea válida, y la solución estándar de la industria (Recall.ai
   * incluido) es salir por una IP residencial. Formato server:
   * http://host:puerto (o socks5://…). Sin esto, el bot funciona desde una IP
   * residencial (un Mac) pero rebota desde Railway.
   */
  proxyServer: string | null;
  proxyUsername: string | null;
  proxyPassword: string | null;
  /**
   * Cómo entra el bot: 'account' (logueado con la cuenta del workspace, para
   * auto-admisión) o 'guest' (anónimo, solo un nombre, sin login). El guest no
   * tiene cuenta que Google pueda marcar por «actividad sospechosa desde IP
   * nueva», así que a veces entra donde el login rebota — a costa de necesitar
   * que alguien lo admita, o una reunión de acceso abierto. Default: 'account'
   * si hay credenciales o perfil, 'guest' si no.
   */
  mode: 'account' | 'guest';
}

export function loadConfig(): Config {
  return {
    serviceToken: required(
      'MEET_SERVICE_TOKEN',
      'MEET_SERVICE_TOKEN   el secreto compartido, igual que en Cortex',
    ),
    deepgramKey: required(
      'DEEPGRAM_API_KEY',
      'DEEPGRAM_API_KEY     la llave de Deepgram (deepgram.com)',
    ),
    cortexBaseUrl: required(
      'CORTEX_BASE_URL',
      'CORTEX_BASE_URL      el origen https público de Cortex',
    ),
    port: number('PORT', 3400),
    profilesDir: process.env.MEET_PROFILES_DIR?.trim() || '/profiles',
    maxConcurrent: number('MEET_MAX_CONCURRENT', 2),
    sttLanguage: process.env.MEET_STT_LANGUAGE?.trim() || 'es',
    googleEmail: process.env.MEET_GOOGLE_EMAIL?.trim() || null,
    googlePassword: process.env.MEET_GOOGLE_PASSWORD?.trim() || null,
    proxyServer: process.env.MEET_PROXY_SERVER?.trim() || null,
    proxyUsername: process.env.MEET_PROXY_USERNAME?.trim() || null,
    proxyPassword: process.env.MEET_PROXY_PASSWORD?.trim() || null,
    mode: process.env.MEET_MODE?.trim() === 'guest' ? 'guest' : 'account',
  };
}
