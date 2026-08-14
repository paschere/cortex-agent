'use client';

import type { GridColumn } from '@/lib/result-grid';
import type { ScreenFrame } from '@/lib/screen-marks';
import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';

/**
 * QUÉ SE DIBUJA CUANDO UNA HERRAMIENTA CONTESTA.
 *
 * ===========================================================================
 * EL PROBLEMA QUE ESTE ARCHIVO EXISTE PARA CERRAR
 * ===========================================================================
 * De ~134 herramientas registradas, CUATRO tenían vista propia. Las otras 130
 * salían como una fila gris con el JSON plegado detrás de un chevron.
 *
 * Eso no es un defecto estético, es la razón por la que la gente se va del
 * chat. `actions.list` existe desde hace meses y está en el menú `/` con la
 * frase «Muéstrame las acciones que esperan mi aprobación». Alguien la escribe,
 * recibe una fila gris, y se va a `/actions`. No fue porque no supiera dónde
 * estaba la pantalla: preguntó y no le contestaron.
 *
 * ===========================================================================
 * TRES CAPAS, Y LA DE ABAJO NO NECESITA QUE NADIE LA ALIMENTE
 * ===========================================================================
 * No se pueden escribir 130 vistas, y no hay que escribirlas. Una vista a
 * medida para `github.get_repo_contents` sería un visor de código que nadie
 * pidió. Lo que sube es el SUELO, no el techo:
 *
 *   RICH        ~15 entradas. Una vista propia para lo que una persona
 *               necesita mirar y sobre lo que va a actuar. Card.
 *   TABLE       ~30 entradas de DATOS PUROS, sin JSX: qué campo trae las
 *               filas y qué columnas enseñar. Añadir una son 60 segundos.
 *   estructural CERO entradas. Mira la forma del resultado en tiempo de
 *               ejecución y decide. Cubre de golpe gmail, outlook, linear,
 *               github, hubspot, vehicles, payroll — unas 80 herramientas.
 *
 * La doctrina no es nueva en este repositorio: `lib/tool-args.ts` ya la
 * argumenta para las filas de paso — «una regla que funciona para todas gana a
 * una frase que funciona para doce y degrada en silencio».
 *
 * ===========================================================================
 * DÓNDE APARECE CADA UNA, Y POR QUÉ NO TODAS SON TARJETA
 * ===========================================================================
 * `TaskRows` tiene razón en su tesis y no se toca: una llamada a herramienta es
 * un RENGLÓN, no un documento, y doce tarjetas son una pared. Así que:
 *
 *   RICH y TABLE  → tarjeta. Son la salida del turno.
 *   estructural   → DENTRO del chevron de TaskRows, en lugar del <pre> de JSON.
 *                   Un paso sigue siendo un paso; lo único que cambia es que al
 *                   desplegarlo se lee.
 *
 * Y los dos centinelas de sobre (`__requires_confirmation`, `__error`) ganan a
 * todo lo de aquí: son estado del turno, no identidad de la herramienta.
 *
 * ===========================================================================
 * POR QUÉ `next/dynamic` EN EL VALOR DEL MAPA
 * ===========================================================================
 * Quince renderizadores importados de forma estática entran en el bundle del
 * transcript aunque una conversación no use ninguno. Con `dynamic`, este
 * registro puede crecer a cuarenta entradas sin coste en la primera pintura.
 *
 * ===========================================================================
 * LA REGLA QUE NO SE PUEDE ROMPER: NADA DE VALORES DE @cortex/agent-tools
 * ===========================================================================
 * Este archivo es `'use client'`. Puede importar TIPOS del paquete —se borran
 * al compilar— y NUNCA un valor. Ese barril alcanza `node:dns`, y un valor
 * importado desde un componente de cliente compila en local, pasa el typecheck
 * y las pruebas, y rompe el build de producción. Ya pasó una vez; está contado
 * en `lib/reports-shape.ts`. `registry.test.ts` es el espejo que lo vigila.
 */

