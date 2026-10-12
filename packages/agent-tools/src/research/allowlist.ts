import type { AnyTool } from '../types';

/**
 * QUÉ PUEDE USAR UNA SUB-EJECUCIÓN DE LA INVESTIGACIÓN EN PARALELO.
 *
 * Una pieza de `research.parallel` corre sola: nadie la mira, nadie puede
 * aprobarle nada y hay hasta 50 a la vez. Por eso sólo recibe herramientas de
 * LECTURA, y la lista es EXPLÍCITA (id por id): una herramienta nueva no entra
 * por parecerse a una de lectura, entra cuando alguien la escribe aquí.
 *
 * Es una lista blanca con CUATRO cerrojos, y los cuatro tienen que cumplirse:
 *   1. el id está en `RESEARCH_READ_TOOLS`;
 *   2. la herramienta no pide confirmación (si la pide, tiene efectos);
 *   3. no declara importe (`declaredAmount`: mueve dinero) ni política de
 *      acción segura (`safeAction`: es una acción de repetir con cuidado);
 *   4. el nombre de la acción no lleva un verbo de escritura. Es redundante
 *      con la lista a propósito: si alguien añade `gmail.send_x` por error, este
 *      cerrojo lo detiene.
 *
 * Navegador (`browser.*`), correo/chat salientes, escrituras contables y todo
 * lo demás quedan fuera por no estar en la lista.
 */
export const RESEARCH_READ_TOOLS: ReadonlySet<string> = new Set([
  // La web: lo que hay que mirar afuera.
  'web.search',
  'web.news',
  'web.scrape',
  // El cerebro de la empresa.
  'kb.search',
  'kb.context',
  'kb.list_spaces',
  // Tablas, libro de plata, contabilidad.
  'trackers.list',
  'trackers.query',
  'ledger.query',
  'ledger.forecast',
  'accounting.status',
  // Correo (sólo buscar y leer).
  'gmail.search',
  'gmail.list_threads',
  'gmail.read_thread',
  'outlook.search',
  'outlook.list_threads',
  'outlook.read_thread',
  // Drive y hojas (sólo leer).
  'gdrive.search_files',
  'gdrive.find_folder',
  'gdrive.folder_tree',
  'gdrive.read_doc',
  'gsheets.read_range',
  // Documentos, contratos, cartera, clientes, inventario, flota.
  'documents.records',
  'documents.expiring',
  'documents.totals',
  'contracts.list',
  'contracts.obligations',
  'payments.list',
  'payments.receivables',
  'clients.search',
  'clients.directory',
  'clients.overview',
  'people.search',
  'inventory.stock',
  'vehicles.get',
  'vehicles.list',
  'statements.get',
  'sales.list',
  'crm.pipeline',
  'hubspot.search_companies',
  'hubspot.search_contacts',
  'hubspot.search_deals',
  'hubspot.get_company',
  'hubspot.get_contact',
  'hubspot.get_deal',
  'company.facts',
  'tax.calendar',
  'projects.status',
  'work.query',
  'commitments.due_soon',
  'meetings.list_transcripts',
  'meetings.get_transcript',
]);

/** Verbos que delatan una escritura o un envío en el nombre de la acción. */
const WRITE_VERB =
  /(?:^|_)(?:send|write|create|update|delete|remove|set|post|draft|approve|pay|record|upload|archive|register|invite|join|speak|run|act|submit|merge|configure|share|sync|propose|emit|reply|assign|move|import|confirm|reject|mark|log|reorder|receive|schedule|publish|apply|resolve|decide|train|promote|open|click|type|fill|login)(?:_|$)/;

export class ResearchToolRejected extends Error {
  constructor(
    readonly toolId: string,
    readonly why: string,
  ) {
    super(`research.parallel: ${toolId} no está permitida en una sub-ejecución (${why}).`);
    this.name = 'ResearchToolRejected';
  }
}

/** Motivo por el que NO se permite, o `null` si pasa los cuatro cerrojos. */
export function researchRejection(
  tool: Pick<AnyTool, 'id' | 'requiresConfirmation' | 'declaredAmount' | 'safeAction'>,
): string | null {
  if (!RESEARCH_READ_TOOLS.has(tool.id)) return 'no está en la lista de lectura';
  if (tool.requiresConfirmation) return 'pide confirmación';
  if (tool.declaredAmount) return 'mueve dinero';
  if (tool.safeAction) return 'es una acción con efectos';
  const action = tool.id.slice(tool.id.indexOf('.') + 1);
  if (WRITE_VERB.test(action)) return 'su nombre es de escritura';
  return null;
}

export function isResearchAllowed(tool: Parameters<typeof researchRejection>[0]): boolean {
  return researchRejection(tool) === null;
}

/** Lanza si la herramienta no es de lectura. La última puerta antes de ejecutar. */
export function assertResearchAllowed(tool: Parameters<typeof researchRejection>[0]): void {
  const why = researchRejection(tool);
  if (why) throw new ResearchToolRejected(tool.id, why);
}

/**
 * De todo el registro, lo que una pieza puede usar: la lista de lectura
 * INTERSECADA con lo que el agente que llama tiene concedido. Sin `granted`
 * (no se sabe qué tiene concedido) no pasa ninguna.
 */
export function researchToolsFrom(
  all: readonly AnyTool[],
  granted: readonly string[] | undefined,
): AnyTool[] {
  const grant = new Set(granted ?? []);
  return all.filter((t) => grant.has(t.id) && isResearchAllowed(t));
}
