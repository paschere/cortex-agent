import type { ModuleKey } from '@cortex/agent-tools/src/modules/catalog';

/**
 * EL REGISTRO DE AJUSTES: cada cosa que una persona puede configurar, en un
 * solo lugar, dicha en español y organizada por lo que quiere hacer.
 *
 * Por qué existe. Los ajustes de Cortex estaban repartidos en veinte pantallas
 * (datos de la empresa, Sin preguntar, Plan, Conectar Claude, la voz, la
 * privacidad…) y la única forma de dar con uno era saber dónde vivía. /settings
 * es ahora el recibidor: este archivo lista todo, la pantalla lo pinta, y el
 * buscador («Busca un ajuste») lo recorre — incluidos los que viven en otra
 * pantalla, a los que sólo se enlaza.
 *
 * PURO a propósito: sin base de datos, sin React, sin `next/*`. La página de
 * servidor lo filtra por rol y por módulo, el cliente lo busca, y las pruebas
 * corren en Node (incluida la que comprueba que cada `href` sea una ruta real).
 *
 * Para agregar un ajuste: una entrada aquí y, si es un formulario chico que
 * conviene tener a mano, su clave en `inline`. No hace falta tocar la pantalla.
 */

export type SettingsGroupId = 'cuenta' | 'empresa' | 'trabajo' | 'conexiones' | 'ayuda';

export interface SettingsGroup {
  id: SettingsGroupId;
  label: string;
  /** Una frase que dice para qué sirve el grupo. */
  blurb: string;
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'cuenta',
    label: 'Tu cuenta',
    blurb: 'Lo tuyo: cómo ves Cortex, por dónde te escribe y qué recuerda de ti.',
  },
  {
    id: 'empresa',
    label: 'La empresa',
    blurb: 'Cómo está montado el espacio: datos, personas, permisos, plan y privacidad.',
  },
  {
    id: 'trabajo',
    label: 'Cortex trabajando',
    blurb: 'Lo que Cortex hace solo, lo que te pregunta antes y cómo se mide el trabajo.',
  },
  {
    id: 'conexiones',
    label: 'Conexiones',
    blurb: 'De dónde saca Cortex la información y desde dónde se puede usar.',
  },
  {
    id: 'ayuda',
    label: 'Ayuda',
    blurb: 'Para cuando algo no se entiende o no funciona.',
  },
];

/** Quién ve la entrada. `team` = administra o es fundador (ver el equipo entero). */
export type SettingsAccess = 'all' | 'admin' | 'team';

/** Un control pequeño que vive dentro de la tarjeta, sin salir de Ajustes. */
export type SettingsInline =
  | 'perfil'
  | 'apariencia'
  | 'notificaciones'
  | 'correo'
  | 'legales'
  | 'version';

/** Qué dato corto («7 módulos prendidos») acompaña a la entrada, si alguno. */
export type SettingsStateKey =
  | 'perfil'
  | 'notificaciones'
  | 'memoria'
  | 'correo'
  | 'modulos'
  | 'personas'
  | 'mandatos'
  | 'plan'
  | 'conexiones'
  | 'piloto'
  | 'tokens'
  | 'empresa'
  | 'version';

/** Nombre del icono (lucide); el cliente lo resuelve. Un texto, para poder pasarlo de servidor a cliente. */
export type SettingsIconKey =
  | 'user'
  | 'palette'
  | 'bell'
  | 'mic'
  | 'brain'
  | 'mail'
  | 'inbox'
  | 'lock'
  | 'download'
  | 'building'
  | 'brush'
  | 'boxes'
  | 'users'
  | 'users-round'
  | 'badge-check'
  | 'shield'
  | 'chart'
  | 'scroll'
  | 'receipt'
  | 'landmark'
  | 'wallet'
  | 'hard-hat'
  | 'scale'
  | 'plane'
  | 'check-square'
  | 'workflow'
  | 'ruler'
  | 'message'
  | 'sparkles'
  | 'database'
  | 'phone'
  | 'plug'
  | 'wrench'
  | 'server'
  | 'life-buoy'
  | 'send'
  | 'file-text'
  | 'info';