/** Lo que recibe cualquier renderizador. Nada más viaja hasta aquí. */
export interface ResultViewProps {
  result: unknown;
  /** Para una tarjeta que necesita saber a qué llamada pertenece. */
  toolCallId: string;
  /** Refrescar lo que la tarjeta cambió (aprobar, descartar). */
  onSettled?: () => void;
  /**
   * La foto contra la que se contestó este turno, cuando la hay.
   *
   * Es lo único de aquí que no sale del resultado, y está porque `ScreenMarks`
   * no puede existir sin ella: sus cuadros son porcentajes de una imagen, y sin
   * la imagen no hay nada sobre lo que dibujarlos. Vive en `MessageList`, que es
   * quien tiene la conversación abierta, y muere al recargar — que es
   * exactamente lo que la tarjeta dice en voz alta en vez de pintar cajas sobre
   * la nada. Cualquier otra vista la ignora.
   */
  screenFrame?: ScreenFrame | null;
}

export type ResultView = ComponentType<ResultViewProps>;

/**
 * Un id de herramienta llega con dos grafías: el AI SDK la nombra con guiones
 * bajos y el registro la declaró con punto, y una conversación archivada puede
 * guardar cualquiera de las dos. Antes eso eran cuatro predicados dobles
 * escritos a mano; ahora se normaliza una vez, aquí.
 */
export function normalizeToolId(toolName: string): string {
  return toolName.replaceAll('.', '_');
}

// ---------------------------------------------------------------------------
// Capa 1 — vistas propias
// ---------------------------------------------------------------------------

/**
 * Las herramientas cuyo resultado es la RESPUESTA del turno, no un paso hacia
 * ella. El orden en que se cubren no es de gusto: primero las colas sobre las
 * que una persona actúa, porque son las que hacen que alguien se vaya del chat.
 *
 * `ssr: false` no hace falta: son componentes de cliente dentro de un árbol de
 * cliente. Lo que aporta `dynamic` aquí es el corte del bundle.
 */
export const RICH: Record<string, ResultView> = {
  // -------------------------------------------------------------------------
  // Las que ya existían como ramas `if` escritas a mano en `MessageBubble`.
  // Bajaron aquí cuando el registro demostró que escalaba, y no antes.
  // -------------------------------------------------------------------------
  sales_draft_proposal: dynamic(() =>
    import('../ProposalCard').then((m) => m.ProposalCard as unknown as ResultView),
  ),
  actions_propose: dynamic(() =>
    import('./ProposedAction').then((m) => m.ProposedAction as unknown as ResultView),
  ),
  reports_chart: dynamic(() =>
    import('./ChartResult').then((m) => m.ChartResult as unknown as ResultView),
  ),
  screen_point_at: dynamic(() =>
    import('./MarksResult').then((m) => m.MarksResult as unknown as ResultView),
  ),

  // -------------------------------------------------------------------------
  // Las colas sobre las que una persona ACTÚA. El orden en que se cubrieron no
  // es de gusto: son las que hacen que alguien pregunte en el chat y se vaya a
  // una pantalla a hacer lo que acababa de preguntar.
  // -------------------------------------------------------------------------
  approvals_list: dynamic(() =>
    import('./ApprovalsQueue').then((m) => m.ApprovalsQueue as unknown as ResultView),
  ),
  actions_list: dynamic(() =>
    import('./ActionsQueue').then((m) => m.ActionsQueue as unknown as ResultView),
  ),
  commitments_due_soon: dynamic(() =>
    import('./CommitmentsDue').then((m) => m.CommitmentsDue as unknown as ResultView),
  ),
  payments_receivables: dynamic(() =>
    import('./ReceivablesCard').then((m) => m.ReceivablesCard as unknown as ResultView),
  ),
  errands_status: dynamic(() =>
    import('./ErrandsStatus').then((m) => m.ErrandsStatus as unknown as ResultView),
  ),
  clients_overview: dynamic(() =>
    import('./ClientOverview').then((m) => m.ClientOverview as unknown as ResultView),
  ),

  // -------------------------------------------------------------------------
  // La pregunta de apertura, y la cifra contra la que se mide todo lo demás.
  // -------------------------------------------------------------------------
  // «¿Qué me espera?» es lo primero que pregunta cualquiera que abre Cortex por
  // la mañana, y hasta ahora se contestaba con un enlace a otra pantalla. Se
  // dibuja con el MISMO bloque de colas que `/dashboard`, no con una versión
  // para el chat.
  inbox_overview: dynamic(() =>
    import('./WaitingOverview').then((m) => m.WaitingOverview as unknown as ResultView),
  ),
  // Una cifra, el objetivo contra el que se juzgó y si lo cumplió: las tres se
  // leen de un vistazo o no se leen. En un JSON plegado nadie hace la resta.
  goals_list: dynamic(() =>
    import('./GoalsSummary').then((m) => m.GoalsSummary as unknown as ResultView),
  ),
};

