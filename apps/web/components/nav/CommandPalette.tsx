'use client';

import { MODULE } from '@/lib/browser-shape';
import { workspaceHref } from '@/lib/workspace-context';
import type { Role } from '@cortex/core';
import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  role?: Role;
}

interface Entry {
  href: string;
  label: string;
  /** One line saying what the destination is. Shown, not just matched. */
  note: string;
  /** Extra words the fuzzy search should match, for pages people rename in their head. */
  keywords: string;
}

interface Section {
  heading: string;
  entries: Entry[];
  adminOnly?: boolean;
}

/**
 * EVERY DESTINATION IN THE PRODUCT, INCLUDING THE ONES THE RAIL DOES NOT SHOW.
 *
 * ESTO Y «TODO» NO SON DOS MANERAS DE LO MISMO, y la diferencia es la que
 * justifica que existan las dos. Aquí se ESCRIBE el nombre de algo que ya sabes
 * cómo se llama, y te saca de donde estás; «Todo», en el rail, ABRE LA LISTA
 * donde estás para señalar con el dedo lo que no sabrías nombrar. Recordar
 * contra reconocer.
 *
 * De ahí que esta lista sea más larga que el rail y no al revés: orquestador,
 * desarrollo, Conectar Claude, aprendizaje, /tools, /agents y /evaluation no
 * están en el menú de todos los días y sólo se alcanzan por aquí o por una
 * puerta en la pantalla donde surge la pregunta.
 * No están escondidos: el rail tiene una fila «Buscar» visible para que esto sea
 * un sitio conocido y no un atajo en la cabeza de alguien.
 *
 * Las palabras clave son lo otro que el rail no puede llevar: nombres viejos
 * («scheduled jobs», «pipelines»), inglés, y lo que la gente teclea de verdad.
 *
 * LOS ENCABEZADOS SE PARECEN A LOS DEL RAIL, NO SON LOS MISMOS, y eso es una
 * deuda anotada aquí a propósito: «Trabajo automático» aquí es «Lo que hago
 * solo» allí. Una taxonomía y media para un producto es peor que una; si algún
 * día se unifica, se unifica contra `lib/nav-shape.ts`, que es donde vive la del
 * rail.
 */