export interface SettingsEntry {
  /** Estable: es la clave del estado, de las anclas y de las pruebas. */
  id: string;
  group: SettingsGroupId;
  title: string;
  /** Una línea, en español de todos los días. */
  description: string;
  /** Cómo lo buscaría alguien: sinónimos, jerga, nombres de producto. Sin tildes da igual. */
  keywords: readonly string[];
  /**
   * A dónde lleva «Abrir». Siempre una ruta de la app (con `?` o `#` si hace
   * falta). Una entrada con control en línea puede llevar además su pantalla
   * completa; una `soon` no lleva ninguna.
   */
  href?: string;
  /** Se abre en otra pestaña (los documentos legales). */
  external?: boolean;
  /** Control propio dentro de la tarjeta. */
  inline?: SettingsInline;
  /**
   * Las partes del control en línea son pesadas (formularios): empiezan
   * plegadas y se abren con «Ajustar». Lo chico se muestra abierto.
   */
  collapsed?: boolean;
  /** Quién la ve. Por omisión, todos. */
  access?: SettingsAccess;
  /** Si el módulo está apagado, la entrada no sale (y se cuenta aparte). */
  module?: ModuleKey;
  /** Aún no existe: se dice con honestidad, sin enlace. */
  soon?: boolean;
  state?: SettingsStateKey;
  icon: SettingsIconKey;
  /** El ancla con la que esta pantalla ya se enlazaba antes (`/settings#correo`). */
  legacyAnchor?: string;
}