/**
 * CUÁNDO UNA VISTA PROPIA NO PUEDE DIBUJAR, Y EL PASO SIGUE SIENDO UN PASO.
 *
 * `reports.chart` devuelve un id, no un dibujo; sin `chartId` no hay nada que
 * pedirle a la ruta y la llamada vuelve a ser un renglón, que es lo que hacía
 * antes de existir este archivo. Lo mismo con un borrador que llegó sin `id` o
 * sin sello: una tarjeta con el botón roto es peor que una fila gris.
 *
 * NO es la puerta de atrás para meter lógica en el registro. Son predicados de
 * una línea sobre la FORMA del resultado, y la vista sigue siendo quien decide
 * qué hace con lo que sí le llega. Si un predicado de estos necesita saber algo
 * del dominio, la vista era otra.
 *
 * `screen.point_at` no está aquí a propósito: sin marcas no dibuja nada Y
 * tampoco baja a paso — el modelo ya explicó en la respuesta por qué no señaló
 * nada, y un renglón repitiéndolo es ruido sobre un rectángulo que no existe.
 */
const RICH_NEEDS: Record<string, (result: unknown) => boolean> = {
  reports_chart: (r) => typeof field(r, 'chartId') === 'string',
  actions_propose: (r) => {
    const action = field(r, 'action');
    return (
      typeof field(action, 'id') === 'string' && typeof field(action, 'contentHash') === 'string'
    );
  },
  sales_draft_proposal: (r) =>
    isPlainObject(field(r, 'company')) && Array.isArray(field(r, 'roles')),
};

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined;
}

// ---------------------------------------------------------------------------
// Capa 2 — tablas declaradas
// ---------------------------------------------------------------------------

/**
 * La columna de una tabla declarada es LA MISMA que la de la rejilla que la
 * pinta, y por eso es un alias y no una copia. Cuando `ResultGrid` aprenda a
 * hacer algo con un `kind` nuevo, las especificaciones de aquí abajo lo tienen
 * el mismo día; una segunda definición con los mismos campos es la manera de
 * que dentro de tres meses una de las dos tenga un `kind` que la otra ignora.
 *
 * `key` admite `a.b` para bajar un nivel. `number` y `money` alinean a la
 * derecha y ponen la cifra en monoespaciada; `money` es además lo ÚNICO que se
 * totaliza al pie, y la razón está escrita en `lib/result-grid.ts`.
 */
export type TableColumn = GridColumn;

export interface TableSpec {
  /** Campo del resultado que trae el array. */
  rows: string;
  columns: TableColumn[];
  /** Campo con la frase de contexto, si la hay. */
  note?: string;
  /** Qué decir cuando el array viene vacío. Nunca una tabla en blanco. */
  empty: string;
}

