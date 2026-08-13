import {
  type ClientSeed,
  type CommitmentSeed,
  type DocumentSeed,
  type FlowSeed,
  type OpenerSeeds,
  type OpenersResponse,
  type ReportSeed,
  type VehicleSeed,
  buildOpeners,
} from '@/lib/chat-openers-shape';
import { type ToolAvailability, usableToolIds } from '@/lib/chat-palette-tools';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns } from '@/lib/tool-access';
import { credentialRequirement, familyOf } from '@/lib/tool-taxonomy';
import { bogotaToday, listTools } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * CON QUÉ SE SIEMBRA LA PRIMERA PANTALLA DEL CHAT.
 *
 * La regla y el porqué están en `lib/chat-openers-shape.ts`; aquí sólo se leen
 * las filas y se le entregan a `buildOpeners`, que es puro y es lo que las
 * pruebas cubren. Esta ruta no decide nada: junta.
 *
 * ===========================================================================
 * QUÉ CUESTA DIBUJAR ESTA PANTALLA
 * ===========================================================================
 * CERO tokens y CERO llamadas al modelo. Nada de esto pasa por Anthropic ni por
 * Voyage: las seis frases se arman con reglas sobre filas que ya existen. Lo
 * único que se gasta son nueve lecturas acotadas a Supabase, en paralelo, todas
 * con `limit` de un dígito y por índice, más `listTools()`, que es una constante
 * compilada. En el navegador se cachea cinco minutos por conversación nueva.
 *
 * Un modelo redactando estas mismas tarjetas costaría dinero y medio segundo
 * cada vez que alguien abre un chat, y las escribiría PEOR: no sabe cómo se
 * llama el contrato que subieron ayer ni qué se vence el jueves. Estas reglas
 * sí, porque lo están leyendo.
 *
 * ===========================================================================
 * NINGUNA LECTURA PUEDE TUMBAR A LAS DEMÁS, Y NINGUNA PUEDE MENTIR
 * ===========================================================================
 * Cada `error` de Supabase se comprueba. La familia que falla simplemente no
 * aporta sugerencias — pero su nombre viaja en `failed`, y `buildOpeners` lo
 * convierte en un aviso visible y, sobre todo, impide que la pantalla se dibuje
 * como «este espacio está vacío». Un espacio lleno cuya consulta falló y un
 * espacio recién creado se ven idénticos si nadie los distingue, y sólo uno de
 * los dos necesita que le digan que conecte una fuente.
 */

/**
 * Dos de cada cosa alcanzan: sólo la primera de cada familia llega casi siempre
 * a la pantalla, y la segunda existe para cuando otra familia viene vacía.
 */
const PER_FAMILY = 2;

/**
 * Cuántas filas de auditoría se miran para saber qué familias ya se tocaron.
 *
 * Deliberadamente pequeño y deliberadamente NO `lib/tool-usage.ts`, que escanea
 * hasta 5000 filas para el centro de control de herramientas. Aquí no hace
 * falta un número, hace falta un conjunto: qué familias suenan de algo. 200
 * filas por el índice `(organization_id, created_at desc)` responden eso, y si
 * el recorte deja fuera una familia usada hace un mes, el único efecto es que
 * una sugerencia sale antes de lo que le tocaba. Nadie lo nota; una consulta
 * lenta en la pantalla que más se abre, sí.
 */
const USAGE_SCAN = 200;

interface DocRow {
  id: string;
  title: string;
  created_at: string;
  media_kind: string | null;
}