export const SETTINGS_REGISTRY: readonly SettingsEntry[] = [
  // ===========================================================================
  // 1. TU CUENTA
  // ===========================================================================
  {
    id: 'perfil',
    group: 'cuenta',
    title: 'Tu perfil',
    description: 'Con qué nombre, correo y papel trabaja Cortex cuando hace algo por ti.',
    keywords: [
      'nombre',
      'correo',
      'email',
      'cuenta',
      'identidad',
      'rol',
      'papel',
      'espacio',
      'perfil',
      'usuario',
    ],
    inline: 'perfil',
    state: 'perfil',
    icon: 'user',
    legacyAnchor: 'cuenta',
  },
  {
    id: 'apariencia',
    group: 'cuenta',
    title: 'Apariencia',
    description: 'Claro, oscuro o el que use tu aparato. Se guarda en este navegador.',
    keywords: [
      'tema',
      'oscuro',
      'claro',
      'modo noche',
      'dark',
      'light',
      'color',
      'pantalla',
      'sistema',
    ],
    inline: 'apariencia',
    icon: 'palette',
  },
  {
    id: 'notificaciones',
    group: 'cuenta',
    title: 'Avisos y resúmenes',
    description:
      'Qué te escribe Cortex sin que se lo pidas, a qué hora, en qué zona horaria y por dónde: correo o Google Chat.',
    keywords: [
      'notificaciones',
      'avisos',
      'alertas',
      'campana',
      'horario',
      'hora',
      'zona horaria',
      'idioma',
      'resumen diario',
      'parte semanal',
      'informe semanal',
      'google chat',
      'webhook',
      'no molestar',
      'silencio',
      'digest',
    ],
    inline: 'notificaciones',
    collapsed: true,
    state: 'notificaciones',
    icon: 'bell',
    legacyAnchor: 'resumen',
  },
  {
    id: 'centro-de-avisos',
    group: 'cuenta',
    title: 'Centro de avisos',
    description: 'Lo urgente de todos tus espacios, en un solo lugar.',
    keywords: ['campana', 'notificaciones', 'avisos', 'bandeja', 'urgente', 'pendientes'],
    href: '/notifications',
    icon: 'bell',
  },
  {
    id: 'voz',
    group: 'cuenta',
    title: 'La voz de Cortex',
    description:
      'Cómo suena Cortex cuando habla en las llamadas; si administras, también una voz propia.',
    keywords: ['voz', 'hablar', 'audio', 'llamadas', 'meet', 'clonar', 'sonido', 'micrófono'],
    href: '/settings/voice',
    icon: 'mic',
  },
  {
    id: 'memoria',
    group: 'cuenta',
    title: 'Lo que Cortex recuerda de ti',
    description:
      'Todo lo que aprendió de cómo trabajas. Lo ves, lo corriges y lo borras cuando quieras.',
    keywords: [
      'memoria',
      'recuerdos',
      'cerebro',
      'aprendido',
      'recordar',
      'borrar',
      'olvidar',
      'preferencias',
    ],
    href: '/settings/memory',
    state: 'memoria',
    icon: 'brain',
    legacyAnchor: 'cerebro',
  },
  {
    id: 'correo',
    group: 'cuenta',
    title: 'Tu correo',
    description:
      'Si Cortex consulta tu buzón y aprende de él, con qué alcance y qué le permites proponer.',
    keywords: [
      'correo',
      'gmail',
      'buzon',
      'email',
      'aprendizaje',
      'aprender',
      'politicas',
      'borradores',
      'seguimiento',
      'google',
      'pausar',
    ],
    inline: 'correo',
    collapsed: true,
    state: 'correo',
    icon: 'mail',
    legacyAnchor: 'correo',
  },
  {
    id: 'correo-revision',
    group: 'cuenta',
    title: 'Revisar lo que aprendió de tu correo',
    description: 'Las propuestas que Cortex sacó de tu buzón. Nada se guarda sin que lo apruebes.',
    keywords: ['propuestas', 'aprobar', 'revisar', 'correo', 'aprendizaje', 'buzon', 'memoria'],
    href: '/settings/mail-learning',
    icon: 'inbox',
  },
  {
    id: 'seguridad-cuenta',
    group: 'cuenta',
    title: 'Seguridad de tu cuenta',
    description:
      'Activa la verificación en dos pasos, mira dónde está abierta tu cuenta y cierra las sesiones que no reconozcas.',
    keywords: [
      '2fa',
      'dos pasos',
      'verificacion',
      'contrasena',
      'password',
      'sesiones',
      'dispositivos',
      'seguridad',
      'autenticador',
    ],
    href: '/settings/seguridad',
    icon: 'lock',
  },
  {
    id: 'tus-datos',
    group: 'cuenta',
    title: 'Tus datos',
    description: 'Descarga lo que Cortex guarda de ti o pide eliminar tu usuario.',
    keywords: [
      'datos personales',
      'descargar',
      'exportar',
      'eliminar',
      'borrar cuenta',
      'privacidad',
      'habeas data',
      'ley 1581',
      'autorizaciones',
      'consulta',
      'reclamo',
    ],
    href: '/settings/privacidad#exportar',
    icon: 'download',
    legacyAnchor: 'privacidad',
  },

  // ===========================================================================
  // 2. LA EMPRESA
  // ===========================================================================
  {
    id: 'datos-empresa',
    group: 'empresa',
    title: 'Datos de la empresa',
    description:
      'Lo que Cortex sabe de ustedes sin que se lo cuenten cada vez: razón social, sedes, quién decide qué.',
    keywords: [
      'empresa',
      'razon social',
      'nit',
      'ficha',
      'sedes',
      'organigrama',
      'quien es quien',
      'datos',
    ],
    href: '/company',
    state: 'empresa',
    icon: 'building',
  },
  {
    id: 'marca',
    group: 'empresa',
    title: 'La marca',
    description: 'Nombre, logo y colores con que se ve la empresa en sus vistas e informes.',
    keywords: [
      'marca',
      'logo',
      'colores',
      'branding',
      'identidad visual',
      'nombre visible',
      'vistas',
    ],
    href: '/company',
    icon: 'brush',
  },
  {
    id: 'modulos',
    group: 'empresa',
    title: 'Módulos',
    description:
      'Qué áreas de Cortex usa la empresa. Lo apagado sale del menú y del chat sin borrar datos.',
    keywords: [
      'modulos',
      'prender',
      'apagar',
      'activar',
      'desactivar',
      'funciones',
      'areas',
      'inventario',
      'nomina',
      'flota',
      'paquetes',
    ],
    href: '/settings/modulos',
    state: 'modulos',
    icon: 'boxes',
  },
  {
    id: 'personas',
    group: 'empresa',
    title: 'Personas',
    description: 'Quién tiene acceso, con qué papel, y a quién invitar o quitar.',
    keywords: [
      'personas',
      'usuarios',
      'invitar',
      'equipo',
      'accesos',
      'roles',
      'admin',
      'administrador',
      'quitar',
      'miembros',
      'cofundador',
      'fundador',
      'propiedad',
    ],
    href: '/admin/users',
    access: 'admin',
    state: 'personas',
    icon: 'users',
  },
  {
    id: 'equipos',
    group: 'empresa',
    title: 'Equipos',
    description: 'Cómo se agrupa la gente y quién lidera cada equipo.',
    keywords: ['equipos', 'grupos', 'areas', 'lideres', 'jefes', 'departamentos'],
    href: '/admin/teams',
    access: 'admin',
    icon: 'users-round',
  },
  {
    id: 'sin-preguntar',
    group: 'empresa',
    title: 'Permisos «Sin preguntar»',
    description:
      'Lo que Cortex puede hacer sin pedirte permiso cada vez, hasta cuándo y con qué tope.',
    keywords: [
      'mandatos',
      'permisos',
      'sin preguntar',
      'autorizar',
      'delegar',
      'aprobar solo',
      'limites',
      'topes',
      'confianza',
    ],
    href: '/admin/mandates',
    access: 'admin',
    state: 'mandatos',
    icon: 'badge-check',
  },
  {
    id: 'seguridad-empresa',
    group: 'empresa',
    title: 'Seguridad de la empresa',
    description: 'Qué se le impidió a Cortex, las reglas que lo frenan y las señales de riesgo.',
    keywords: [
      'seguridad',
      'riesgo',
      'bloqueos',
      'politicas',
      'reglas',
      'amenazas',
      'bloquear',
      'criticas',
    ],
    href: '/admin/security',
    access: 'admin',
    icon: 'shield',
  },
  {
    id: 'uso',
    group: 'empresa',
    title: 'Uso y consumo',
    description: 'Cuánto usa cada persona y cada herramienta, y cuánto cuesta.',
    keywords: ['uso', 'consumo', 'gasto', 'costos', 'tokens', 'cuanto', 'metricas', 'estadisticas'],
    href: '/admin/usage',
    access: 'admin',
    icon: 'chart',
  },
  {
    id: 'auditoria',
    group: 'empresa',
    title: 'Auditoría',
    description: 'El registro de lo que Cortex hizo, quién lo pidió y con qué resultado.',
    keywords: [
      'auditoria',
      'registro',
      'historial',
      'log',
      'bitacora',
      'quien hizo',
      'trazabilidad',
    ],
    href: '/admin/audit',
    access: 'admin',
    icon: 'scroll',
  },
  {
    id: 'plan',
    group: 'empresa',
    title: 'Plan y pagos',
    description: 'Qué plan tienen, cuánto llevan usado, y pagar o cambiar de plan.',
    keywords: [
      'plan',
      'pago',
      'pagos',
      'factura',
      'facturacion',
      'wompi',
      'tarjeta',
      'suscripcion',
      'prueba',
      'precio',
      'consumo',
      'cupo',
      'limites',
      'cancelar',
    ],
    href: '/plan',
    state: 'plan',
    icon: 'receipt',
  },
  {
    id: 'privacidad-empresa',
    group: 'empresa',
    title: 'Privacidad y datos de la empresa',
    description:
      'Descargar todo lo de la empresa, eliminarla, y atender consultas y reclamos con su plazo legal.',
    keywords: [
      'privacidad',
      'exportar',
      'descargar',
      'eliminar empresa',
      'borrar',
      'datos',
      'pqrs',
      'consultas',
      'reclamos',
      'habeas data',
      'ley 1581',
      'tratamiento',
    ],
    href: '/settings/privacidad#eliminar-empresa',
    access: 'admin',
    icon: 'download',
  },
  {
    id: 'perfil-tributario',
    group: 'empresa',
    title: 'Perfil tributario',
    description:
      'Régimen, responsabilidades y obligaciones con las que se arma el calendario de impuestos.',
    keywords: [
      'impuestos',
      'dian',
      'tributario',
      'regimen',
      'iva',
      'renta',
      'retencion',
      'calendario',
      'obligaciones',
      'responsabilidades',
    ],
    href: '/impuestos',
    module: 'taxes',
    icon: 'landmark',
  },
  {
    id: 'ajustes-nomina',
    group: 'empresa',
    title: 'Ajustes de nómina',
    description:
      'Parámetros con los que se liquida la nómina: periodicidad, aportes y prestaciones.',
    keywords: [
      'nomina',
      'salarios',
      'periodicidad',
      'aportes',
      'prestaciones',
      'liquidacion',
      'configuracion de nomina',
      'pila',
    ],
    href: '/nomina?tab=configuracion',
    module: 'payroll',
    icon: 'wallet',
  },
  {
    id: 'ajustes-sst',
    group: 'empresa',
    title: 'Seguridad y salud en el trabajo',
    description: 'El SG-SST: estándares mínimos, plan anual y responsables.',
    keywords: [
      'sst',
      'sg-sst',
      'seguridad y salud',
      'accidentes',
      'riesgos laborales',
      'plan anual',
      'estandares minimos',
    ],
    href: '/sst',
    module: 'sst',
    icon: 'hard-hat',
  },
  {
    id: 'perfil-cumplimiento',
    group: 'empresa',
    title: 'Perfil de cumplimiento',
    description: 'El perfil de la empresa del que salen las obligaciones legales y su calendario.',
    keywords: [
      'cumplimiento',
      'legal',
      'obligaciones',
      'normas',
      'pqrs',
      'perfil legal',
      'compliance',
      'procesos judiciales',
    ],
    href: '/cumplimiento?tab=perfil',
    module: 'compliance',
    icon: 'scale',
  },

  // ===========================================================================
  // 3. CORTEX TRABAJANDO
  // ===========================================================================
  {
    id: 'piloto',
    group: 'trabajo',
    title: 'Piloto automático',
    description:
      'Que Cortex revise y haga cada mañana lo de rutina, con topes y sin salirse de lo permitido.',
    keywords: [
      'piloto',
      'automatico',
      'autopilot',
      'rutina diaria',
      'topes',
      'horario',
      'dias',
      'festivos',
      'solo',
    ],
    href: '/piloto',
    module: 'autopilot',
    state: 'piloto',
    icon: 'plane',
  },
  {
    id: 'aprobaciones',
    group: 'trabajo',
    title: 'Aprobaciones',
    description: 'Lo que Cortex quiere hacer y no hace sin tu permiso: apruébalo o recházalo.',
    keywords: [
      'aprobaciones',
      'pendientes',
      'permiso',
      'aprobar',
      'rechazar',
      'confirmar',
      'preguntar',
    ],
    href: '/approvals',
    icon: 'check-square',
  },
  {
    id: 'procesos',
    group: 'trabajo',
    title: 'Procesos y rutinas',
    description:
      'Lo que Cortex hace solo, a una hora fija o cuando pasa algo; activa uno o descríbele el tuyo.',
    keywords: [
      'procesos',
      'rutinas',
      'repeticiones',
      'programar',
      'automatizar',
      'recurrente',
      'cada semana',
      'cada dia',
      'flujos',
    ],
    href: '/procesos',
    icon: 'workflow',
  },
  {
    id: 'entrevista',
    group: 'trabajo',
    title: 'Cuéntale cómo trabaja tu empresa',
    description:
      'Le explicas tus procesos, te hace unas preguntas y te propone qué vigilar. Nada se crea sin tu visto bueno.',
    keywords: [
      'entrevista',
      'onboarding',
      'contar',
      'procesos',
      'configurar',
      'empezar',
      'guia',
      'inicial',
    ],
    href: '/onboarding/entrevista',
    icon: 'sparkles',
  },
  {
    id: 'medir',
    group: 'trabajo',
    title: 'Qué se mide del equipo',
    description: 'De dónde sale el trabajo del equipo, qué tipos cuentan y quién ve qué.',
    keywords: [
      'medir',
      'metricas',
      'equipo',
      'trabajo',
      'tipos',
      'tablas',
      'productividad',
      'indicadores',
      'quien ve',
    ],
    href: '/team/medir',
    access: 'team',
    module: 'team',
    icon: 'ruler',
  },
  {
    id: 'whatsapp-atencion',
    group: 'trabajo',
    title: 'Atención por WhatsApp',
    description:
      'Que Cortex conteste a tus clientes por WhatsApp con tus datos y te pase lo que no sepa.',
    keywords: [
      'whatsapp',
      'atencion',
      'clientes',
      'responder',
      'pedidos',
      'saldo',
      'soporte',
      'bot',
    ],
    href: '/integrations/whatsapp/atencion',
    module: 'whatsapp_service',
    icon: 'message',
  },

  // ===========================================================================
  // 4. CONEXIONES
  // ===========================================================================
  {
    id: 'conexiones',
    group: 'conexiones',
    title: 'Datos y conexiones',
    description:
      'De dónde saca Cortex lo que sabe: Google, Microsoft, HubSpot, carpetas… y quién conectó cada una.',
    keywords: [
      'integraciones',
      'conectar',
      'google',
      'microsoft',
      'drive',
      'hubspot',
      'fuentes',
      'datos',
      'conexiones',
      'oauth',
      'desconectar',
    ],
    href: '/integrations',
    state: 'conexiones',
    icon: 'database',
  },
  {
    id: 'whatsapp',
    group: 'conexiones',
    title: 'WhatsApp',
    description: 'El número de la empresa, los grupos y de quién es cada teléfono.',
    keywords: ['whatsapp', 'numero', 'telefono', 'grupos', 'vincular', 'qr', 'celular'],
    href: '/integrations/whatsapp',
    icon: 'phone',
  },
  {
    id: 'contables',
    group: 'conexiones',
    title: 'Programas contables',
    description:
      'Conecta Siigo, Alegra o QuickBooks para leer —y, si lo permites, registrar— la contabilidad.',
    keywords: [
      'contabilidad',
      'siigo',
      'alegra',
      'quickbooks',
      'world office',
      'contable',
      'facturacion electronica',
      'erp',
    ],
    href: '/integrations',
    icon: 'plug',
  },
  {
    id: 'mcp-tokens',
    group: 'conexiones',
    title: 'Conectar Claude o ChatGPT',
    description:
      'Usa Cortex desde Claude, ChatGPT o cualquier cliente MCP con tus permisos. Aquí creas y revocas tus llaves.',
    keywords: [
      'claude',
      'chatgpt',
      'mcp',
      'token',
      'llave',
      'api',
      'clave',
      'conectar',
      'cursor',
      'claude code',
    ],
    href: '/mcp-tokens',
    state: 'tokens',
    icon: 'plug',
  },
  {
    id: 'herramientas',
    group: 'conexiones',
    title: 'Herramientas',
    description:
      'Todo lo que Cortex sabe hacer aquí, qué está frenado y por qué; y las herramientas propias que conectes por API.',
    keywords: [
      'herramientas',
      'tools',
      'capacidades',
      'api',
      'propias',
      'personalizadas',
      'permisos',
      'bloqueadas',
      'habilitar',
    ],
    href: '/tools',
    icon: 'wrench',
  },
  {
    id: 'servidores-mcp',
    group: 'conexiones',
    title: 'Servidores MCP de la empresa',
    description:
      'Servidores externos que Cortex puede consultar para traer herramientas y datos de otros sistemas.',
    keywords: ['mcp', 'servidores', 'externos', 'herramientas', 'api', 'protocolo'],
    href: '/integrations#mcp',
    access: 'admin',
    icon: 'server',
  },

  // ===========================================================================
  // 5. AYUDA
  // ===========================================================================
  {
    id: 'centro-de-ayuda',
    group: 'ayuda',
    title: 'Centro de ayuda',
    description: 'Guías cortas, pantalla por pantalla, con buscador.',
    keywords: [
      'ayuda',
      'guias',
      'tutorial',
      'como',
      'preguntas frecuentes',
      'faq',
      'manual',
      'soporte',
    ],
    href: '/ayuda',
    icon: 'life-buoy',
  },
  {
    id: 'soporte',
    group: 'ayuda',
    title: 'Escribir a soporte',
    description:
      'Cuéntanos qué pasó. Te contestamos al correo de tu cuenta y la respuesta queda en Cortex.',
    keywords: [
      'soporte',
      'ayuda',
      'problema',
      'error',
      'falla',
      'contacto',
      'reportar',
      'queja',
      'sugerencia',
      'escribir',
    ],
    href: '/ayuda/soporte',
    icon: 'send',
  },
  {
    id: 'legales',
    group: 'ayuda',
    title: 'Documentos legales',
    description: 'Privacidad, tratamiento de datos, términos y cookies.',
    keywords: [
      'terminos',
      'condiciones',
      'privacidad',
      'cookies',
      'tratamiento de datos',
      'politica',
      'legal',
    ],
    inline: 'legales',
    icon: 'file-text',
  },
  {
    id: 'version',
    group: 'ayuda',
    title: 'Versión de Cortex',
    description: 'Qué versión estás usando. Útil para decirla cuando escribes a soporte.',
    keywords: ['version', 'estado', 'sistema', 'build', 'release', 'actualizacion'],
    inline: 'version',
    state: 'version',
    icon: 'info',
  },
];