/**
 * SOLO DATOS. Ni JSX, ni funciones, ni condiciones.
 *
 * Es lo que hace que añadir una tabla cueste un minuto y no una revisión de
 * diseño, y lo que permite que la escriba quien conoce la herramienta en vez de
 * quien conoce React.
 *
 * TRES REGLAS, Y LAS TRES SE COMPRUEBAN EN `registry.test.ts`:
 *
 *   `rows` Y CADA `key` EXISTEN EN EL `outputSchema` DE SU HERRAMIENTA. Una
 *   columna que nombra un campo que no existe no falla: sale como una raya, en
 *   silencio, para siempre. La prueba lee el esquema de verdad —puede, porque
 *   corre en Node— y falla con el nombre del campo inventado.
 *
 *   SEIS COLUMNAS COMO MÁXIMO. Una tabla que no cabe en el ancho de una
 *   conversación no es una tabla: es un JSON con rayas verticales.
 *
 *   `empty` ES UNA FRASE, NUNCA UNA TABLA EN BLANCO. «No hay nada» y «no
 *   encontré nada» son respuestas distintas, y la diferencia es justo lo que la
 *   persona necesita para saber si preguntar otra vez.
 *
 * Y una que no se puede comprobar sola: si al escribir una entrada te descubres
 * queriendo poner una función o una condición, esa herramienta era `RICH`.
 */