export async function GET(req: NextRequest): Promise<NextResponse<OpenersResponse>> {
  const user = await requireSession();
  const agentSlug = (req.nextUrl.searchParams.get('agent') ?? '').trim();
  const db = getOrgScopedClient(user.organization.id);
  const today = bogotaToday();

  const [
    documents,
    clients,
    commitments,
    vehicles,
    reports,
    flows,
    routines,
    agents,
    integrations,
    usage,
    denied,
  ] = await Promise.all([
    db
      .from('kb_documents')
      .select('id, title, created_at, media_kind')
      // Un documento que todavía se está leyendo no se puede citar, así que
      // preguntarle algo devolvería un «no encontré nada» sobre un archivo que
      // la persona acaba de ver subir. Misma regla que en /api/chat/mentions.
      .eq('status', 'ready')
      .order('created_at', { ascending: false })
      .limit(PER_FAMILY),
    db
      .from('clients')
      .select('id, name, city')
      .in('status', ['active', 'prospect'])
      .order('updated_at', { ascending: false })
      .limit(PER_FAMILY),
    // El que está MÁS CERCA, incluidos los ya vencidos: un SOAT que se venció
    // el martes es la pregunta más urgente que tiene esa empresa y esconderla
    // sería el único error grave posible en esta pantalla. `confirmed` porque
    // un vencimiento extraído de un documento y sin revisar todavía no es un
    // hecho — ver migración 0069.
    db
      .from('commitments')
      .select('id, title, due_on, kind, counterparty')
      .in('state', ['in_force', 'due_soon', 'overdue'])
      .eq('review_state', 'confirmed')
      .order('due_on', { ascending: true })
      .limit(PER_FAMILY),
    // Las placas son de la persona, no del espacio de trabajo: `vehicles.get`
    // filtra por `user_id`, así que ofrecer la de un colega sería ofrecer algo
    // que la herramienta del siguiente turno no encuentra.
    db
      .from('vehicles')
      .select('id, plate, label')
      .eq('user_id', user.id)
      .eq('archived', false)
      .order('updated_at', { ascending: false })
      .limit(1),
    db.from('reports').select('id, title').order('created_at', { ascending: false }).limit(1),
    db
      .from('browser_flows')
      .select('slug, name')
      .eq('status', 'ready')
      // Un trámite que radica o envía algo no se propone como primera pregunta
      // de nadie: la pantalla de bienvenida no es el sitio para descubrir que
      // se acaba de radicar un formulario.
      .eq('effect', 'read')
      .order('name', { ascending: true })
      .limit(1),
    db
      .from('scheduled_jobs')
      .select('id')
      .eq('user_id', user.id)
      .in('status', ['active', 'paused'])
      .limit(1),
    db.from('agents').select('slug, allowed_tool_ids').eq('archived', false),
    db.from('integrations').select('provider').eq('user_id', user.id),
    db
      .from('audit_events')
      .select('tool_id')
      .order('created_at', { ascending: false })
      .limit(USAGE_SCAN),
    deniedToolPatterns(db, user.id),
  ]);

  const failed: string[] = [];

  const seedOf = <Row, Seed>(
    result: { data: unknown; error: unknown },
    label: string,
    map: (row: Row) => Seed,
  ): Seed[] => {
    if (result.error) {
      console.error(`[chat/openers] ${label} read failed:`, result.error);
      failed.push(label);
      return [];
    }
    return ((result.data ?? []) as Row[]).map(map);
  };

  const documentSeeds = seedOf<DocRow, DocumentSeed>(documents, 'los documentos', (row) => ({
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    mediaKind: row.media_kind ?? 'text',
  }));

  const clientSeeds = seedOf<{ id: string; name: string; city: string | null }, ClientSeed>(
    clients,
    'los clientes',
    (row) => ({ id: row.id, name: row.name, city: row.city }),
  );

  const commitmentSeeds = seedOf<
    { id: string; title: string; due_on: string; kind: string; counterparty: string | null },
    CommitmentSeed
  >(commitments, 'los vencimientos', (row) => ({
    id: row.id,
    title: row.title,
    dueOn: row.due_on,
    kind: row.kind,
    counterparty: row.counterparty,
  }));

  const vehicleSeeds = seedOf<{ id: string; plate: string; label: string | null }, VehicleSeed>(
    vehicles,
    'los vehículos',
    (row) => ({ id: row.id, plate: row.plate, label: row.label }),
  );

  const reportSeeds = seedOf<{ id: string; title: string }, ReportSeed>(
    reports,
    'los informes',
    (row) => ({ id: row.id, title: row.title }),
  );

  const flowSeeds = seedOf<{ slug: string; name: string }, FlowSeed>(
    flows,
    'los trámites',
    (row) => ({ slug: row.slug, name: row.name }),
  );

  // Estas tres no aportan sugerencias por sí solas, así que un fallo suyo no se
  // anuncia: sólo afinan cuál de las que ya hay sale antes.
  if (routines.error) console.error('[chat/openers] scheduled_jobs read failed:', routines.error);
  if (agents.error) console.error('[chat/openers] agents read failed:', agents.error);
  if (usage.error) console.error('[chat/openers] audit_events read failed:', usage.error);

  const agentRows = (agents.data ?? []) as { slug: string; allowed_tool_ids: string[] | null }[];
  const active = agentRows.find((row) => row.slug === agentSlug);
  // Sin un agente identificado, la unión de lo que conceden todos los activos:
  // lo más generoso que sigue siendo cierto, porque cada una de esas
  // herramientas la puede ejecutar ALGÚN agente de este espacio. Mismo criterio
  // que /api/chat/commands.
  const granted = active
    ? (active.allowed_tool_ids ?? [])
    : agentRows.flatMap((row) => row.allowed_tool_ids ?? []);

  // Una integración que no se pudo leer se trata como no conectada. Es la
  // dirección segura del error: recorta sugerencias en vez de ofrecer una que
  // va a chocar contra un buzón sin conectar.
  if (integrations.error) {
    console.error('[chat/openers] integrations read failed:', integrations.error);
    failed.push('las integraciones');
  }
  const connectedProviders = new Set(
    ((integrations.data ?? []) as { provider: string }[]).map((row) => row.provider),
  );
  // HubSpot corre con un token de aplicación privada de todo el espacio cuando
  // está configurado, así que nadie lo conecta individualmente.
  if (process.env.HUBSPOT_PRIVATE_APP_TOKEN) connectedProviders.add('hubspot');

  const availability: ToolAvailability[] = listTools()
    .filter((tool) => !tool.id.startsWith('test.'))
    .map((tool) => {
      const requirement = credentialRequirement(tool.id);
      return {
        id: tool.id,
        providers: [...new Set((tool.requiredScopes ?? []).map((scope) => scope.provider))],
        // Sólo NOMBRES de variables salen de aquí; el valor nunca deja el servidor.
        missingCredentials: requirement
          ? requirement.vars.filter((name) => !process.env[name])
          : [],
        blockingCredential: requirement?.blocking ?? true,
      };
    });

  const seeds: OpenerSeeds = {
    today,
    orgName: user.organization.name ?? null,
    documents: documentSeeds,
    clients: clientSeeds,
    commitments: commitmentSeeds,
    vehicles: vehicleSeeds,
    reports: reportSeeds,
    flows: flowSeeds,
    routineCount: (routines.data ?? []).length,
    usableToolIds: usableToolIds(availability, {
      denied,
      granted,
      connectedProviders,
    }),
    connectedProviders: [...connectedProviders],
    usedFamilies: [
      ...new Set(
        ((usage.data ?? []) as { tool_id: string }[])
          .map((row) => familyOf(row.tool_id))
          // El turno completo del agente se archiva bajo un id falso que no es
          // una familia de nada.
          .filter((family) => family !== '__agent_turn'),
      ),
    ],
    failed,
  };

  return NextResponse.json(buildOpeners(seeds));
}
