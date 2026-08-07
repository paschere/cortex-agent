/**
 * Why each gated tool is gated — shared by the MCP confirmation flow and the
 * web chat's ConfirmationPrompt so both surfaces explain stakes the same way.
 * Pure data: safe to import from client components.
 *
 * Written in Spanish because these are read by the person deciding whether to
 * approve an action, not by the model. Each one answers the only question that
 * matters at that moment: what happens if I say yes, and can I take it back?
 */
export const CONFIRMATION_NOTES: Record<string, string> = {
  'gmail.send_draft':
    'Envía un correo real desde tu Gmail a sus destinatarios. Una vez enviado no se puede recuperar, y te representa a ti y a la empresa ante quien lo reciba.',
  'gmail.send_message':
    'Envía este mensaje, tal cual está escrito acá, desde tu Gmail. Lo que apruebas es exactamente lo que sale — no hay borrador de por medio que alguien pueda cambiar después. Una vez enviado no se puede recuperar.',
  'gmail.draft': 'Crea un borrador en tu Gmail. No se envía nada, pero aparece en tu bandeja.',
  'gcal.create_event':
    'Crea un evento y manda la invitación por correo a todos los asistentes — la gente de fuera la ve de inmediato.',
  'slack.post_message': 'Publica un mensaje en Slack que todos en el canal ven apenas cae.',
  'hubspot.create_contact':
    'Crea un registro permanente en el CRM que todo el equipo comercial va a ver y usar.',
  'hubspot.create_deal':
    'Crea un negocio en el embudo — va a aparecer en los pronósticos y en los reportes.',
  'hubspot.update_deal':
    'Modifica datos vivos del negocio (etapa, monto, campos) de los que dependen el equipo y los pronósticos. Los valores anteriores se pierden.',
  'hubspot.log_activity':
    'Escribe una nota de actividad en la línea de tiempo del CRM, visible para todo el equipo.',
  'github.create_issue':
    'Crea un issue visible para todo el equipo en el repositorio y notifica a quienes lo siguen.',
  'github.create_issue_comment':
    'Publica un comentario visible para todos los que siguen el issue.',
  'linear.create_issue': 'Crea un issue que el equipo de ingeniería va a revisar y atender.',
  'linear.create_comment': 'Publica un comentario visible para todos en el issue.',
  'gsheets.append_row':
    'Agrega una fila a una hoja compartida que otros pueden estar usando para reportes.',
  'schedule.create':
    'Crea una rutina DESATENDIDA que se ejecuta sola según su programación, sin que nadie la supervise. Sigue corriendo hasta que la pauses.',
  'pipeline.create':
    'Guarda un procedimiento reutilizable que cualquiera del equipo puede ejecutar desde cualquier lado — un error en su diseño se repite en cada ejecución.',
  'pipeline.update':
    'Cambia un procedimiento compartido para todos los que lo usan, desde la próxima ejecución.',
  'presentations.create_pdf':
    'Genera un documento de presentación de un candidato para cliente, con su nombre y su perfil adentro, que puede terminar compartido por fuera.',
};

const FAMILY_SYSTEM: Record<string, string> = {
  gmail: 'tu cuenta de Gmail',
  gcal: 'tu Google Calendar',
  gsheets: 'una hoja de cálculo compartida',
  hubspot: 'el CRM de HubSpot',
  github: 'GitHub',
  linear: 'Linear',
  slack: 'Slack',
  schedule: 'el programador de rutinas desatendidas',
  pipeline: 'la biblioteca de procedimientos compartida',
  presentations: 'la biblioteca de presentaciones para cliente',
  payroll: 'el servicio de nómina',
  kb: 'Brain Knowledge, la memoria compartida',
  vehicles: 'el registro de vehículos y, a través de él, el RUNT y el SIMIT',
  // Custom tools (migración 0067) llevan el id `custom.<slug>`. No podemos
  // nombrar el sistema — cada empresa apunta la suya a donde necesita — así que
  // lo que se dice es lo único que sí sabemos y que sí importa a la hora de
  // aprobar: es un sistema de la propia empresa y el cambio queda hecho allá.
  custom: 'un sistema propio de tu empresa conectado por un administrador',
};

export function confirmationReason(toolId: string): string {
  const note = CONFIRMATION_NOTES[toolId];
  if (note) return note;
  const family = toolId.split('.')[0] ?? '';
  const system = FAMILY_SYSTEM[family] ?? 'un sistema externo';
  return `Ejecuta una escritura sobre ${system} — cambia datos reales fuera de esta conversación y puede quedar visible para otras personas.`;
}
