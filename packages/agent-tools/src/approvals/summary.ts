/**
 * LA FRASE QUE DESCRIBE UNA LLAMADA PARADA, SIN ENSEÑAR SU PAYLOAD.
 *
 * ===========================================================================
 * POR QUÉ ESTO EXISTE DOS VECES EN EL REPOSITORIO
 * ===========================================================================
 * La copia gemela está en `apps/web/lib/tool-labels.ts` y NO se puede borrar
 * ninguna de las dos:
 *
 *   · La del navegador la usan `ConfirmationPrompt` y la tarjeta de
 *     aprobaciones, que son `'use client'`. Importar `@cortex/agent-tools`
 *     desde un componente de cliente arrastra `node:dns` al bundle y rompe el
 *     build de producción mientras el typecheck y las pruebas siguen en verde
 *     — está contado en `apps/web/lib/reports-shape.ts`, que ya lo vivió.
 *   · Esta la necesita `approvals.list`, que corre dentro del paquete y no
 *     puede importar nada de `apps/web` (la dependencia va al revés).
 *
 * Es el mismo trato que ya tienen `lib/actions-shape.ts` y
 * `lib/commitments-shape.ts`, y la duplicación se mantiene honesta igual: una
 * prueba en Node importa las dos y falla en cuanto discrepan
 * (`apps/web/lib/approvals-summary-parity.test.ts`). Un texto que se va de un
 * lado y no del otro deja de ser cosmético en cuanto la frase que aprueba una
 * persona deja de ser la frase que le contó el modelo.
 *
 * ===========================================================================
 * QUÉ PUEDE Y QUÉ NO PUEDE LLEVAR ESTA FRASE
 * ===========================================================================
 * Es lo ÚNICO derivado del payload que `approvals.list` deja entrar en el
 * contexto del modelo, y por eso cada rama nombra campos concretos —el destino,
 * la etapa, la placa, la fecha— en vez de volcar el objeto. La cola puede
 * contener una exportación de nómina; `Ejecutar: Enviar el correo redactado` es
 * una descripción, `{"rows": [...]}` es una fuga. Al añadir una rama aquí, la
 * pregunta no es «¿qué sé de esta llamada?» sino «¿qué necesita saber quien va
 * a decir que sí?».
 */

/**
 * El nombre en español de cada herramienta. Sólo el texto: los iconos son cosa
 * de la interfaz y viven con ella, en `apps/web/lib/tool-labels.ts`.
 */
export const TOOL_LABEL_TEXT: Record<string, string> = {
  qualify_lead: 'Calificar prospecto',
  hubspot_search_companies: 'Buscar empresas en HubSpot',
  hubspot_get_company: 'Ver detalle de la empresa',
  hubspot_search_deals: 'Buscar negocios',
  hubspot_get_deal: 'Ver detalle del negocio',
  hubspot_search_contacts: 'Buscar contactos',
  hubspot_get_contact: 'Ver detalle del contacto',
  hubspot_create_deal: 'Crear negocio',
  hubspot_update_deal: 'Actualizar negocio',
  hubspot_create_contact: 'Crear contacto',
  hubspot_log_activity: 'Registrar actividad',
  hubspot_get_pipeline_summary: 'Resumen del embudo',
  hubspot_list_recent_activities: 'Actividad reciente',
  gmail_search: 'Buscar en Gmail',
  gmail_read_thread: 'Leer conversación de correo',
  gmail_draft: 'Redactar correo',
  gmail_send_draft: 'Enviar el correo redactado',
  gmail_send_message: 'Enviar este correo tal cual',
  actions_propose: 'Dejar la acción lista para aprobar',
  actions_list: 'Ver lo que espera tu aprobación',
  approvals_list: 'Ver lo que espera tu permiso para ejecutarse',
  gmail_list_threads: 'Listar conversaciones de correo',
  gcal_list_events: 'Ver eventos del calendario',
  gcal_create_event: 'Crear evento en el calendario',
  gsheets_read_range: 'Leer hoja de cálculo',
  gsheets_append_row: 'Agregar fila a la hoja',
  kb_search: 'Buscar en Brain Knowledge',
  screen_point_at: 'Señalar en tu pantalla',
  // Como `screen_point_at`: no está en el registro —se declara en `/api/chat` y
  // no ejecuta nada— pero su nombre sí tiene que estar aquí, porque este
  // catálogo y el de `apps/web/lib/tool-labels.ts` son la misma tabla partida en
  // dos y `approvals-parity.test.ts` exige que no se separen.
  ask_choice: 'Preguntarte',
  sales_draft_proposal: 'Redactar propuesta',
  web_search: 'Buscar en internet',
  web_scrape: 'Abrir página web',
  browser_list_flows: 'Ver los trámites aprendidos',
  browser_run_flow: 'Hacer el trámite en el portal',
  browser_submit_flow: 'Radicar el trámite en el portal',
  gdrive_search_files: 'Buscar archivos en Drive',
  gdrive_read_doc: 'Leer documento de Drive',
  schedule_create: 'Programar rutina',
  schedule_list: 'Ver rutinas programadas',
  schedule_update: 'Actualizar rutina',
  vehicles_register: 'Registrar vehículo',
  vehicles_list: 'Ver vehículos',
  vehicles_get: 'Ver detalle del vehículo',
  vehicles_check_runt: 'Consultar el RUNT (SOAT y tecnomecánica)',
  vehicles_check_simit: 'Consultar el SIMIT (comparendos)',
  vehicles_recently_changed: 'Revisar cambios en la flota',
  goals_set: 'Fijar una meta de la empresa',
};

function toTitleCase(s: string): string {
  return s.replace(/[_.]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** El nombre que una persona debería leer. Nunca el id en bruto. */
export function pendingToolLabel(toolId: string): string {
  return TOOL_LABEL_TEXT[toolId.replace(/\./g, '_')] ?? toTitleCase(toolId);
}

/**
 * Una frase en español que dice qué va a hacer la llamada que está esperando.
 *
 * Gemela exacta de `confirmationSummary` en `apps/web/lib/tool-labels.ts` — ver
 * la cabecera de este archivo para por qué son dos y qué las mantiene iguales.
 */
export function pendingSummary(toolId: string, input: Record<string, unknown>): string {
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
      const writes = input.allowUnattendedWrites ? ' · PUEDE ESCRIBIR sin supervisión' : '';
      return `Programar "${input.name}" — se ejecuta ${when}${writes}`;
    }
    case 'vehicles_register':
      return `Registrar el vehículo de placa ${input.plate}`;
    case 'goals_set':
      return `Fijar la meta «${input.label || input.metricKey}» — objetivo ${input.targetValue}, ${
        input.cadence === 'week' ? 'semanal' : 'mensual'
      }`;
    default:
      return `Ejecutar: ${pendingToolLabel(toolId)}`;
  }
}

/** Lo mismo, tolerante con un `input` que no sea un objeto plano. */
export function describePendingCall(toolId: string, input: unknown): string {
  const record =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  try {
    return pendingSummary(toolId, record);
  } catch {
    return pendingToolLabel(toolId);
  }
}