// ===========================================================================
// Filtros por rol y por módulo
// ===========================================================================

export interface SettingsViewer {
  /** Administra el espacio (`org_admin`). */
  admin: boolean;
  /** Administra o es fundador: ve al equipo entero. */
  teamManager: boolean;
  /** Módulos prendidos. */
  modulesOn: ReadonlySet<ModuleKey>;
}

export function allowedByRole(
  entry: Pick<SettingsEntry, 'access'>,
  viewer: SettingsViewer,
): boolean {
  const access = entry.access ?? 'all';
  if (access === 'all') return true;
  if (access === 'admin') return viewer.admin;
  return viewer.admin || viewer.teamManager;
}

export interface VisibleSettings {
  entries: SettingsEntry[];
  /** Ajustes que esta persona sí vería, pero su módulo está apagado. */
  hiddenByModule: number;
  /** Ajustes que sólo ve quien administra (para decírselo a quien no). */
  hiddenByRole: number;
}

/**
 * Lo que esta persona ve: primero el rol, después el módulo. Lo que el rol
 * esconde no cuenta como «apagado»: «N ajustes ocultos porque su módulo está
 * apagado» sólo habla de lo que prender el módulo haría aparecer.
 */
export function visibleSettings(
  viewer: SettingsViewer,
  registry: readonly SettingsEntry[] = SETTINGS_REGISTRY,
): VisibleSettings {
  const entries: SettingsEntry[] = [];
  let hiddenByModule = 0;
  let hiddenByRole = 0;
  for (const entry of registry) {
    if (!allowedByRole(entry, viewer)) {
      hiddenByRole += 1;
      continue;
    }
    if (entry.module && !viewer.modulesOn.has(entry.module)) {
      hiddenByModule += 1;
      continue;
    }
    entries.push(entry);
  }
  return { entries, hiddenByModule, hiddenByRole };
}