const SECTIONS: Section[] = [
  {
    heading: 'Todos los días',
    entries: [
      {
        href: '/management',
        label: 'Gerencia',
        note: 'Prioridades, responsables y resultados con evidencia',
        keywords: 'gerente empresa hoy gestion operaciones seguimiento procesos',
      },
      {
        href: '/dashboard',
        label: 'Inicio',
        note: 'Lo que se movió mientras no estabas',
        keywords: 'dashboard panel resumen home overview inicio principal',
      },
      {
        href: '/chat',
        label: 'Chat nuevo',
        note: 'Pregúntale a Cortex',
        keywords: 'cortex preguntar nueva conversacion ask consultar',
      },
      {
        href: '/procesos',
        label: 'Procesos',
        note: 'Procesos listos para activar: cobros, guías, resúmenes',
        keywords: 'procesos plantillas automatizar activar autoservicio flujos templates',
      },
      {
        href: '/calls',
        label: 'Llamadas',
        note: 'Las reuniones en las que Cortex está ahora, en vivo',
        keywords: 'llamadas reuniones meet en vivo transcript calls meeting live',
      },
      {
        href: '/approvals',
        label: 'Aprobaciones',
        note: 'Lo que Cortex quiere hacer y necesita tu permiso',
        keywords: 'pendientes confirmar approvals permisos autorizar decidir',
      },
      {
        href: '/actions',
        label: 'Acciones',
        note: 'Lo que ya redactó y falta mandar',
        keywords: 'correos borradores redactados cobros enviar actions drafts',
      },
      {
        href: '/commitments',
        label: 'Vencimientos',
        note: 'Qué se le vence a la empresa y quién responde',
        keywords: 'compromisos fechas vence plazos commitments deadlines polizas',
      },
      {
        href: '/clients',
        label: 'Clientes',
        note: 'Cada empresa y todo lo que Cortex tiene de ella',
        keywords: 'empresas cuentas clients companias contrapartes',
      },
      {
        href: '/ventas',
        label: 'Ventas',
        note: 'Cotizaciones, pedidos y facturas electrónicas',
        keywords: 'cotizaciones cotizar pedidos facturar factura electronica siigo alegra quotes',
      },
      {
        href: '/finance',
        label: 'Finanzas',
        note: 'Resumen financiero, cartera y calidad de las fuentes',
        keywords: 'finanzas financiero caja cartera pagos dinero monedas conciliacion',
      },
      {
        href: '/payments',
        label: 'Cartera',
        note: 'Quién debe, desde cuándo, y qué pagos están en disputa',
        keywords:
          'pagos cartera cobros abonos recaudo facturas payments dso mora vencida siigo alegra quickbooks',
      },
      {
        href: '/pagar',
        label: 'Por pagar',
        note: 'Facturas de proveedor por aprobar y el programa de pagos de la semana',
        keywords:
          'pagar proveedores facturas compras cuentas por pagar aprobar programa pagos retencion cufe dian',
      },
      {
        href: '/feed',
        label: 'Bandeja de archivos',
        note: 'Archivos, enlaces y texto para consultar con Cortex',
        keywords: 'feed subir excel csv archivos enlaces urls consulta temporal',
      },
      {
        href: '/kb',
        label: 'Cerebro',
        note: 'Lo que Cortex memorizó, fragmento por fragmento',
        keywords: 'kb conocimiento documentos cerebro buscar brain search espacios',
      },
      // Not in the rail as a top-level entry — it hangs under Chat as "Todas las
      // conversaciones". Here it gets its full name, because this is where
      // somebody looking for a thread from Google Chat will type.
      {
        href: '/conversations',
        label: 'Conversaciones',
        note: 'El historial completo: chat, Claude, Google Chat y rutinas',
        keywords: 'historial hilos transcripciones history archivo threads gchat mcp',
      },
    ],
  },
  {
    heading: 'Trabajo automático',
    entries: [
      {
        href: '/errands',
        label: 'Encargos',
        note: 'Le pides algo largo; trabaja solo y te pregunta si se atasca',
        keywords: 'errands encargar tarea larga autonomo mandado',
      },
      {
        href: '/pipelines',
        label: 'Flujos',
        note: 'Instructivos que escribes una vez y ejecutas donde quieras',
        keywords: 'pipelines manuales playbooks workflows instructivos plantillas',
      },
      {
        href: '/schedules',
        label: 'Rutinas',
        note: 'Cualquiera de los anteriores, a una hora fija, sin que estés',
        keywords: 'programadas tareas cron routines scheduled jobs horario',
      },
      {
        href: '/activations',
        label: 'Activaciones',
        note: 'Describe un proceso y diseña reglas con evidencia y confirmación',
        keywords:
          'fuentes feed reglas prompt inventario cartera duplicados simulacion activaciones',
      },
      {
        href: '/browser',
        label: MODULE.label,
        note: 'Vueltas en portales ajenos que aprendió viéndote hacerlas',
        keywords: 'browser navegador portales runt simit estado flujos web',
      },
    ],
  },
  {
    heading: 'Seguimiento',
    entries: [
      {
        href: '/goals',
        label: 'Metas',
        note: 'Lo que debería estar pasando, y si está pasando',
        keywords: 'metas goals objetivos kpi umbral cartera dso cumplimiento indicadores',
      },
      {
        href: '/views',
        label: 'Vistas',
        note: 'Tableros, portales y formularios que se piden escribiendo',
        keywords:
          'vistas interfaces tableros dashboard portal formulario pantalla compartir enlace contraseña',
      },
      {
        href: '/reports',
        label: 'Informes',
        note: 'Guardados por mes, congelados tal como se calcularon',
        keywords: 'reports reportes graficos mensual julio pdf',
      },
      {
        href: '/prospects',
        label: 'Prospectos',
        note: 'Prospección comercial: empresas, señales y oportunidades por revisar',
        keywords:
          'outreach growth señales prospectos oportunidades industria comercial ventas clientes',
      },
    ],
  },
  {
    heading: 'Conexiones',
    entries: [
      {
        href: '/integrations',
        label: 'Datos y conexiones',
        note: 'A qué sistemas llega Cortex en tu nombre',
        keywords:
          'integraciones google hubspot slack github linear payroll mcp servers outlook conectar siigo alegra',
      },
      {
        href: '/mcp-tokens',
        label: 'Usar desde Claude o ChatGPT',
        note: 'Preguntarle a Cortex desde el asistente que ya usas',
        keywords: 'claude code chatgpt mcp connector url token oauth conector',
      },
      {
        href: '/integrations/whatsapp',
        label: 'WhatsApp',
        note: 'El número de la empresa y de quién es cada teléfono',
        keywords: 'whatsapp wa numero telefono grupos vincular',
      },
    ],
  },
  {
    // /tools is not in the rail: it is a set-up-once screen reached from where
    // the question comes up (Inicio). /agents moved to «Avanzado», below.
    heading: 'Configuración',
    entries: [
      {
        href: '/tools',
        label: 'Herramientas',
        note: 'Qué sabe hacer Cortex aquí, qué está frenado y por qué',
        keywords: 'tools catalogo permisos bloqueada habilitar capacidades',
      },
      {
        href: '/settings',
        label: 'Configuración',
        note: 'Tus preferencias y por dónde te escribe Cortex',
        keywords: 'ajustes preferencias zona horaria settings memoria perfil',
      },
      {
        href: '/plan',
        label: 'Plan y consumo',
        note: 'Qué incluye tu plan y cuánto llevas usado este mes',
        keywords: 'plan consumo facturacion limites cuota billing precio',
      },
    ],
  },
  {
    // LO QUE MIRA QUIEN MANTIENE CORTEX, NO QUIEN LO USA.
    // Orquestador, desarrollo, aprendizaje, evaluación y agentes son pantallas
    // de quien administra el espacio: a un dueño o a un empleado sin rol de
    // administración sólo le ofrecían palabras que no tenía por qué conocer.
    // Siguen existiendo (y sus páginas no cambian); la paleta sólo deja de
    // ofrecérselas a quien no administra.
    heading: 'Avanzado',
    adminOnly: true,
    entries: [
      {
        href: '/orchestrator',
        label: 'Orquestador',
        note: 'Un objetivo suelto, resuelto por varios subagentes a la vez',
        keywords: 'plan grafo multiagente ejecutar orchestrator subagentes',
      },
      {
        href: '/dev-work',
        label: 'Desarrollo',
        note: 'Cambios que Cortex hace en tu propio software',
        keywords: 'dev work codigo repos github linear tareas tecnicas',
      },
      {
        href: '/learning',
        label: 'Aprendizaje',
        note: 'Qué se ajustó solo, con qué evidencia, y qué esperas decidir',
        keywords: 'learning memoria ajustes aprendio cambios automaticos',
      },
      {
        href: '/evaluation',
        label: 'Evaluación',
        note: 'Si las respuestas mejoraron o empeoraron, con un número',
        keywords: 'evaluation calidad pruebas suite corridas benchmark respuestas',
      },
      {
        href: '/agents',
        label: 'Agentes',
        note: 'Qué agentes existen y a qué herramientas llega cada uno',
        keywords: 'agents bots equipo modelos personas artificiales',
      },
    ],
  },
  {
    heading: 'Administración',
    adminOnly: true,
    entries: [
      {
        href: '/admin/users',
        label: 'Personas',
        note: 'Quién está en la organización y quién sigue activo',
        keywords: 'usuarios users personas miembros invitar',
      },
      {
        href: '/admin/teams',
        label: 'Equipos',
        note: 'Estar en un equipo es lo que da acceso a las herramientas',
        keywords: 'teams equipos grupos permisos',
      },
      {
        href: '/admin/usage',
        label: 'Uso',
        note: 'Cuánta actividad hubo, por día y por herramienta',
        keywords: 'usage consumo actividad estadisticas tokens',
      },
      {
        href: '/admin/audit',
        label: 'Auditoría',
        note: 'Cada llamada, una por una, con quién la pidió y qué pasó',
        keywords: 'audit auditoria registro log llamadas trazabilidad',
      },
      {
        href: '/admin/security',
        label: 'Seguridad',
        note: 'Qué se le impidió hacer al agente, y con qué regla',
        keywords: 'security seguridad bloqueos politicas riesgo',
      },
      {
        href: '/admin/mandates',
        label: 'Sin preguntar',
        note: 'Qué puede hacer Cortex por su cuenta, y hasta cuándo',
        keywords: 'mandatos mandates autonomia delegar permisos confianza sin preguntar firma',
      },
    ],
  },
];

