import { SOURCES, type SourceId } from '@/lib/self-service/catalog';

/**
 * «CONECTA ALGO NUEVO», AGRUPADO POR LO QUE LA GENTE QUIERE.
 *
 * Nadie llega pensando «quiero un OAuth» o «quiero un MCP»: llega pensando
 * «quiero que Cortex vea mi correo», «mi contabilidad», «la carpeta donde el
 * agente de carga deja las guías». Cada grupo es una de esas frases y cada
 * tarjeta termina en el flujo que ya existe —el permiso de Google, la tarjeta
 * del programa contable, la importación del extracto, el chat con la petición
 * escrita, el asistente de API—, así que sumar una opción es sumar una entrada
 * aquí, no una pantalla.
 *
 * Puro y serializable (los iconos van por nombre): lo arma la página y lo
 * dibuja `components/sources/ConnectCatalog`, igual en el fixture de /v.
 */

export type CatalogIcon =
  | 'google'
  | 'outlook'
  | 'calculator'
  | 'bank'
  | 'folder'
  | 'upload'
  | 'brain'
  | 'sheet'
  | 'camera'
  | 'whatsapp'
  | 'api'
  | 'crm'
  | 'chat'
  | 'tags'
  | 'github'
  | 'linear'
  | 'tools'
  | 'server'
  | 'key';

export type CatalogTone = 'primary' | 'emerald' | 'amber' | 'rose' | 'sky' | 'neutral';

export type CatalogAction =
  /** A una ruta, al permiso de un proveedor (`external`: recarga completa) o a un ancla. */
  | { type: 'link'; href: string; label: string; external?: boolean }
  /** Pide un enlace y abre el chat con la petición escrita (`{url}` se reemplaza). */
  | {
      type: 'url';
      label: string;
      fieldLabel: string;
      placeholder: string;
      pattern: string;
      prompt: string;
      needsGoogle: boolean;
    }
  /** No se puede desde aquí: la frase dice a quién pedírselo. */
  | { type: 'none'; label: string };

export interface CatalogItem {
  id: string;
  title: string;
  body: string;
  icon: CatalogIcon;
  tone: CatalogTone;
  /** Una píldora: «Conectada», «2 cuentas». */
  badge: { label: string; tone: 'emerald' | 'amber' | 'neutral' } | null;
  action: CatalogAction;
}

export interface CatalogGroup {
  id: string;
  title: string;
  hint: string;
  items: CatalogItem[];
  /** Plegado al abrir: lo técnico no compite con lo de todos los días. */
  folded?: boolean;
  /** Un hueco para algo que dibuja el servidor (la sección de programas contables). */
  slot?: 'accounting';
}

export interface CatalogState {
  googleConnected: boolean;
  microsoftConnected: boolean;
  microsoftConfigured: boolean;
  hubspot: 'workspace' | 'mine' | 'none';
  github: boolean;
  linear: boolean;
  whatsapp: 'on' | 'pairing' | 'off';
  bankAccounts: number;
  mcpServers: number;
}

function fromSelfService(id: SourceId) {
  const option = SOURCES.find((s) => s.id === id);
  if (!option?.needsUrl || 'href' in option.go) throw new Error(`La fuente ${id} no pide enlace`);
  return {
    type: 'url' as const,
    label: option.cta,
    fieldLabel: option.needsUrl.label,
    placeholder: option.needsUrl.placeholder,
    pattern: option.needsUrl.pattern.source,
    prompt: option.go.prompt('{url}'),
    needsGoogle: !!option.needsGoogle,
  };
}

const CONNECTED = { label: 'Conectada', tone: 'emerald' as const };

const chat = (prompt: string) => `/chat?prompt=${encodeURIComponent(prompt)}`;

