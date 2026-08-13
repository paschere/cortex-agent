'use client';

import { MODULE } from '@/lib/browser-shape';
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
 * This list is the other half of the sidebar's shortening. The rail carries the
 * daily work and four collapsed groups; four destinations are not on it at all
 * (/conversations, /tools, /agents, /evaluation). Those are not hidden — they
 * are HERE, and the rail now has a visible "Buscar" row so that this is a place
 * people know about rather than a shortcut in somebody's head.
 *
 * The headings mirror the rail's groups on purpose. Somebody who learns "Rutinas
 * lives under Trabajo automático" should find the same shelf in both places; two
 * different taxonomies for one product is the problem this change is undoing,
 * not a second chance to invent one.
 *
 * Notes are the same sentences the rail shows, because the same thing should not
 * be described two ways. Keywords carry what the rail cannot: old names
 * ("scheduled jobs", "pipelines"), English, and the words people actually type.
 */
const SECTIONS: Section[] = [
  {
    heading: 'Todos los días',
    entries: [
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
        href: '/payments',
        label: 'Cartera',
        note: 'Quién debe, desde cuándo, y qué pagos están en disputa',
        keywords: 'pagos cartera cobros abonos recaudo facturas payments dso mora vencida siigo',
      },
      {
        href: '/kb',
        label: 'Brain Knowledge',
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
        href: '/orchestrator',
        label: 'Orquestador',
        note: 'Un objetivo suelto, resuelto por varios subagentes a la vez',
        keywords: 'plan grafo multiagente ejecutar orchestrator subagentes',
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
        href: '/browser',
        label: MODULE.label,
        note: 'Vueltas en portales ajenos que aprendió viéndote hacerlas',
        keywords: 'browser navegador portales runt simit estado flujos web',
      },
      {
        href: '/dev-work',
        label: 'Desarrollo',
        note: 'Cambios que Cortex hace en tu propio software',
        keywords: 'dev work codigo repos github linear tareas tecnicas',
      },
    ],
  },
  {
    heading: 'Seguimiento',
    entries: [
      {
        href: '/reports',
        label: 'Informes',
        note: 'Guardados por mes, congelados tal como se calcularon',
        keywords: 'reports reportes graficos mensual julio pdf',
      },
      {
        href: '/prospects',
        label: 'Prospectos',
        note: 'El tablero completo; los nuevos también salen en Aprobaciones',
        keywords: 'growth signals prospectos oportunidades contratando vacantes',
      },
      {
        href: '/learning',
        label: 'Aprendizaje',
        note: 'Qué se ajustó solo, con qué evidencia, y qué esperas decidir',
        keywords: 'learning memoria ajustes aprendio cambios automaticos',
      },
      // Not in the rail. The door on a screen is the header action on
      // /learning; this is the door for somebody who knows the word.
      {
        href: '/evaluation',
        label: 'Evaluación',
        note: 'Si las respuestas mejoraron o empeoraron, con un número',
        keywords: 'evaluation calidad pruebas suite corridas benchmark respuestas',
      },
    ],
  },
  {
    heading: 'Conexiones',
    entries: [
      {
        href: '/integrations',
        label: 'Integraciones',
        note: 'A qué sistemas llega Cortex en tu nombre',
        keywords: 'google hubspot slack github linear payroll mcp servers outlook conectar',
      },
      {
        href: '/mcp-tokens',
        label: 'Conectar Claude',
        note: 'Usar Cortex desde Claude u otro cliente de IA',
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
    // Neither is in the rail: both are set-up-once screens reached from where
    // the question comes up — /tools from Inicio, /agents from /tools when a
    // tool is blocked and the answer is which agent may call it.
    heading: 'Configuración',
    entries: [
      {
        href: '/tools',
        label: 'Herramientas',
        note: 'Qué sabe hacer Cortex aquí, qué está frenado y por qué',
        keywords: 'tools catalogo permisos bloqueada habilitar capacidades',
      },
      {
        href: '/agents',
        label: 'Agentes',
        note: 'Qué agentes existen y a qué herramientas llega cada uno',
        keywords: 'agents bots equipo modelos personas artificiales',
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
    router.push(href);
    onClose();
  };

  const item = (e: Entry) => (
    <Command.Item
      key={e.href}
      value={`${e.label} ${e.note} ${e.keywords}`}
      onSelect={() => go(e.href)}
      className="cursor-pointer rounded-sm px-3 py-2 transition-colors duration-150 aria-selected:bg-primary-soft aria-selected:text-primary-ink hover:bg-primary-soft hover:text-primary-ink motion-reduce:transition-none"
    >
      <div className="text-[13px] font-medium text-ink">{e.label}</div>
      {/* The same sentence the rail shows for this destination. Two names and
          two descriptions for one screen is what this change is undoing. */}
      <div className="mt-0.5 text-[11.5px] leading-snug text-ink-faint">{e.note}</div>
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
            className="w-full border-b border-border bg-transparent px-4 py-3 text-[13px] text-ink outline-none transition-colors duration-150 placeholder:text-ink-faint focus:bg-primary-soft/40 motion-reduce:transition-none"
          />
          <Command.List className="max-h-[22rem] overflow-y-auto p-2">
            <Command.Empty className="py-4 text-center text-[13px] text-ink-faint">
              Sin resultados.
            </Command.Empty>
            {sections.map((section) => (
              <Command.Group
                key={section.heading}
                heading={section.heading}
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-ink-faint"
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