export const TABLE: Record<string, TableSpec> = {
  // --- Lo que Cortex sabe hacer solo -------------------------------------
  browser_list_flows: {
    rows: 'flows',
    note: 'guidance',
    columns: [
      { key: 'name', label: 'Trámite' },
      { key: 'site', label: 'Sitio' },
      { key: 'description', label: 'Qué hace' },
      { key: 'needsApproval', label: '¿Pide permiso?' },
      { key: 'lastRunAt', label: 'Última vez', kind: 'date' },
    ],
    empty:
      'No hay ningún trámite configurado todavía, así que no hay nada que Cortex pueda hacer solo en un sitio web.',
  },
  schedule_list: {
    rows: 'jobs',
    columns: [
      { key: 'name', label: 'Rutina' },
      { key: 'kind', label: 'Tipo' },
      { key: 'status', label: 'Estado' },
      { key: 'cron', label: 'Cada cuánto' },
      { key: 'nextRunAt', label: 'Próxima', kind: 'date' },
    ],
    empty: 'No tienes ninguna rutina programada. Nada va a correr solo mientras siga así.',
  },
  pipeline_list: {
    rows: 'pipelines',
    columns: [
      { key: 'name', label: 'Procedimiento' },
      { key: 'description', label: 'Para qué' },
      { key: 'stepCount', label: 'Pasos', kind: 'number' },
      { key: 'timesRun', label: 'Veces', kind: 'number' },
      { key: 'lastRunAt', label: 'Última vez', kind: 'date' },
    ],
    empty:
      'No hay ningún procedimiento guardado. Un procedimiento es una secuencia que ya se hizo bien una vez y quedó escrita para repetirla.',
  },
  reports_list: {
    rows: 'reports',
    columns: [
      { key: 'title', label: 'Informe' },
      { key: 'periodLabel', label: 'Periodo' },
      { key: 'generatedAt', label: 'Generado', kind: 'date' },
      { key: 'shareViews', label: 'Vistas', kind: 'number' },
    ],
    empty: 'Todavía no se ha generado ningún informe.',
  },
  growth_list_signals: {
    rows: 'signals',
    columns: [
      { key: 'company', label: 'Empresa' },
      { key: 'roleTitle', label: 'Señal' },
      { key: 'region', label: 'Zona' },
      { key: 'status', label: 'Estado' },
      { key: 'contactName', label: 'Contacto' },
    ],
    empty:
      'No hay señales guardadas. Búscalas con growth.find_signals antes de preguntar por ellas.',
  },

  // --- Papeles, plata y compromisos --------------------------------------
  documents_pending_review: {
    rows: 'pending',
    note: 'guidance',
    columns: [
      { key: 'documentTitle', label: 'Documento' },
      { key: 'docTypeLabel', label: 'Tipo' },
      { key: 'clientName', label: 'Cliente' },
    ],
    empty: 'No hay ningún documento esperando revisión: todo lo leído ya lo confirmó una persona.',
  },
  documents_records: {
    rows: 'records',
    note: 'guidance',
    columns: [
      { key: 'docTypeLabel', label: 'Tipo' },
      { key: 'docNumber', label: 'Número' },
      { key: 'client', label: 'Cliente' },
      { key: 'amount', label: 'Valor', kind: 'money' },
      { key: 'dueOn', label: 'Vence', kind: 'date' },
      { key: 'overdue', label: '¿Vencido?' },
    ],
    empty:
      'No hay ningún documento confirmado que empareje. Lo que Cortex leyó y nadie ha revisado no está aquí a propósito: está en la bandeja de revisión.',
  },
  payments_list: {
    rows: 'payments',
    note: 'guidance',
    columns: [
      { key: 'paidOn', label: 'Pagado', kind: 'date' },
      { key: 'client', label: 'Cliente' },
      { key: 'invoiceNumber', label: 'Factura' },
      { key: 'amount', label: 'Importe', kind: 'money' },
      { key: 'currency', label: 'Moneda' },
      { key: 'state', label: 'Estado' },
    ],
    empty: 'No hay ningún pago registrado con ese filtro.',
  },
  payments_disputes: {
    rows: 'disputes',
    note: 'guidance',
    columns: [
      { key: 'client', label: 'Cliente' },
      { key: 'standingAmount', label: 'Importe en pie', kind: 'money' },
      { key: 'currency', label: 'Moneda' },
      { key: 'paidOn', label: 'Pagado', kind: 'date' },
      { key: 'note', label: 'Nota' },
    ],
    empty:
      'No hay ningún pago en disputa: ninguna cifra está esperando que una persona decida entre dos fuentes.',
  },
  commitments_pending_review: {
    rows: 'pending',
    note: 'guidance',
    columns: [
      { key: 'title', label: 'Compromiso' },
      { key: 'kindLabel', label: 'Tipo' },
      { key: 'dueOn', label: 'Propone', kind: 'date' },
      { key: 'counterparty', label: 'Con quién' },
      { key: 'documentTitle', label: 'Leído de' },
    ],
    empty: 'No hay nada esperando revisión: todo lo que se está vigilando tiene fuente confirmada.',
  },
  vehicles_list: {
    rows: 'vehicles',
    note: 'guidance',
    columns: [
      { key: 'plate', label: 'Placa' },
      { key: 'label', label: 'Cómo le dicen' },
      { key: 'soat.expiresAt', label: 'SOAT vence', kind: 'date' },
      { key: 'rtm.expiresAt', label: 'Tecno vence', kind: 'date' },
      { key: 'totalPendingCop', label: 'Multas', kind: 'money' },
    ],
    empty:
      'No hay ningún vehículo registrado, así que no hay nada cuyo SOAT o tecnomecánica vigilar.',
  },

  // --- Clientes y personas ------------------------------------------------
  clients_search: {
    rows: 'matches',
    columns: [
      { key: 'name', label: 'Cliente' },
      { key: 'nit', label: 'NIT' },
      { key: 'city', label: 'Ciudad' },
      { key: 'statusLabel', label: 'Estado' },
      { key: 'matchedOn', label: 'Emparejó por' },
    ],
    empty:
      'Ningún cliente empareja con eso. Si es nuevo se registra; si es un proveedor o una autoridad, no va en clientes.',
  },
  people_search: {
    rows: 'matches',
    columns: [
      { key: 'name', label: 'Persona' },
      { key: 'email', label: 'Correo' },
      { key: 'title', label: 'Cargo' },
      { key: 'department', label: 'Área' },
      { key: 'source', label: 'De dónde' },
    ],
    empty:
      'No aparece nadie con ese nombre, ni en el directorio de la empresa ni en los contactos.',
  },

  // --- Conocimiento y reuniones ------------------------------------------
  kb_list_spaces: {
    rows: 'spaces',
    columns: [
      { key: 'name', label: 'Espacio' },
      { key: 'kind', label: 'Alcance' },
      { key: 'description', label: 'Qué guarda' },
      { key: 'documents', label: 'Documentos', kind: 'number' },
    ],
    empty: 'No hay ningún espacio de conocimiento creado todavía.',
  },
  meetings_list_transcripts: {
    rows: 'meetings',
    note: 'note',
    columns: [
      { key: 'title', label: 'Reunión' },
      { key: 'startedAt', label: 'Cuándo', kind: 'date' },
      { key: 'durationMinutes', label: 'Minutos', kind: 'number' },
      { key: 'excerpt', label: 'Cómo empieza' },
    ],
    empty:
      'Ninguna reunión de esa ventana dejó transcripción. Si la grabación estuvo apagada, no hay nada que leer y las notas tienen que salir de una persona.',
  },
  gcal_list_events: {
    rows: 'events',
    columns: [
      { key: 'summary', label: 'Evento' },
      { key: 'start', label: 'Empieza', kind: 'date' },
      { key: 'end', label: 'Termina', kind: 'date' },
    ],
    empty: 'No hay ningún evento en esa ventana del calendario.',
  },
  gcal_upcoming_meetings: {
    rows: 'meetings',
    columns: [
      { key: 'title', label: 'Reunión' },
      { key: 'startHuman', label: 'Empieza' },
      { key: 'durationMinutes', label: 'Minutos', kind: 'number' },
      { key: 'location', label: 'Dónde' },
    ],
    empty: 'No tienes ninguna reunión en esa ventana.',
  },

  // --- Correo -------------------------------------------------------------
  gmail_list_threads: {
    rows: 'threads',
    columns: [
      { key: 'date', label: 'Fecha', kind: 'date' },
      { key: 'from', label: 'De' },
      { key: 'subject', label: 'Asunto' },
      { key: 'snippet', label: 'Empieza así' },
    ],
    empty: 'No hay ninguna conversación de correo que empareje con esa búsqueda.',
  },
  outlook_list_threads: {
    rows: 'threads',
    columns: [
      { key: 'date', label: 'Fecha', kind: 'date' },
      { key: 'from', label: 'De' },
      { key: 'subject', label: 'Asunto' },
      { key: 'snippet', label: 'Empieza así' },
    ],
    empty: 'No hay ninguna conversación de correo que empareje con esa búsqueda.',
  },

  // --- Trabajo de producto ------------------------------------------------
  linear_list_issues: {
    rows: 'issues',
    columns: [
      { key: 'identifier', label: 'Clave' },
      { key: 'title', label: 'Tarea' },
      { key: 'state.name', label: 'Estado' },
      { key: 'assignee.name', label: 'Responsable' },
      { key: 'priority', label: 'Prioridad', kind: 'number' },
    ],
    empty: 'No hay ninguna tarea que empareje con esos filtros.',
  },
  linear_list_projects: {
    rows: 'projects',
    columns: [
      { key: 'name', label: 'Proyecto' },
      { key: 'state', label: 'Estado' },
      { key: 'progress', label: 'Avance', kind: 'number' },
      { key: 'targetDate', label: 'Fecha objetivo', kind: 'date' },
    ],
    empty: 'No hay ningún proyecto en Linear.',
  },
  linear_list_teams: {
    rows: 'teams',
    columns: [
      { key: 'key', label: 'Clave' },
      { key: 'name', label: 'Equipo' },
      { key: 'description', label: 'Qué hace' },
    ],
    empty: 'No hay ningún equipo en Linear.',
  },
  github_list_pull_requests: {
    rows: 'pullRequests',
    columns: [
      { key: 'number', label: 'Nº', kind: 'number' },
      { key: 'title', label: 'Cambio' },
      { key: 'state', label: 'Estado' },
      { key: 'author', label: 'Autor' },
      { key: 'baseRef', label: 'Hacia' },
      { key: 'updatedAt', label: 'Movido', kind: 'date' },
    ],
    empty: 'No hay ningún pull request con ese estado en ese repositorio.',
  },
  github_list_repositories: {
    rows: 'repositories',
    columns: [
      { key: 'fullName', label: 'Repositorio' },
      { key: 'description', label: 'Qué es' },
      { key: 'private', label: '¿Privado?' },
      { key: 'defaultBranch', label: 'Rama' },
      { key: 'updatedAt', label: 'Movido', kind: 'date' },
    ],
    empty: 'No hay ningún repositorio al que esta cuenta llegue.',
  },

  // --- CRM ----------------------------------------------------------------
  hubspot_search_deals: {
    rows: 'results',
    columns: [
      { key: 'name', label: 'Negocio' },
      { key: 'stage', label: 'Etapa' },
      { key: 'amount', label: 'Importe', kind: 'money' },
      { key: 'closeDate', label: 'Cierre', kind: 'date' },
    ],
    empty: 'No hay ningún negocio que empareje con esos filtros.',
  },
  hubspot_search_contacts: {
    rows: 'results',
    columns: [
      { key: 'firstName', label: 'Nombre' },
      { key: 'lastName', label: 'Apellido' },
      { key: 'email', label: 'Correo' },
      { key: 'company', label: 'Empresa' },
      { key: 'jobTitle', label: 'Cargo' },
    ],
    empty: 'No hay ningún contacto que empareje con esa búsqueda.',
  },
  hubspot_search_companies: {
    rows: 'results',
    columns: [
      { key: 'name', label: 'Empresa' },
      { key: 'domain', label: 'Dominio' },
      { key: 'industry', label: 'Sector' },
      { key: 'numEmployees', label: 'Empleados', kind: 'number' },
      { key: 'country', label: 'País' },
    ],
    empty: 'No hay ninguna empresa que empareje con esa búsqueda.',
  },
  hubspot_list_recent_activities: {
    rows: 'results',
    columns: [
      { key: 'createdAt', label: 'Cuándo', kind: 'date' },
      { key: 'type', label: 'Qué fue' },
      { key: 'subject', label: 'Asunto' },
    ],
    empty: 'Nadie ha registrado nada con esa cuenta en la ventana que miraste.',
  },

  // --- Guardarraíles ------------------------------------------------------
  security_recent_events: {
    rows: 'events',
    columns: [
      { key: 'createdAt', label: 'Cuándo', kind: 'date' },
      { key: 'toolId', label: 'Herramienta' },
      { key: 'riskLevel', label: 'Riesgo' },
      { key: 'decision', label: 'Qué se hizo' },
      { key: 'reason', label: 'Por qué' },
    ],
    empty:
      'Los guardarraíles no marcaron nada en esa ventana: ni una llamada frenada, ni una pedida de permiso, ni una rechazada.',
  },
};

