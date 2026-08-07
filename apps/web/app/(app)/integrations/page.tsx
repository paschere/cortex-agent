import { DirectionPair } from '@/components/connect/DirectionPair';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import {
  PRICES_CHECKED_ON,
  embeddingConfig,
  listTools,
  readEmbeddingSpend,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  Boxes,
  Brain,
  Building2,
  CircleCheck,
  Gauge,
  GitBranch,
  Globe,
  Inbox,
  ListTodo,
  Mail,
  MessageCircle,
  MessageSquare,
  Plug,
  Server,
  Sparkles,
  TriangleAlert,
  Users,
  Wallet,
  Wrench,
} from 'lucide-react';
import Link from 'next/link';
import { AddMcpServerForm } from './_components/AddMcpServerForm';
import { type McpServer, McpServerList } from './_components/McpServerList';

const MAX_MCP_SERVERS = 5;
const MAX_MCP_TOOLS = 50;

/** Connected for the whole team, connected by this person, or not at all. */
type ConnState = 'workspace' | 'user' | 'disconnected';

interface ProviderCard {
  key: string;
  name: string;
  icon: typeof Mail;
  /** Tool families this system backs — drives the live tool count. */
  families: string[];
  state: ConnState;
  /** Plain language: what Cortex can do because this is connected. */
  unlocks: string;
  /** Plain language: what stops working while it is disconnected. */
  offline: string;
  /** Who turned it on — or who would have to. */
  owner: string;
  connectHref?: string;
  /** Overrides the "Conectar" label when the card leads to a settings screen. */
  ctaLabel?: string;
  /** Replaces the tool count for a system that is a channel, not a toolbox. */
  footNote?: string;
}

/**
 * A connection is a document in force or one that never arrived. Amber, not
 * grey, for the missing ones: it is something to act on, not a neutral fact.
 */
