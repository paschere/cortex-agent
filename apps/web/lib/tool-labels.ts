export const TOOL_LABELS: Record<string, { label: string; icon: string }> = {
  qualify_lead: { label: 'Calificar prospecto', icon: 'UserCheck' },
  hubspot_search_companies: { label: 'Buscar empresas en HubSpot', icon: 'Building2' },
  hubspot_get_company: { label: 'Ver detalle de la empresa', icon: 'Building2' },
  hubspot_search_deals: { label: 'Buscar negocios', icon: 'Briefcase' },
  hubspot_get_deal: { label: 'Ver detalle del negocio', icon: 'Briefcase' },
  hubspot_search_contacts: { label: 'Buscar contactos', icon: 'Users' },
  hubspot_get_contact: { label: 'Ver detalle del contacto', icon: 'User' },
  hubspot_create_deal: { label: 'Crear negocio', icon: 'PlusCircle' },
  hubspot_update_deal: { label: 'Actualizar negocio', icon: 'Edit' },
  hubspot_create_contact: { label: 'Crear contacto', icon: 'UserPlus' },
  hubspot_log_activity: { label: 'Registrar actividad', icon: 'ClipboardList' },
  hubspot_get_pipeline_summary: { label: 'Resumen del embudo', icon: 'BarChart2' },
  hubspot_list_recent_activities: { label: 'Actividad reciente', icon: 'Activity' },
  gmail_search: { label: 'Buscar en Gmail', icon: 'Mail' },
  gmail_read_thread: { label: 'Leer conversación de correo', icon: 'MailOpen' },
  gmail_draft: { label: 'Redactar correo', icon: 'Pencil' },
  gmail_send_draft: { label: 'Enviar el correo redactado', icon: 'Send' },
  gmail_send_message: { label: 'Enviar este correo tal cual', icon: 'Send' },
  actions_propose: { label: 'Dejar la acción lista para aprobar', icon: 'Send' },
  actions_list: { label: 'Ver lo que espera tu aprobación', icon: 'ListChecks' },
  gmail_list_threads: { label: 'Listar conversaciones de correo', icon: 'Inbox' },
  gcal_list_events: { label: 'Ver eventos del calendario', icon: 'Calendar' },
  gcal_create_event: { label: 'Crear evento en el calendario', icon: 'CalendarPlus' },
  gsheets_read_range: { label: 'Leer hoja de cálculo', icon: 'Table' },
  gsheets_append_row: { label: 'Agregar fila a la hoja', icon: 'TableProperties' },
  kb_search: { label: 'Buscar en Brain Knowledge', icon: 'BookOpen' },
  // Only ever offered on a turn that carried a frame of a shared tab, so this
  // label can name the person's own screen without qualifying it. It shows up
  // in the busy line while the box is being worked out; the result is a picture
  // rather than a step row, so it never becomes a task row. See ScreenMarks.tsx.
  screen_point_at: { label: 'Señalar en tu pantalla', icon: 'Crosshair' },
  sales_draft_proposal: { label: 'Redactar propuesta', icon: 'FileText' },
  web_search: { label: 'Buscar en internet', icon: 'Globe' },
  web_scrape: { label: 'Abrir página web', icon: 'Link' },
  browser_list_flows: { label: 'Ver los trámites aprendidos', icon: 'Globe' },
  browser_run_flow: { label: 'Hacer el trámite en el portal', icon: 'Globe' },
  browser_submit_flow: { label: 'Radicar el trámite en el portal', icon: 'Send' },
  gdrive_search_files: { label: 'Buscar archivos en Drive', icon: 'FolderSearch' },
  gdrive_read_doc: { label: 'Leer documento de Drive', icon: 'FileSearch' },
  schedule_create: { label: 'Programar rutina', icon: 'AlarmClockPlus' },
  schedule_list: { label: 'Ver rutinas programadas', icon: 'AlarmClock' },
  schedule_update: { label: 'Actualizar rutina', icon: 'AlarmClockCheck' },
  // Vehicles. The two lookups name the registry they hit rather than the tool,
  // because that is what the person waiting recognises — and a RUNT check runs
  // for the better part of half a minute, so it is on screen a while.
  vehicles_register: { label: 'Registrar vehículo', icon: 'Car' },
  vehicles_list: { label: 'Ver vehículos', icon: 'Car' },
  vehicles_get: { label: 'Ver detalle del vehículo', icon: 'Car' },
  vehicles_check_runt: { label: 'Consultar el RUNT (SOAT y tecnomecánica)', icon: 'ShieldCheck' },
  vehicles_check_simit: { label: 'Consultar el SIMIT (comparendos)', icon: 'ReceiptText' },
  vehicles_recently_changed: { label: 'Revisar cambios en la flota', icon: 'RefreshCw' },
};