// ---------------------------------------------------------------------------
// Capa 3 — la forma del resultado, sin que nadie la declare
// ---------------------------------------------------------------------------

export type Structural =
  | { kind: 'table'; rows: Record<string, unknown>[]; columns: string[]; note: string | null }
  | { kind: 'fields'; entries: Array<[string, unknown]>; note: string | null }
  | { kind: 'note'; text: string }
  | null;

/** Campos que son prosa sobre el resultado y no parte de él. */
const NOTE_KEYS = ['guidance', 'summary', 'note', 'message', 'markdown'];

/** Ruido de protocolo que nunca es contenido. */
const HIDDEN_KEYS = new Set(['__error', '__requires_confirmation', '_security', 'ok']);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Un valor que cabe en una celda sin explicación. */
function isScalar(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Qué se puede decir de este resultado sin saber de qué herramienta viene.
 *
 * Deliberadamente conservadora: ante la duda devuelve `null` y quien llama
 * enseña el JSON, que es lo que hacía antes. Adivinar mal la forma de un
 * resultado y dibujar una tabla que se come la mitad de los datos es peor que
 * el JSON, porque el JSON al menos se ve entero.
 */
export function structuralView(result: unknown): Structural {
  if (!isPlainObject(result)) return null;

  const note = NOTE_KEYS.map((k) => result[k]).find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );

  const entries = Object.entries(result).filter(([k]) => !HIDDEN_KEYS.has(k));
  const content = entries.filter(([k]) => !NOTE_KEYS.includes(k));

  // Un único campo array de objetos planos → tabla. Es la forma de
  // `{items: [...]}`, `{flows: [...]}`, `{threads: [...]}` y otras ochenta.
  const arrays = content.filter(
    ([, v]) => Array.isArray(v) && v.length > 0 && v.every(isPlainObject),
  );
  if (arrays.length === 1 && arrays[0]) {
    const rows = arrays[0][1] as Record<string, unknown>[];
    // Columnas de la PRIMERA fila y solo escalares: un objeto anidado en una
    // celda es ilegible, y las filas siguientes que traigan campos de más se
    // quedan fuera a propósito — una tabla cuyas columnas cambian por la fila
    // catorce no es una tabla.
    const columns = Object.entries(rows[0] ?? {})
      .filter(([, v]) => isScalar(v))
      .map(([k]) => k)
      .slice(0, 6);
    // Las filas van ENTERAS. El corte a cincuenta lo hace `ResultGrid`, y no
    // por pereza: recortar aquí es recortar ANTES de que nadie pueda ordenar, y
    // entonces «ordenar por importe» ordena las cincuenta primeras y enseña el
    // máximo de una muestra como si fuera el máximo. Se pintan cincuenta
    // igual, y la rejilla dice cuántas hay.
    if (columns.length > 0) {
      return { kind: 'table', rows, columns, note: note ?? null };
    }
  }

  // Un objeto plano y corto → lista de campos.
  const scalars = content.filter(([, v]) => isScalar(v));
  if (scalars.length > 0 && scalars.length <= 8 && scalars.length === content.length) {
    return { kind: 'fields', entries: scalars, note: note ?? null };
  }

  // Solo una frase, sin datos que enseñar.
  if (note && content.length === 0) return { kind: 'note', text: note };

  return null;
}