// ===========================================================================
// Búsqueda
// ===========================================================================

/** Minúsculas y sin tildes: «Nómina», «nomina» y «NÓMINA» son lo mismo. */
export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9ñ\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lo mínimo que la búsqueda necesita de una entrada. */
export interface Searchable {
  title: string;
  description: string;
  keywords: readonly string[];
  group: SettingsGroupId;
}

const GROUP_LABEL = new Map(SETTINGS_GROUPS.map((g) => [g.id, normalize(g.label)]));

/** Pesos: el título manda, luego lo que la gente diría, luego la explicación. */
const W = {
  titleStarts: 12,
  titleWord: 10,
  titleHas: 8,
  keywordExact: 9,
  keywordStarts: 7,
  keywordHas: 5,
  description: 2,
  group: 1,
} as const;

function tokenScore(token: string, entry: Searchable): number {
  const title = normalize(entry.title);
  let best = 0;
  if (title.startsWith(token)) best = Math.max(best, W.titleStarts);
  if (title.split(' ').some((w) => w.startsWith(token))) best = Math.max(best, W.titleWord);
  if (title.includes(token)) best = Math.max(best, W.titleHas);
  for (const raw of entry.keywords) {
    const k = normalize(raw);
    if (k === token) best = Math.max(best, W.keywordExact);
    else if (k.startsWith(token) || k.split(' ').some((w) => w.startsWith(token)))
      best = Math.max(best, W.keywordStarts);
    else if (k.includes(token)) best = Math.max(best, W.keywordHas);
  }
  if (normalize(entry.description).includes(token)) best = Math.max(best, W.description);
  if (GROUP_LABEL.get(entry.group)?.includes(token)) best = Math.max(best, W.group);
  return best;
}

/**
 * Filtra y ordena por relevancia. TODAS las palabras tienen que aparecer en
 * algún lado (título, palabras clave, explicación o grupo): «plan pago» no
 * trae lo que sólo habla de planes. Empate: el orden del registro, que es el
 * orden en que la pantalla las cuenta. Sin consulta, devuelve todo igual.
 */
export function searchSettings<T extends Searchable>(entries: readonly T[], query: string): T[] {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (tokens.length === 0) return [...entries];
  const scored: Array<{ entry: T; score: number; index: number }> = [];
  entries.forEach((entry, index) => {
    let total = 0;
    for (const token of tokens) {
      const s = tokenScore(token, entry);
      if (s === 0) return;
      total += s;
    }
    scored.push({ entry, score: total, index });
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.entry);
}

/** El ancla vieja (`#correo`) → el id de la entrada que ahora la lleva. */
export function entryForAnchor(
  anchor: string,
  registry: readonly SettingsEntry[] = SETTINGS_REGISTRY,
): SettingsEntry | null {
  const clean = anchor.replace(/^#/, '');
  return registry.find((e) => e.id === clean || e.legacyAnchor === clean) ?? null;
}