function toTitleCase(s: string): string {
  return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Maps a raw tool id to a human label and Lucide icon name.
 * Tool ids may arrive in dotted (`hubspot.search_deals`) or underscored
 * (`hubspot_search_deals`) form; both normalize to the same lookup key.
 */
export function toolLabel(toolId: string): { label: string; icon: string } {
  const key = toolId.replace(/\./g, '_');
  return TOOL_LABELS[key] ?? { label: toTitleCase(toolId), icon: 'Wrench' };
}

/**
 * `Family · Action` rendering of a tool id, for surfaces that have no curated
 * label to fall back on (approval emails, Chat DMs, archived transcripts).
 *
 * Ids reach us in two shapes: dotted as declared (`hubspot.update_deal`) and
 * underscored as the AI SDK / MCP persist them (`hubspot_update_deal`). Both
 * normalize to the same output.
 */
export function humanizeToolId(toolId: string): string {
  const [family = '', ...rest] = toolId.replace(/\./g, '_').split('_');
  const cap = (w: string) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w);
  const action = rest.map(cap).join(' ');
  return action ? `${cap(family)} · ${action}` : cap(family);
}

/**
 * The name a human should see for a tool. Curated label when we have one,
 * otherwise the `Family · Action` form — never the raw id.
 */
export function toolDisplayName(toolId: string): string {
  const key = toolId.replace(/\./g, '_');
  return TOOL_LABELS[key]?.label ?? humanizeToolId(toolId);
}

/**
 * A plain-Spanish sentence describing what a confirmation-gated action will do,
 * so someone can approve it without reading raw JSON. The interface is Spanish;
 * these strings are read by the person deciding, not by the model.
 */
export function confirmationSummary(toolId: string, input: Record<string, unknown>): string {
  const key = toolId.replace(/\./g, '_');
  switch (key) {
    case 'hubspot_update_deal':
      return `Actualizar el negocio${input.dealstage ? ` a la etapa "${input.dealstage}"` : ''}${input.amount ? ` · monto $${input.amount}` : ''}`;
    case 'hubspot_create_deal':
      return `Crear el negocio "${input.dealname}" en la etapa "${input.dealstage}"`;
    case 'hubspot_create_contact':
      return `Crear el contacto ${[input.firstName, input.lastName].filter(Boolean).join(' ')} <${input.email}>`;
    case 'hubspot_log_activity':
      return `Registrar ${input.type} "${input.subject}" en ${input.associatedObjectType} ${input.associatedObjectId}`;
    case 'browser_submit_flow':
      return `Ejecutar el trámite "${input.flow}" en el portal, que radica o envía algo con la identidad de la empresa`;
    case 'gmail_send_draft':
      return `Enviar el correo redactado ${input.draftId}`;
    case 'gcal_create_event':
      return `Crear el evento "${input.summary}" el ${input.start}`;
    case 'gsheets_append_row':
      return `Agregar una fila a la hoja "${input.spreadsheetId}"`;
    case 'schedule_create': {
      const when =
        input.scheduleKind === 'once'
          ? `una vez, el ${input.runAt}`
          : `con la programación "${input.cron}" (${input.timezone ?? 'UTC'})`;
      // Spelled out because it is the one setting that lets the routine write
      // to other systems with nobody watching.
      const writes = input.allowUnattendedWrites ? ' · PUEDE ESCRIBIR sin supervisión' : '';
      return `Programar "${input.name}" — se ejecuta ${when}${writes}`;
    }
    case 'vehicles_register':
      return `Registrar el vehículo de placa ${input.plate}`;
    default:
      return `Ejecutar: ${toolLabel(toolId).label}`;
  }
}