const STATE_TAG: Record<ConnState, { label: string; cls: string }> = {
  workspace: { label: 'Conectada · equipo', cls: 'border-emerald/40 bg-emerald-soft text-emerald' },
  user: { label: 'Conectada · tú', cls: 'border-emerald/40 bg-emerald-soft text-emerald' },
  disconnected: { label: 'Sin conectar', cls: 'border-amber/40 bg-amber-soft text-amber' },
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('es-CO', {
    day: 'numeric',
    month: 'short',
  });
}

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const db = getOrgScopedClient(user.organization.id);

  // Every OAuth row, not just this user's: "who connected it" is part of the
  // answer, and a team-sized table makes this a cheap read.
  const { data: integrationRows } = await db
    .from('integrations')
    .select('provider, scopes, updated_at, user_id')
    .limit(1000);

  const rows = (integrationRows ?? []) as Array<{
    provider: string;
    scopes: string[] | null;
    updated_at: string | null;
    user_id: string;
  }>;

  const mine: Record<string, (typeof rows)[number]> = {};
  const teammates: Record<string, number> = {};
  for (const r of rows) {
    if (r.user_id === user.id) mine[r.provider] = r;
    else teammates[r.provider] = (teammates[r.provider] ?? 0) + 1;
  }

  /** Owner line for a per-user OAuth provider. */
  function personalOwner(provider: string): string {
    const own = mine[provider];
    if (own) {
      const when = fmtDate(own.updated_at);
      return when ? `La conectaste tú · ${when}` : 'La conectaste tú';
    }
    const n = teammates[provider] ?? 0;
    if (n > 0) {
      return `${n} ${n === 1 ? 'compañero la conectó' : 'compañeros la conectaron'}; tu cuenta no`;
    }
    return 'Nadie la ha conectado todavía';
  }

  /** Owner line for a workspace credential provisioned by ops. */
  function opsOwner(connected: boolean, what: string): string {
    return connected
      ? 'La configuró el equipo técnico · la usa toda la organización'
      : `Falta que el equipo técnico la habilite: ${what}`;
  }

  // Tool counts per family, straight from the live registry.
  const toolsByFamily: Record<string, number> = {};
  for (const t of listTools()) {
    if (t.id.startsWith('test.')) continue;
    const fam = t.id.split('.')[0] ?? '';
    toolsByFamily[fam] = (toolsByFamily[fam] ?? 0) + 1;
  }
  const famCount = (families: string[]) =>
    families.reduce((sum, f) => sum + (toolsByFamily[f] ?? 0), 0);

  const googleScopes = (mine.google?.scopes ?? []).length;
  const microsoftScopes = (mine.microsoft?.scopes ?? []).length;
  // Whether the Azure app registration exists at all. Without it the card says
  // "ask the technical team" instead of offering a button that answers 409.
  const microsoftConfigured =
    !!process.env.MICROSOFT_CLIENT_ID && !!process.env.MICROSOFT_REDIRECT_URI;
  const hubspotWorkspace = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const matcherOn = !!process.env.MATCHER_URL;
  const payrollOn = !!process.env.PAYROLL_API_URL;
  // Two different keys, reported as one card because they fail as one product.
  // Reasoning runs on Claude; retrieval by MEANING additionally needs Voyage.
  // Losing the second is a degradation (keyword search still works), losing the
  // first is an outage — so only the first switches the card off.
  const brainOn = !!process.env.ANTHROPIC_API_KEY;
  // Which embedding provider this deployment is actually pointed at, and what it
  // has cost lately. Both live here rather than on the Brain Knowledge screen
  // because this is the page about credentials somebody in ops owns, and the
  // thing that went wrong was a credential nobody was watching.
  const embedding = embeddingConfig();
  const embeddingOk = !('error' in embedding);
  const semanticSearchOn = embeddingOk && embedding.keyConfigured;
  const spend = await readEmbeddingSpend(db, { days: 30 });
  const webOn = !!process.env.TAVILY_API_KEY;
  const slackOn = !!process.env.SLACK_BOT_TOKEN;

  // WhatsApp is not a credential somebody pastes: it is a phone that was paired
  // and a set of decisions about it. The card reports the connection and hands
  // off to /integrations/whatsapp, where all of it is configured.
  const { data: waSession } = await db
    .from('whatsapp_sessions')
    .select('status, phone_number, last_seen_at')
    .maybeSingle();
  const waStatus = (waSession?.status as string | null) ?? 'disconnected';
  const waAlive =
    Date.now() - Date.parse((waSession?.last_seen_at as string | null) ?? '') < 3 * 60_000;
  const waOn = waStatus === 'connected' && waAlive;

  const { data: waGroupRows } = await db
    .from('whatsapp_groups')
    .select('archive_enabled, reply_enabled')
    .or('archive_enabled.eq.true,reply_enabled.eq.true')
    .limit(500);
  const waGroups = (waGroupRows ?? []).length;

  const { count: waLinkCount } = await db
    .from('whatsapp_links')
    .select('phone_e164', { count: 'exact', head: true });
  const waLinks = waLinkCount ?? 0;
  // The one fact that decides whether Cortex answers this person on WhatsApp.
  const { data: myWaLink } = await db
    .from('whatsapp_links')
    .select('phone_e164')
    .eq('user_id', user.id)
    .maybeSingle();

  const providers: ProviderCard[] = [
    {
      key: 'google',
      name: 'Google Workspace',
      icon: Mail,
      families: ['gmail', 'gcal', 'gsheets', 'gdrive', 'meetings', 'chat'],
      state: mine.google ? 'user' : 'disconnected',
      unlocks:
        'Leer y redactar tu correo, ver y crear eventos del calendario, abrir archivos de Docs, Sheets y Drive, y traer transcripciones de reuniones.',
      offline:
        'Sin correo, sin calendario, sin Drive y sin notas de reuniones: Cortex no ve nada de tu día.',
      owner: mine.google
        ? `La conectaste tú${googleScopes ? ` · ${googleScopes} permisos otorgados` : ''}`
        : 'Se otorga al entrar. Si la saltaste, conéctala aquí',
      connectHref: mine.google ? undefined : '/api/integrations/google?preset=all',
    },
    {
      key: 'microsoft',
      name: 'Microsoft 365',
      icon: Inbox,
      families: ['outlook', 'mscal'],
      state: mine.microsoft ? 'user' : 'disconnected',
      unlocks:
        'Leer y buscar tu correo de Outlook, leer un hilo completo, dejar borradores y enviarlos, ver y crear eventos del calendario, y guardar en Brain Knowledge la correspondencia con clientes y proveedores.',
      offline:
        'Sin correo ni calendario para quienes trabajan en Outlook: Cortex no ve nada de su día.',
      // The one thing this line has to make unmissable: nobody's mailbox is
      // read because an administrator approved something. Each person connects
      // their own, and only their own.
      owner: mine.microsoft
        ? `La conectaste tú${microsoftScopes ? ` · ${microsoftScopes} permisos otorgados` : ''}`
        : microsoftConfigured
          ? 'Cada quien conecta su propio buzón. Nadie ve el correo de otro'
          : 'Falta que el equipo técnico registre la aplicación en Azure',
      connectHref:
        !mine.microsoft && microsoftConfigured
          ? '/api/integrations/microsoft?preset=all'
          : undefined,
    },
    {
      key: 'whatsapp',
      name: 'WhatsApp',
      icon: MessageCircle,
      families: [],
      state: waOn ? 'workspace' : 'disconnected',
      unlocks:
        'Escribirle a Cortex por mensaje directo desde tu teléfono, y guardar en Brain Knowledge los grupos que elijas, con quién dijo qué y cuándo.',
      offline:
        'Nadie puede conversar con Cortex por WhatsApp y no entra nada de los grupos a Brain Knowledge.',
      owner: waOn
        ? myWaLink
          ? 'Número de la empresa en línea · el tuyo ya está vinculado'
          : 'Número de la empresa en línea · falta vincular el tuyo para que te conteste'
        : waStatus === 'pairing'
          ? 'Hay un código de emparejamiento esperando a que alguien lo escanee'
          : 'Falta emparejar el número dedicado de la empresa',
      connectHref: '/integrations/whatsapp',
      ctaLabel: waOn ? 'Configurar' : 'Emparejar',
      footNote: waOn
        ? `${waGroups} ${waGroups === 1 ? 'grupo' : 'grupos'} · ${waLinks} ${waLinks === 1 ? 'número' : 'números'}`
        : 'sin emparejar',
    },
    {
      key: 'hubspot',
      name: 'HubSpot',
      icon: Building2,
      families: ['hubspot'],
      state: hubspotWorkspace ? 'workspace' : mine.hubspot ? 'user' : 'disconnected',
      unlocks:
        'Negocios, empresas, contactos, salud del pipeline y actividad reciente: el sistema de registro comercial.',
      offline:
        'Sin respuestas de negocios, pipeline ni contactos: todo el lado comercial queda a oscuras.',
      owner: hubspotWorkspace
        ? 'La configuró el equipo técnico · una sola app privada para toda la organización'
        : personalOwner('hubspot'),
      connectHref: !hubspotWorkspace && !mine.hubspot ? '/api/integrations/hubspot' : undefined,
    },
    {
      key: 'matcher',
      name: 'Presentaciones de candidatos',
      icon: Sparkles,
      families: ['presentations'],
      state: matcherOn ? 'workspace' : 'disconnected',
      unlocks:
        'Ver quién está en una vacante, armar la presentación de un candidato para el cliente y volver a bajar las que ya se hicieron, en PDF con la carta de la empresa.',
      offline: 'No se pueden armar ni consultar presentaciones de candidatos para el cliente.',
      owner: opsOwner(matcherOn, 'la URL del servicio de presentaciones no está configurada'),
    },
    {
      key: 'payroll',
      name: 'Nómina',
      icon: Wallet,
      families: ['payroll'],
      state: payrollOn ? 'workspace' : 'disconnected',
      unlocks:
        'Quién está asignado a qué cliente, reportes de nómina y gastos, y proyecciones de costo hacia adelante.',
      offline: 'Sin respuestas de costo del equipo, asignaciones ni gastos.',
      owner: opsOwner(payrollOn, 'no hay URL de la API de nómina en este entorno'),
    },
    {
      key: 'brain',
      name: 'Cortex Brain',
      icon: Brain,
      families: ['kb', 'pipeline', 'schedule', 'inbox', 'security'],
      state: brainOn ? 'workspace' : 'disconnected',
      unlocks:
        'Búsqueda y memoria en Brain Knowledge, pipelines, rutinas y el resumen del correo: el razonamiento propio de Cortex.',
      offline: 'Se para el corazón: sin Brain Knowledge, sin pipelines y sin rutinas.',
      owner:
        brainOn && !semanticSearchOn
          ? 'La configuró el equipo técnico · sin llave de embeddings, así que Brain Knowledge solo busca por palabras'
          : opsOwner(brainOn, 'falta la API key del modelo'),
    },
    {
      key: 'web',
      name: 'Investigación web',
      icon: Globe,
      families: ['web', 'growth'],
      state: webOn ? 'workspace' : 'disconnected',
      unlocks:
        'Búsqueda en vivo y lectura de páginas para investigar prospectos y señales de crecimiento.',
      offline: 'Cortex se queda con lo que ya sabe: no puede investigar empresas al día.',
      owner: opsOwner(webOn, 'no hay API key de búsqueda en este entorno'),
    },
    {
      key: 'slack',
      name: 'Slack',
      icon: MessageSquare,
      families: ['slack'],
      state: slackOn ? 'workspace' : 'disconnected',
      unlocks:
        'Publicar avances, reportes y resultados de rutinas directo en los canales del equipo.',
      offline: 'Los resultados se quedan en la app y en el correo: nada llega a Slack.',
      owner: opsOwner(slackOn, 'todavía no está aprovisionado el token del bot'),
    },
    {
      key: 'github',
      name: 'GitHub',
      icon: GitBranch,
      families: ['github'],
      state: mine.github ? 'user' : 'disconnected',
      unlocks: 'Repositorios, issues, pull requests y métricas de actividad de ingeniería.',
      offline:
        'Sin visibilidad de repos, issues ni PRs: las preguntas de ingeniería quedan sin respuesta.',
      owner: mine.github
        ? personalOwner('github')
        : `${personalOwner('github')} · la habilita el equipo técnico`,
    },
    {
      key: 'linear',
      name: 'Linear',
      icon: ListTodo,
      families: ['linear'],
      state: mine.linear ? 'user' : 'disconnected',
      unlocks: 'Proyectos, ciclos, issues y carga del equipo para ver el roadmap.',
      offline:
        'Sin respuestas de roadmap ni de carga: Cortex no ve qué está construyendo el equipo.',
      owner: mine.linear
        ? personalOwner('linear')
        : `${personalOwner('linear')} · la habilita el equipo técnico`,
    },
  ];

  const { data: mcpRows } = await db
    .from('user_mcp_servers')
    .select(
      'id, name, url, auth_type, auth_value_encrypted, enabled, trusted, tool_count, last_checked_at, last_error, user_mcp_tools(tool_name, tool_description)',
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: true });

  const mcpServers: McpServer[] = (mcpRows ?? []).map((r) => {
    const row = r as Record<string, unknown> & {
      auth_value_encrypted: string | null;
      user_mcp_tools?: Array<{
        tool_name: string;
        tool_description: string | null;
      }>;
    };
    return {
      id: row.id as string,
      name: row.name as string,
      url: row.url as string,
      auth_type: row.auth_type as McpServer['auth_type'],
      enabled: row.enabled as boolean,
      trusted: row.trusted as boolean,
      tool_count: (row.tool_count as number) ?? 0,
      last_checked_at: (row.last_checked_at as string | null) ?? null,
      last_error: (row.last_error as string | null) ?? null,
      // Never the secret itself — only whether one is stored.
      authConfigured: !!row.auth_value_encrypted,
      tools: row.user_mcp_tools ?? [],
    };
  });

  const atServerCapacity = mcpServers.length >= MAX_MCP_SERVERS;
  const totalMcpTools = mcpServers.reduce((sum, s) => sum + s.tool_count, 0);
  const atToolCapacity = totalMcpTools >= MAX_MCP_TOOLS;

  const connected = providers.filter((p) => p.state !== 'disconnected');
  const missing = providers.filter((p) => p.state === 'disconnected');
  const totalToolCount = Object.values(toolsByFamily).reduce((a, b) => a + b, 0);

  /** The register header: what the organisation holds, counted in mono. */
  const stats = [
    {
      label: 'Sistemas conectados',
      value: `${connected.length}/${providers.length}`,
      sub: 'Cortex puede actuar en estos',
      icon: CircleCheck,
      tone: 'text-emerald',
    },
    {
      label: 'Sin conectar',
      value: String(missing.length),
      sub: missing.length > 0 ? missing.map((p) => p.name).join(', ') : 'no falta ninguno',
      icon: TriangleAlert,
      tone: missing.length > 0 ? 'text-amber' : 'text-emerald',
    },
    {
      label: 'Herramientas propias',
      value: String(totalToolCount),
      sub: 'disponibles para Cortex',
      icon: Wrench,
      tone: 'text-ink',
    },
    {
      label: 'Herramientas que conectaste',
      value: String(totalMcpTools),
      sub: `${mcpServers.length} ${mcpServers.length === 1 ? 'servidor MCP externo' : 'servidores MCP externos'}`,
      icon: Boxes,
      tone: 'text-ink',
    },
  ];

  return (
    <>
      <PageHeader
        title="Integraciones"
        subtitle="Los sistemas que esta organización tiene conectados: dónde puede leer y actuar Cortex en tu nombre."
        icon={<Plug className="h-5 w-5" />}
      />

      <DirectionPair active="outbound" />

      {sp.connected && (
        <div className="mb-4 rounded-card border border-emerald/30 bg-emerald-soft px-3 py-2 text-[12.5px] text-emerald">
          Se conectó {sp.connected}.
        </div>
      )}
      {sp.error && (
        <div className="mb-4 rounded-card border border-rose/30 bg-rose-soft px-3 py-2 text-[12.5px] text-rose">
          No se pudo conectar: {sp.error}. Inténtalo otra vez desde la tarjeta.
        </div>
      )}

      {/* Hairlines come from the gap showing the border colour through, so the
          rules stay correct at every breakpoint the grid reflows to. */}
      <Panel className="mb-5 overflow-hidden">
        <div className="grid grid-cols-2 gap-px bg-border lg:grid-cols-4">
          {stats.map((s) => (
            <div key={s.label} className="bg-surface p-4">
              <div className="flex items-center gap-1.5">
                <s.icon className={clsx('h-3.5 w-3.5', s.tone)} />
                <span className="field-label">{s.label}</span>
              </div>
              <div className={clsx('stat-num mt-1.5 text-[26px] leading-none', s.tone)}>
                {s.value}
              </div>
              <div className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-ink-faint">
                {s.sub}
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {/* THE PANEL THAT WOULD HAVE CAUGHT IT ON DAY ONE.
          A single document once burned an entire embedding account, and nobody
          found out until Brain Knowledge stopped indexing. Nothing here is a
          billing system — it is the four facts that would have made somebody
          ask a question: which model is running, whether that model has any
          free allowance at all, how much has been embedded this month, and
          which document accounted for most of it. */}
      <Panel className="mb-5 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
              <Gauge className="h-5 w-5" />
            </span>
            <div>
              <div className="text-[13.5px] font-bold text-ink">Embeddings de Brain Knowledge</div>
              <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">
                {embeddingOk ? (
                  <>
                    <span className="font-semibold text-ink">{embedding.provider.label}</span> ·{' '}
                    <span className="font-mono text-[11.5px]">{embedding.model}</span> · 1024
                    dimensiones
                  </>
                ) : (
                  'La configuración de embeddings no es válida, así que no se está indexando nada.'
                )}
              </p>
            </div>
          </div>
          <span
            className={clsx(
              'rounded-pill border px-2.5 py-0.5 text-[10.5px] font-semibold',
              semanticSearchOn
                ? 'border-emerald/40 bg-emerald-soft text-emerald'
                : 'border-amber/40 bg-amber-soft text-amber',
            )}
          >
            {semanticSearchOn ? 'Indexando por significado' : 'Solo por palabras'}
          </span>
        </div>

        {!embeddingOk && (
          <p className="mt-3 flex items-start gap-1.5 rounded-card border border-rose/30 bg-rose-soft px-2.5 py-1.5 text-[11px] leading-snug text-rose">
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
            <span>{embedding.error}</span>
          </p>
        )}

        {/* The lesson of the incident, stated as a rule the screen enforces: a
            model without a free allowance is a decision, not a default, and it
            should be visible before the credits run out rather than after. */}
        {embeddingOk && embedding.facts && embedding.facts.freeTierTokens === 0 && (
          <p className="mt-3 flex items-start gap-1.5 rounded-card border border-amber/30 bg-amber-soft px-2.5 py-1.5 text-[11px] leading-snug text-amber">
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
            <span>
              <span className="font-semibold">Este modelo no tiene tokens gratis: </span>
              se paga desde el primero. {embedding.facts.note} Si no fue una decisión deliberada,
              vuelve a <span className="font-mono">voyage-4-lite</span>, que trae 200 millones
              gratis y las mismas 1024 dimensiones.
            </span>
          </p>
        )}
        {embeddingOk && !embedding.facts && (
          <p className="mt-3 flex items-start gap-1.5 rounded-card border border-amber/30 bg-amber-soft px-2.5 py-1.5 text-[11px] leading-snug text-amber">
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
            <span>
              No conocemos <span className="font-mono">{embedding.model}</span>, así que no podemos
              decir qué cuesta ni si tiene nivel gratuito. Verifícalo con {embedding.provider.label}{' '}
              antes de indexar un corpus grande.
            </span>
          </p>
        )}
        {embeddingOk && !embedding.keyConfigured && (
          <p className="mt-3 flex items-start gap-1.5 rounded-card border border-amber/30 bg-amber-soft px-2.5 py-1.5 text-[11px] leading-snug text-amber">
            <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
            <span>
              Falta <span className="font-mono">{embedding.apiKeyEnv}</span>. Nada se pierde: los
              documentos se guardan, se buscan por palabras y quedan en cola sin vector. En cuanto
              exista la llave, el trabajo de reindexado los completa solo.
            </span>
          </p>
        )}

        <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-card border border-border bg-border sm:grid-cols-4">
          <div className="bg-surface p-3">
            <span className="field-label">Tokens embebidos · 30 días</span>
            <div className="stat-num mt-1 text-[22px] leading-none text-ink">
              {spend.tokens.toLocaleString('es-CO')}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-ink-faint">
              {spend.anyEstimated ? 'incluye estimados nuestros' : 'según el proveedor'}
            </div>
          </div>
          <div className="bg-surface p-3">
            <span className="field-label">Costo aproximado</span>
            <div className="stat-num mt-1 text-[22px] leading-none text-ink">
              {embeddingOk && embedding.facts?.pricePerMillionTokensUsd != null
                ? `US$${((spend.tokens / 1_000_000) * embedding.facts.pricePerMillionTokensUsd).toFixed(4)}`
                : '—'}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-ink-faint">
              {embeddingOk && embedding.facts?.pricePerMillionTokensUsd != null
                ? `US$${embedding.facts.pricePerMillionTokensUsd}/millón · precio verificado el ${PRICES_CHECKED_ON}`
                : 'el proveedor no publica precio por token'}
            </div>
          </div>
          <div className="bg-surface p-3">
            <span className="field-label">Fragmentos</span>
            <div className="stat-num mt-1 text-[22px] leading-none text-ink">
              {spend.texts.toLocaleString('es-CO')}
            </div>
            <div className="mt-1 text-[11px] leading-snug text-ink-faint">
              en {spend.requests.toLocaleString('es-CO')}{' '}
              {spend.requests === 1 ? 'llamada' : 'llamadas'}
            </div>
          </div>
          <div className="bg-surface p-3">
            <span className="field-label">Modelos usados</span>
            <div className="stat-num mt-1 text-[22px] leading-none text-ink">
              {spend.models.length || '—'}
            </div>
            <div className="mt-1 line-clamp-2 text-[11px] leading-snug text-ink-faint">
              {spend.models.length > 1
                ? 'hubo un cambio de modelo; se está reindexando'
                : (spend.models[0] ?? 'nada embebido en el periodo')}
            </div>
          </div>
        </div>

        {spend.topDocuments.length > 0 && (
          <div className="mt-3">
            <span className="field-label">Lo que más se embebió</span>
            <ul className="mt-1.5 space-y-1">
              {spend.topDocuments.map((d) => (
                <li
                  key={d.documentId ?? 'sin-documento'}
                  className="flex items-baseline justify-between gap-3 text-[11.5px]"
                >
                  <span className="truncate text-ink-muted">
                    {d.title ?? (d.documentId ? 'Documento eliminado' : 'Sin documento')}
                  </span>
                  <span className="shrink-0 font-mono text-[11px] text-ink-faint">
                    {d.tokens.toLocaleString('es-CO')} tokens · {d.texts} fragmentos
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Panel>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {providers.map((p) => {
          const tag = STATE_TAG[p.state];
          const tools = famCount(p.families);
          const isOn = p.state !== 'disconnected';
          return (
            <Panel key={p.key} className="flex h-full flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-2">
                <span
                  className={clsx(
                    'grid h-10 w-10 shrink-0 place-items-center rounded-card',
                    isOn ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-faint',
                  )}
                >
                  <p.icon className="h-5 w-5" />
                </span>
                <span
                  className={clsx(
                    'rounded-pill border px-2.5 py-0.5 text-[10.5px] font-semibold',
                    tag.cls,
                  )}
                >
                  {tag.label}
                </span>
              </div>

              <div>
                <div className="text-[13.5px] font-bold text-ink">{p.name}</div>
                <p className="mt-0.5 text-[12px] leading-snug text-ink-muted">{p.unlocks}</p>
              </div>

              <p className="flex items-start gap-1.5 text-[11px] leading-snug text-ink-faint">
                <Users className="mt-px h-3 w-3 shrink-0" />
                {p.owner}
              </p>

              {!isOn && (
                <p className="flex items-start gap-1.5 rounded-card border border-amber/30 bg-amber-soft px-2.5 py-1.5 text-[11px] leading-snug text-amber">
                  <TriangleAlert className="mt-px h-3 w-3 shrink-0" />
                  <span>
                    <span className="font-semibold">Mientras esté apagada: </span>
                    {p.offline}
                  </span>
                </p>
              )}

              <div className="mt-auto flex items-center justify-between gap-2 border-t border-border pt-2.5">
                <span className="inline-flex items-center gap-1 text-[11px] text-ink-faint">
                  {p.footNote ? (
                    <>
                      <MessageCircle className="h-3 w-3" />
                      <span className="tabular">{p.footNote}</span>
                    </>
                  ) : (
                    <>
                      <Wrench className="h-3 w-3" />
                      {tools > 0 ? (
                        <>
                          <span className="tabular">{tools}</span>{' '}
                          {tools === 1 ? 'herramienta' : 'herramientas'}
                        </>
                      ) : (
                        'todavía sin herramientas'
                      )}
                    </>
                  )}
                </span>
                {p.connectHref && (
                  <Link
                    href={p.connectHref}
                    className="rounded-pill bg-primary px-3 py-1.5 text-[12px] font-semibold text-white shadow-pop transition-all duration-150 hover:-translate-y-px hover:bg-primary-strong motion-reduce:transform-none motion-reduce:transition-none"
                  >
                    {p.ctaLabel ?? 'Conectar'}
                  </Link>
                )}
              </div>
            </Panel>
          );
        })}
      </div>

      {/* Advanced: external MCP servers are just another inbound source of
          tools — same direction as an integration, so they live here. */}
      <Panel className="mt-5 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-surface-2 text-ink-muted">
            <Server className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="field-label">Advanced</div>
            <h2 className="mt-0.5 text-[15px] font-bold tracking-tight text-ink">
              Herramientas extra que le conectas a Cortex
            </h2>
            <p className="mt-1 max-w-2xl text-[12.5px] leading-relaxed text-ink-muted">
              Apunta Cortex a tu propio servidor de Model Context Protocol —Notion, el servidor de
              un proveedor, algo que tú mismo alojes— y sus herramientas se suman a la lista de
              arriba, solo para tu cuenta. Casi nadie necesita esto.
            </p>
            <p className="mt-1 text-[11.5px] text-ink-faint">
              Hasta <span className="tabular">{MAX_MCP_SERVERS}</span> servidores y{' '}
              <span className="tabular">{MAX_MCP_TOOLS}</span> herramientas en total. ¿Lo que buscas
              es usar Cortex <em>desde</em> Claude?{' '}
              <Link href="/mcp-tokens" className="font-semibold text-primary hover:underline">
                Esa es la otra página
              </Link>
              .
            </p>
          </div>
        </div>

        <div className="mt-4 border-t border-border pt-4">
          <McpServerList servers={mcpServers} />

          {atServerCapacity && (
            <p className="mt-4 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
              Llegaste al tope de <span className="tabular">{MAX_MCP_SERVERS}</span> servidores.
              Elimina uno de arriba para agregar otro.
            </p>
          )}
          {atToolCapacity && (
            <p className="mt-2 rounded-card border border-amber/30 bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
              Llegaste al tope de <span className="tabular">{MAX_MCP_TOOLS}</span> herramientas.
              Cortex deja de sincronizar nuevas hasta que elimines un servidor de arriba.
            </p>
          )}

          {!atServerCapacity && (
            <div className="mt-4 border-t border-border pt-4">
              <h3 className="text-[12.5px] font-semibold text-ink">Agregar un servidor</h3>
              <AddMcpServerForm disabled={atServerCapacity} />
            </div>
          )}
        </div>
      </Panel>
    </>
  );
}