export function buildCatalog(s: CatalogState): CatalogGroup[] {
  return [
    {
      id: 'correo-y-calendario',
      title: 'Correo y calendario',
      hint: 'Cada persona conecta su propia cuenta. Nadie ve el correo de otro.',
      items: [
        {
          id: 'google',
          title: 'Google Workspace',
          body: 'Gmail, Calendar, Drive y Sheets: tu correo y tu agenda, tus archivos y las notas de Meet.',
          icon: 'google',
          tone: 'rose',
          badge: s.googleConnected ? CONNECTED : null,
          action: {
            type: 'link',
            href: '/api/integrations/google?preset=all',
            label: s.googleConnected ? 'Revisar permisos' : 'Conectar Google',
            external: true,
          },
        },
        {
          id: 'microsoft',
          title: 'Microsoft 365',
          body: 'Outlook y su calendario: leer y buscar correo, dejar borradores, ver y crear eventos.',
          icon: 'outlook',
          tone: 'sky',
          badge: s.microsoftConnected ? CONNECTED : null,
          action: s.microsoftConnected
            ? { type: 'none', label: 'Ya está conectada' }
            : s.microsoftConfigured
              ? {
                  type: 'link',
                  href: '/api/integrations/microsoft?preset=all',
                  label: 'Conectar Outlook',
                  external: true,
                }
              : { type: 'none', label: 'Pídesela al equipo de Cortex' },
        },
      ],
    },
    {
      id: 'programas-contables-grupo',
      title: 'Programa contable',
      hint: 'Conéctalo una vez y Cortex trae solo clientes, productos, facturas y pagos a tablas.',
      slot: 'accounting',
      items: [
        {
          id: 'other-accounting',
          title: 'Otro programa contable',
          body: 'World Office, Helisa o el que uses: exporta el archivo y súbelo. Cortex lo lee y te propone la tabla.',
          icon: 'upload',
          tone: 'amber',
          badge: null,
          action: { type: 'link', href: '/feed?mode=file', label: 'Subir el archivo' },
        },
      ],
    },
    {
      id: 'banco',
      title: 'Banco',
      hint: 'Los movimientos de tus cuentas, para saber qué factura pagó cada abono.',
      items: [
        {
          id: 'bank-statement',
          title: 'Extracto del banco',
          body: 'Descarga el extracto (Excel, CSV o PDF) e impórtalo: Cortex ata cada abono con su factura y lo que no cuadra queda a la vista.',
          icon: 'bank',
          tone: 'emerald',
          badge:
            s.bankAccounts > 0
              ? {
                  label: `${s.bankAccounts} ${s.bankAccounts === 1 ? 'cuenta' : 'cuentas'}`,
                  tone: 'emerald',
                }
              : null,
          action: { type: 'link', href: '/payments#extractos', label: 'Importar extracto' },
        },
      ],
    },
    {
      id: 'archivos-y-carpetas',
      title: 'Archivos y carpetas',
      hint: 'Lo que vive en documentos: facturas, guías, contratos, manuales.',
      items: [
        {
          id: 'drive-folder',
          title: 'Carpeta de Drive → tabla',
          body: 'Cada archivo nuevo de la carpeta (PDF, Word, Excel) se vuelve una fila de una tabla, solo.',
          icon: 'folder',
          tone: 'primary',
          badge: null,
          action: fromSelfService('drive'),
        },
        {
          id: 'upload',
          title: 'Subir archivos para consultar',
          body: 'PDF, Word, Excel o CSV para preguntarle a Cortex ya. Quedan en tu bandeja, privados, siete días.',
          icon: 'upload',
          tone: 'neutral',
          badge: null,
          action: { type: 'link', href: '/feed', label: 'Abrir la bandeja' },
        },
        {
          id: 'brain',
          title: 'Documentos de la empresa',
          body: 'Manuales, políticas y contratos que Cortex debe recordar siempre. Van al cerebro, con los permisos de cada espacio.',
          icon: 'brain',
          tone: 'primary',
          badge: null,
          action: { type: 'link', href: '/kb', label: 'Abrir el cerebro' },
        },
        {
          id: 'classify',
          title: 'Usar documentos en las cifras',
          body: 'Decide si un documento que Cortex ya leyó es administrativo, financiero, comercial u operativo.',
          icon: 'tags',
          tone: 'neutral',
          badge: null,
          action: { type: 'link', href: '/finance#sources', label: 'Clasificar documentos' },
        },
      ],
    },
    {
      id: 'hojas-de-calculo',
      title: 'Hojas de cálculo',
      hint: 'Google Sheets o un Excel publicado: la tabla se mantiene al día con la hoja.',
      items: [
        {
          id: 'sheet',
          title: 'Hoja sincronizada → tabla',
          body: 'Cortex lee la hoja, te propone las columnas y la mantiene sincronizada: lo que cambie en la hoja llega a la tabla.',
          icon: 'sheet',
          tone: 'emerald',
          badge: null,
          action: fromSelfService('sheet'),
        },
        {
          id: 'sheet-snapshot',
          title: 'Captura de una hoja',
          body: 'Una foto de la hoja en tu bandeja para consultarla ahora; la actualizas cuando quieras.',
          icon: 'camera',
          tone: 'neutral',
          badge: null,
          action: { type: 'link', href: '/feed?mode=url', label: 'Pegar el enlace' },
        },
      ],
    },
    {
      id: 'whatsapp',
      title: 'WhatsApp',
      hint: 'El número dedicado de la empresa: conversar con Cortex y guardar grupos en el cerebro.',
      items: [
        {
          id: 'whatsapp',
          title: 'WhatsApp de la empresa',
          body: 'Escríbele a Cortex desde el teléfono y elige qué grupos entran al cerebro, con quién dijo qué y cuándo.',
          icon: 'whatsapp',
          tone: 'emerald',
          badge:
            s.whatsapp === 'on'
              ? CONNECTED
              : s.whatsapp === 'pairing'
                ? { label: 'Emparejando', tone: 'amber' }
                : null,
          action: {
            type: 'link',
            href: '/integrations/whatsapp',
            label: s.whatsapp === 'on' ? 'Configurar' : 'Emparejar el número',
          },
        },
      ],
    },
    {
      id: 'otro-sistema',
      title: 'Otro sistema o API',
      hint: 'Tu ERP, el inventario, el CRM: si tiene API, se conecta; si no, se lo cuentas a Cortex.',
      items: [
        {
          id: 'api',
          title: 'Conectar una API',
          body: 'Pega la dirección de tu sistema; Cortex prueba la conexión y te muestra lo que trae antes de guardar nada.',
          icon: 'api',
          tone: 'primary',
          badge: null,
          action: { type: 'link', href: '/feed?mode=api', label: 'Conectar' },
        },
        {
          id: 'hubspot',
          title: 'HubSpot',
          body: 'Negocios, empresas, contactos y cómo va el embudo de ventas.',
          icon: 'crm',
          tone: 'amber',
          badge:
            s.hubspot === 'workspace'
              ? { label: 'Toda la empresa', tone: 'emerald' }
              : s.hubspot === 'mine'
                ? CONNECTED
                : null,
          action:
            s.hubspot === 'none'
              ? {
                  type: 'link',
                  href: '/api/integrations/hubspot',
                  label: 'Conectar HubSpot',
                  external: true,
                }
              : { type: 'none', label: 'Ya está conectada' },
        },
        {
          id: 'tell',
          title: 'Cuéntaselo a Cortex',
          body: '¿Usas un programa que no está aquí? Dile cuál es y te explica cómo traerlo.',
          icon: 'chat',
          tone: 'neutral',
          badge: null,
          action: {
            type: 'link',
            href: chat('Quiero conectar otro programa que uso en mi empresa: '),
            label: 'Contárselo',
          },
        },
      ],
    },
    {
      id: 'desarrolladores',
      title: 'Herramientas para desarrolladores',
      hint: 'Para equipos técnicos. Casi nadie lo necesita.',
      folded: true,
      items: [
        {
          id: 'custom-tools',
          title: 'Acciones sobre tu API',
          body: 'Define acciones (crear un pedido, consultar inventario) con la documentación de tu API.',
          icon: 'tools',
          tone: 'neutral',
          badge: null,
          action: { type: 'link', href: '/tools#custom-tools', label: 'Crear herramientas' },
        },
        {
          id: 'mcp',
          title: 'Servidor MCP',
          body: 'Suma las herramientas de un servidor compatible (Notion, uno propio) a tu cuenta.',
          icon: 'server',
          tone: 'neutral',
          badge:
            s.mcpServers > 0
              ? {
                  label: `${s.mcpServers} ${s.mcpServers === 1 ? 'servidor' : 'servidores'}`,
                  tone: 'emerald',
                }
              : null,
          action: { type: 'link', href: '#mcp', label: 'Configurar MCP' },
        },
        {
          id: 'mcp-tokens',
          title: 'Usar Cortex desde Claude o ChatGPT',
          body: 'El camino contrario: preguntarle a Cortex desde otro asistente con un token personal.',
          icon: 'key',
          tone: 'neutral',
          badge: null,
          action: { type: 'link', href: '/mcp-tokens', label: 'Crear un token' },
        },
        {
          id: 'github',
          title: 'GitHub',
          body: 'Repositorios, issues, pull requests y actividad de ingeniería.',
          icon: 'github',
          tone: 'neutral',
          badge: s.github ? CONNECTED : null,
          action: s.github
            ? { type: 'none', label: 'Ya está conectada' }
            : { type: 'none', label: 'La habilita el equipo de Cortex' },
        },
        {
          id: 'linear',
          title: 'Linear',
          body: 'Proyectos, ciclos, issues y la carga del equipo.',
          icon: 'linear',
          tone: 'neutral',
          badge: s.linear ? CONNECTED : null,
          action: s.linear
            ? { type: 'none', label: 'Ya está conectada' }
            : { type: 'none', label: 'La habilita el equipo de Cortex' },
        },
      ],
    },
  ];
}

/** El enlace pegado dentro de la petición, recortado a lo que cabe en una URL. */
export function promptFor(template: string, url: string): string {
  return template.replace('{url}', url.trim()).slice(0, 4000);
}