// ---------------------------------------------------------------------------
// Resolución
// ---------------------------------------------------------------------------

export type Resolved =
  | { as: 'rich'; View: ResultView }
  | { as: 'table'; spec: TableSpec }
  | { as: 'step' };

/**
 * Cómo se dibuja el resultado de esta llamada.
 *
 * Mira el id, y sólo mira el resultado para las poquísimas herramientas que
 * declararon en `RICH_NEEDS` qué necesitan para poder dibujar. Un gráfico sin
 * `chartId` no es un gráfico roto: es un paso, igual que antes de que este
 * archivo existiera. Lo que la vista haga con lo que sí le llega —cuántas filas
 * enseña, qué dice cuando vienen cero— sigue siendo suya.
 *
 * Sin `result` la resolución es sólo por id, que es lo que quiere quien pregunta
 * «¿esta herramienta tiene vista propia?» sin tener una llamada delante.
 */
export function resolveView(toolName: string, result?: unknown): Resolved {
  const id = normalizeToolId(toolName);
  const View = RICH[id];
  if (View) {
    const needs = RICH_NEEDS[id];
    if (!needs || result === undefined || needs(result)) return { as: 'rich', View };
  }
  const spec = TABLE[id];
  if (spec) return { as: 'table', spec };
  return { as: 'step' };
}
