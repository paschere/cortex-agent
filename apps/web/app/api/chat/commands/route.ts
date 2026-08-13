import { MODULE } from '@/lib/browser-shape';
import type { PaletteGroup, PaletteItem, PaletteResponse } from '@/lib/chat-palette-shape';
import {
  type ToolAvailability,
  type WorkspaceTool,
  cronPhrase,
  dropDuplicateCommands,
  siteName,
  toolPaletteGroups,
  usableToolIds,
} from '@/lib/chat-palette-tools';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { deniedToolPatterns } from '@/lib/tool-access';
import { credentialRequirement } from '@/lib/tool-taxonomy';
import { CUSTOM_TOOLS_TABLE, listTools } from '@cortex/agent-tools';
import { type NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * TODO LO QUE EL `/` PUEDE HACER, EN UNA SOLA RESPUESTA Y YA AGRUPADO.
 *
 * ===========================================================================
 * POR QUÉ ESTA RUTA NO RECIBE UNA CONSULTA
 * ===========================================================================
 * Porque el filtrado del `/` pasa en el navegador, y esa decisión es de coste.
 *
 * Lo que hay detrás del `/` está ACOTADO y es casi estático: las rutinas, los
 * flujos, los trámites y los encargos de un espacio de trabajo se cuentan por
 * decenas, y el catálogo de herramientas es una constante compilada. Todo junto
 * cabe holgadamente en unos pocos kilobytes de JSON. Buscar eso en el servidor
 * a cada pulsación serían siete consultas a Supabase por letra tecleada —
 * treinta o cuarenta por comando escrito, contra un pool compartido, y con la
 * latencia de red metida entre la tecla y la fila resaltada. Un menú que
 * parpadea mientras escribes es un menú que la gente deja de usar.
 *
 * Así que se carga UNA vez al abrirse el menú, con `staleTime` de cinco minutos
 * en el cliente, y se filtra en memoria. Rutinas o trámites creados en otra
 * pestaña tardan como mucho esos cinco minutos en aparecer, que es un precio
 * que nadie nota.
 *
 * El `@` hace lo CONTRARIO y por la razón contraria: clientes, contactos,
 * documentos y placas no están acotados —son miles de filas y crecen— así que
 * ahí sí se busca en el servidor con debounce. Ver /api/chat/mentions.
 *
 * ===========================================================================
 * UNA CONSULTA QUE FALLA NO ES UNA LISTA VACÍA
 * ===========================================================================
 * Cada sección se lee por separado y cada `error` de Supabase se comprueba. Si
 * una falla, la sección viaja con su `error` y el menú lo dibuja: «no pude leer
 * tus rutinas» y «no tienes rutinas» son dos frases distintas, y sólo una de
 * las dos hace que alguien vaya a crear la rutina que ya existe.
 */

/** Cuántas filas se traen por sección. El menú filtra sobre esto, no sobre la tabla. */
const PER_SECTION = 25;
const ERRAND_LIMIT = 15;

interface JobRow {
  id: string;
  name: string;
  kind: string;
  schedule_kind: string;
  cron: string | null;
  timezone: string;
  status: string;
  next_run_at: string | null;
}

interface PipelineRow {
  slug: string;
  name: string;
  description: string | null;
  emoji: string | null;
  times_run: number | null;
}

interface FlowRow {
  slug: string;
  name: string;
  description: string | null;
  /** `scheme://host`, derivado de `start_url` al escribir. Ver migración 0087. */
  host: string | null;
  status: string;
  effect: string;
}

interface ErrandRow {
  id: string;
  request: string;
  state: string;
}

interface AgentRow {
  slug: string;
  allowed_tool_ids: string[] | null;
}

const ERRAND_STATE_LABEL: Record<string, string> = {
  queued: 'en cola',
  working: 'trabajando',
  blocked: 'esperando tu respuesta',
  watching: 'vigilando',
  delivered: 'entregado',
  failed: 'falló',
  cancelled: 'cancelado',
  exhausted: 'sin presupuesto',
};

/** Una frase larga recortada donde no duela, para caber en una fila. */
function clip(value: string, max = 70): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export async function GET(req: NextRequest): Promise<NextResponse<PaletteResponse>> {
  const user = await requireSession();
  const agentSlug = (req.nextUrl.searchParams.get('agent') ?? '').trim();
  const db = getOrgScopedClient(user.organization.id);

  const [jobs, pipelines, flows, errands, agents, integrations, customTools, denied] =
    await Promise.all([
      // Las rutinas son de la persona, no del espacio de trabajo: `schedule.list`
      // filtra por `user_id` y ofrecer aquí las de un colega sería ofrecer algo
      // que la herramienta no va a encontrar.
      db
        .from('scheduled_jobs')
        .select('id, name, kind, schedule_kind, cron, timezone, status, next_run_at')
        .eq('user_id', user.id)
        .in('status', ['active', 'paused'])
        .order('next_run_at', { ascending: true, nullsFirst: false })
        .limit(PER_SECTION),
      db
        .from('pipelines')
        .select('slug, name, description, emoji, times_run')
        .eq('archived', false)
        .order('times_run', { ascending: false })
        .limit(PER_SECTION),
      db
        .from('browser_flows')
        .select('slug, name, description, host, status, effect')
        .neq('status', 'broken')
        .order('name', { ascending: true })
        .limit(PER_SECTION),
      db
        .from('errands')
        .select('id, request, state')
        .order('created_at', { ascending: false })
        .limit(ERRAND_LIMIT),
      db.from('agents').select('slug, allowed_tool_ids').eq('archived', false),
      db.from('integrations').select('provider').eq('user_id', user.id),
      db
        .from(CUSTOM_TOOLS_TABLE)
        .select('slug, name, description')
        .eq('enabled', true)
        .order('name', { ascending: true }),
      deniedToolPatterns(db, user.id),
    ]);

  const groups: PaletteGroup[] = [];

  // --- Rutinas -------------------------------------------------------------
  if (jobs.error) {
    console.error('[chat/commands] scheduled_jobs read failed:', jobs.error);
    groups.push({
      id: 'rutinas',
      heading: 'Rutinas',
      icon: 'AlarmClock',
      items: [],
      error: 'No pude leer tus rutinas.',
    });
  } else {
    const items: PaletteItem[] = ((jobs.data ?? []) as JobRow[]).map((job) => ({
      id: job.id,
      label: job.name,
      hint: `${cronPhrase(job.cron, job.timezone)}${job.status === 'paused' ? ' · pausada' : ''}`,
      // Correrla AHORA es lo que alguien quiere del chat; para cambiarle la hora
      // está la pantalla, que muestra el historial al lado.
      expands: `Corre ahora la rutina «${job.name}».`,
      keywords: `rutina programada cron ${job.kind}`,
    }));
    if (items.length > 0) {
      groups.push({ id: 'rutinas', heading: 'Rutinas', icon: 'AlarmClock', items });
    }
  }

  // --- Flujos --------------------------------------------------------------
  if (pipelines.error) {
    console.error('[chat/commands] pipelines read failed:', pipelines.error);
    groups.push({
      id: 'flujos',
      heading: 'Flujos',
      icon: 'Workflow',
      items: [],
      error: 'No pude leer los flujos.',
    });
  } else {
    const items: PaletteItem[] = ((pipelines.data ?? []) as PipelineRow[]).map((pipeline) => ({
      id: pipeline.slug,
      label: `${pipeline.emoji ?? '⚡'} ${pipeline.name}`.trim(),
      hint: pipeline.description ? clip(pipeline.description) : 'Instructivo guardado',
      expands: `Ejecuta el flujo «${pipeline.name}» `,
      keywords: `flujo pipeline instructivo ${pipeline.slug}`,
    }));
    if (items.length > 0) {
      groups.push({ id: 'flujos', heading: 'Flujos', icon: 'Workflow', items });
    }
  }

  // --- Trámites ------------------------------------------------------------
  if (flows.error) {
    console.error('[chat/commands] browser_flows read failed:', flows.error);
    groups.push({
      id: 'tramites',
      heading: MODULE.label,
      icon: 'Globe',
      items: [],
      error: `No pude leer los ${MODULE.many}.`,
    });
  } else {
    const items: PaletteItem[] = ((flows.data ?? []) as FlowRow[]).map((flow) => ({
      id: flow.slug,
      label: flow.name,
      hint:
        [
          siteName(flow.host),
          flow.status === 'draft' ? 'sin probar todavía' : null,
          flow.effect === 'write' ? 'radica o envía' : null,
        ]
          .filter(Boolean)
          .join(' · ') || null,
      expands: `Corre el ${MODULE.one} «${flow.name}» `,
      keywords: `${MODULE.many} portal ${flow.slug} ${siteName(flow.host) ?? ''}`,
    }));
    if (items.length > 0) {
      groups.push({ id: 'tramites', heading: MODULE.label, icon: 'Globe', items });
    }
  }

  // --- Encargos ------------------------------------------------------------
  if (errands.error) {
    console.error('[chat/commands] errands read failed:', errands.error);
    groups.push({
      id: 'encargos',
      heading: 'Encargos',
      icon: 'Telescope',
      items: [],
      error: 'No pude leer los encargos.',
    });
  } else {
    const items: PaletteItem[] = ((errands.data ?? []) as ErrandRow[]).map((errand) => ({
      id: errand.id,
      label: clip(errand.request),
      hint: ERRAND_STATE_LABEL[errand.state] ?? errand.state,
      expands: `¿Cómo va el encargo «${clip(errand.request, 60)}»?`,
      keywords: `encargo investigacion ${errand.state}`,
    }));
    if (items.length > 0) {
      groups.push({ id: 'encargos', heading: 'Encargos', icon: 'Telescope', items });
    }
  }

  // --- Herramientas --------------------------------------------------------
  if (agents.error) console.error('[chat/commands] agents read failed:', agents.error);
  if (integrations.error) {
    console.error('[chat/commands] integrations read failed:', integrations.error);
  }
  if (customTools.error) {
    console.error('[chat/commands] custom_tools read failed:', customTools.error);
  }

  const agentRows = (agents.data ?? []) as AgentRow[];
  const active = agentRows.find((row) => row.slug === agentSlug);
  // Sin un agente identificado, la unión de lo que conceden todos los agentes
  // activos. Es lo más generoso que sigue siendo cierto: cada una de esas
  // herramientas la puede ejecutar ALGÚN agente de este espacio de trabajo.
  const granted = active
    ? (active.allowed_tool_ids ?? [])
    : agentRows.flatMap((row) => row.allowed_tool_ids ?? []);

  const connectedProviders = new Set(
    ((integrations.data ?? []) as { provider: string }[]).map((row) => row.provider),
  );
  // HubSpot corre con un token de aplicación privada de todo el espacio de
  // trabajo cuando está configurado, así que nadie lo conecta individualmente.
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

  const workspaceTools: WorkspaceTool[] = (
    (customTools.data ?? []) as { slug: string; name: string; description: string | null }[]
  ).map((row) => ({ id: row.slug, name: row.name, description: row.description ?? '' }));

  // Las herramientas de un servidor MCP conectado NO entran, y no por olvido:
  // enumerarlas es una petición HTTP por servidor registrado, y esta ruta la
  // dispara abrir un menú. Un `/` que tarda dos segundos porque el MCP de
  // alguien está caído no es un menú, es una espera.
  const toolGroups = toolPaletteGroups(
    usableToolIds(availability, { denied, granted, connectedProviders }),
    workspaceTools,
  );
  groups.push(...toolGroups);

  return NextResponse.json({ groups: dropDuplicateCommands(groups) });
}