export function CommandPalette({ open, onClose, role }: CommandPaletteProps) {
  const router = useRouter();
  if (!open) return null;

  // The admin screens are server-gated (app/(app)/admin/layout.tsx returns
  // notFound for anyone else), so this is not a permission check — it is there
  // so the palette does not offer five destinations that answer with a 404.
  const sections = SECTIONS.filter((s) => !s.adminOnly || role === 'org_admin');

  const go = (href: string) => {
    const workspaceId = new URL(window.location.href).searchParams.get('workspace');
    router.push(
      workspaceId && ['/finance', '/payments', '/prospects'].includes(href)
        ? workspaceHref(workspaceId, href)
        : href,
    );
    onClose();
  };

  const item = (e: Entry) => (
    <Command.Item
      key={e.href}
      value={`${e.label} ${e.note} ${e.keywords}`}
      onSelect={() => go(e.href)}
      className="cursor-pointer rounded-sm px-3 py-2.5 transition-colors duration-150 aria-selected:bg-primary-soft aria-selected:text-primary-ink hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
    >
      <div className="text-sm font-semibold text-ink">{e.label}</div>
      {/* The same sentence the rail shows for this destination. Two names and
          two descriptions for one screen is what this change is undoing. */}
      <div className="mt-0.5 text-micro leading-snug text-ink-faint">{e.note}</div>
    </Command.Item>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/40 pt-[20vh] backdrop-blur-sm"
      // Close on backdrop click only — comparing target to currentTarget avoids
      // needing a stopPropagation handler on the panel itself.
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      {/* No role="dialog"/aria-modal here: nothing traps focus inside the
          palette, and claiming modality that is not enforced misleads a screen
          reader more than the missing role does. */}
      <div className="w-full max-w-lg px-4">
        {/* A dialog genuinely floats above the page — one of the few places
            elevation is earned. */}
        <Command className="overflow-hidden rounded-card border border-border bg-surface shadow-pop">
          <Command.Input
            aria-label="Buscar un comando"
            placeholder="Escribe a dónde quieres ir…"
            className="w-full border-b border-border bg-transparent px-5 py-4 text-base text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint motion-reduce:transition-none"
          />
          <Command.List className="max-h-[22rem] overflow-y-auto p-2">
            <Command.Empty className="py-4 text-center text-sm text-ink-faint">
              Sin resultados.
            </Command.Empty>
            {sections.map((section) => (
              <Command.Group
                key={section.heading}
                heading={section.heading}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-micro [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-ink-faint"
              >
                {section.entries.map(item)}
              </Command.Group>
            ))}
          </Command.List>
        </Command>
      </div>
    </div>
  );
}
