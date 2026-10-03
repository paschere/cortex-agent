import { DirectionPair } from '@/components/connect/DirectionPair';
import { ConnectCatalog } from '@/components/sources/ConnectCatalog';
import { ConnectedSources } from '@/components/sources/ConnectedSources';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { SourceDiagnostics } from '@/components/ui/source-diagnostics';
import { canManageAccounting } from '@/lib/accounting/card';
import { quickbooksErrorMessage } from '@/lib/accounting/quickbooks-oauth';
import { readSetupDiagnostics } from '@/lib/management/diagnostics';
import { requireSession } from '@/lib/session';
import { buildCatalog } from '@/lib/sources/catalog';
import { buildConnectedSources, unreadParts } from '@/lib/sources/overview';
import { readSourcesSnapshot } from '@/lib/sources/read';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { workspaceHref } from '@/lib/workspace-context';
import {
  PRICES_CHECKED_ON,
  embeddingConfig,
  listTools,
  readEmbeddingSpend,
} from '@cortex/agent-tools';
import { clsx } from 'clsx';
import {
  Brain,
  ChevronDown,
  Gauge,
  Globe,
  MessageSquare,
  Plug,
  Server,
  Sparkles,
  TriangleAlert,
  Wallet,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { AccountingSection } from './_components/AccountingSection';
import { AddMcpServerForm } from './_components/AddMcpServerForm';
import { type McpServer, McpServerList } from './_components/McpServerList';
import { syncAccountingProgramNow } from './accounting-actions';
import { syncSourceNow } from './source-actions';

/**
 * DATOS Y CONEXIONES: UNA SOLA IDEA POR PANTALLA.
 *
 * Arriba, «Conectado»: todo lo que la empresa ya trae a Cortex —cuentas de
 * Google o Microsoft, programas contables, carpetas de Drive que llenan
 * tablas, hojas sincronizadas, APIs, extractos del banco, WhatsApp, la
 * bandeja— como tarjetas de estado con la misma forma, y el resumen de salud
 * («6 conectadas · 1 con error»). Abajo, «Conecta algo nuevo»: el catálogo
 * agrupado por lo que la gente quiere traer, cada tarjeta a su flujo. Lo
 * técnico (servidores MCP, servicios que activa el equipo de Cortex, el
 * diagnóstico, la telemetría del cerebro) va plegado en «Avanzado».
 */

const MAX_MCP_SERVERS = 5;
const MAX_MCP_TOOLS = 50;

/** Lo que vuelve en `?connected=` tras un OAuth, dicho como lo diría una persona. */
const CONNECTED_NAME: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft 365',
  hubspot: 'HubSpot',
  github: 'GitHub',
  linear: 'Linear',
  quickbooks: 'QuickBooks',
  siigo: 'Siigo',
  alegra: 'Alegra',
};

export default async function IntegrationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await requireSession();
  const isAdmin = user.role === 'org_admin';
  const canManage = canManageAccounting(user.organization.role);
  const sp = await searchParams;
  const db = getOrgScopedClient(user.organization.id);
  const workspaceId = user.organization.id;
  const href = (path: string) => workspaceHref(workspaceId, path);

  const hubspotWorkspace = !!process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  const microsoftConfigured =
    !!process.env.MICROSOFT_CLIENT_ID && !!process.env.MICROSOFT_REDIRECT_URI;

  const [snapshot, diagnostics, mcpRead, spend] = await Promise.all([
    readSourcesSnapshot(db, { userId: user.id, canManage, hubspotWorkspace }),
    readSetupDiagnostics(db, user.id),
    db
      .from('user_mcp_servers')
      .select(
        'id, name, url, auth_type, auth_value_encrypted, enabled, trusted, tool_count, last_checked_at, last_error, user_mcp_tools(tool_name, tool_description)',
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: true }),
    readEmbeddingSpend(db, { days: 30 }),
  ]);

  const connected = buildConnectedSources(snapshot);
  const unread = unreadParts(snapshot);
  const mine = new Set(
    (snapshot.integrations ?? []).filter((r) => r.user_id === user.id).map((r) => r.provider),
  );

  const mcpServers: McpServer[] = (mcpRead.error ? [] : (mcpRead.data ?? [])).map((r) => {
    const row = r as Record<string, unknown> & {
      auth_value_encrypted: string | null;
      user_mcp_tools?: Array<{ tool_name: string; tool_description: string | null }>;
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
      // Nunca el secreto: sólo si hay uno guardado.
      authConfigured: !!row.auth_value_encrypted,
      tools: row.user_mcp_tools ?? [],
    };
  });
  const atServerCapacity = mcpServers.length >= MAX_MCP_SERVERS;
  const totalMcpTools = mcpServers.reduce((sum, s) => sum + s.tool_count, 0);
  const atToolCapacity = totalMcpTools >= MAX_MCP_TOOLS;
  const mcpErrors = mcpServers.filter((s) => s.enabled && s.last_error).length;

  const wa = snapshot.whatsapp;
  const catalog = buildCatalog({
    googleConnected: mine.has('google'),
    microsoftConnected: mine.has('microsoft'),
    microsoftConfigured,
    hubspot: hubspotWorkspace ? 'workspace' : mine.has('hubspot') ? 'mine' : 'none',
    github: mine.has('github'),
    linear: mine.has('linear'),
    whatsapp: wa?.status === 'connected' ? 'on' : wa?.status === 'pairing' ? 'pairing' : 'off',
    bankAccounts: snapshot.bank?.length ?? 0,
    mcpServers: mcpServers.length,
  });

  // Servicios que no conecta nadie de la empresa: los activa el equipo de Cortex.
  const toolsByFamily: Record<string, number> = {};
  for (const t of listTools()) {
    if (t.id.startsWith('test.')) continue;
    const fam = t.id.split('.')[0] ?? '';
    toolsByFamily[fam] = (toolsByFamily[fam] ?? 0) + 1;
  }
  const famCount = (families: string[]) =>
    families.reduce((sum, f) => sum + (toolsByFamily[f] ?? 0), 0);
  const embedding = embeddingConfig();
  const embeddingOk = !('error' in embedding);
  const semanticSearchOn = embeddingOk && embedding.keyConfigured;
  const brainOn = !!process.env.ANTHROPIC_API_KEY;
  const services = [
    {
      key: 'brain',
      name: 'El cerebro de Cortex',
      icon: Brain,
      on: brainOn,
      what:
        brainOn && !semanticSearchOn
          ? 'Activo · por ahora busca por palabras, no por significado'
          : 'Buscar y recordar lo que guardas, los flujos y las rutinas',
      off: 'falta la API key del modelo',
      tools: famCount(['kb', 'pipeline', 'schedule', 'inbox', 'security']),
    },
    {
      key: 'web',
      name: 'Investigación web',
      icon: Globe,
      on: !!process.env.TAVILY_API_KEY,
      what: 'Búsqueda en vivo y lectura de páginas para investigar prospectos',
      off: 'no hay API key de búsqueda en este entorno',
      tools: famCount(['web', 'growth']),
    },
    {
      key: 'slack',
      name: 'Slack',
      icon: MessageSquare,
      on: !!process.env.SLACK_BOT_TOKEN,
      what: 'Publicar avances e informes en los canales del equipo',
      off: 'todavía no está aprovisionado el token del bot',
      tools: famCount(['slack']),
    },
    {
      key: 'matcher',
      name: 'Presentaciones de candidatos',
      icon: Sparkles,
      on: !!process.env.MATCHER_URL,
      what: 'Armar la presentación de un candidato para el cliente, en PDF',
      off: 'la URL del servicio de presentaciones no está configurada',
      tools: famCount(['presentations']),
    },
    {
      key: 'payroll',
      name: 'Nómina',
      icon: Wallet,
      on: !!process.env.PAYROLL_API_URL,
      what: 'Asignaciones, reportes de nómina y gastos, y proyecciones de costo',
      off: 'no hay URL de la API de nómina en este entorno',
      tools: famCount(['payroll']),
    },
  ];
  const servicesOn = services.filter((s) => s.on).length;

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Datos y conexiones"
        subtitle={`De dónde saca Cortex lo que sabe de ${user.organization.name}. Lo que no esté conectado, no lo ve.`}
        icon={<Plug className="h-5 w-5" />}
        actions={
          <>
            <Link
              href={`/chat?prompt=${encodeURIComponent('Ayúdame a decidir qué conectar primero para que me sirvas en mi empresa. Pregúntame dónde tengo hoy la información (correo, Excel, programa contable, WhatsApp).')}`}
              className="inline-flex min-h-10 items-center rounded-pill bg-primary px-5 py-2 text-sm font-bold text-white transition-colors hover:bg-primary-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              ¿Qué conecto primero?
            </Link>
            <Link
              href={href('/activations')}
              className="inline-flex min-h-10 items-center rounded-pill border border-border-strong bg-surface px-5 py-2 text-sm font-bold text-ink transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Reglas sobre tus datos
            </Link>
          </>
        }
      />

      {(sp.connected || sp.error || !brainOn) && (
        <div className="-mt-4 flex flex-col gap-2">
          {sp.connected && (
            <output className="block rounded-card bg-emerald-soft px-4 py-3 text-sm font-semibold text-emerald">
              Listo: quedó conectado {CONNECTED_NAME[sp.connected] ?? 'el sistema'}.
            </output>
          )}
          {sp.error && (
            <p role="alert" className="rounded-card bg-rose-soft px-4 py-3 text-sm text-ink">
              {quickbooksErrorMessage(sp.error) ??
                'No se pudo terminar la conexión. Inténtalo otra vez desde la tarjeta; si se repite, cuéntaselo a Cortex en el chat.'}
            </p>
          )}
          {!brainOn && (
            <p role="alert" className="rounded-card bg-rose-soft px-4 py-3 text-sm text-ink">
              <span className="font-bold">El cerebro de Cortex está apagado</span>: sin él no hay
              respuestas, flujos ni rutinas. Lo activa el equipo de Cortex.
            </p>
          )}
        </div>
      )}

      <ConnectedSources
        sources={connected}
        unread={unread}
        workspaceId={workspaceId}
        actions={{ syncSource: syncSourceNow, syncAccounting: syncAccountingProgramNow }}
      />

      <ConnectCatalog
        groups={catalog}
        workspaceId={workspaceId}
        googleConnected={mine.has('google')}
        slots={{
          accounting: (
            <AccountingSection organizationId={workspaceId} role={user.organization.role} />
          ),
        }}
      />

      <section aria-labelledby="avanzado-title" id="avanzado" className="flex flex-col gap-3">
        <div>
          <h2 id="avanzado-title" className="text-lg font-extrabold tracking-tight text-ink">
            Avanzado
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            Para quien administra o para equipos técnicos. Nada de esto hace falta para empezar.
          </p>
        </div>

        <Fold
          title="Diagnóstico de lectura"
          hint={`${diagnostics.filter((d) => d.state === 'blocked').length} por atender · ${diagnostics.length} comprobaciones`}
        >
          <SourceDiagnostics
            checks={diagnostics}
            workspaceId={workspaceId}
            workspaceName={user.organization.name}
          />
        </Fold>

        <Fold
          title="Servicios que activa el equipo de Cortex"
          hint={`${servicesOn} de ${services.length} activos`}
        >
          <Panel className="overflow-hidden">
            <ul className="divide-y divide-border">
              {services.map((s) => (
                <li key={s.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span
                    className={clsx(
                      'grid h-8 w-8 shrink-0 place-items-center rounded-sm',
                      s.on ? 'bg-primary-soft text-primary' : 'bg-surface-2 text-ink-faint',
                    )}
                  >
                    <s.icon className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-bold text-ink">{s.name}</span>
                    <span className="block text-xs text-ink-muted">
                      {s.on
                        ? s.what
                        : isAdmin
                          ? `Pídesela al equipo de Cortex · detalle: ${s.off}`
                          : 'Pídesela a quien administra la empresa'}
                    </span>
                  </span>
                  <span className="tabular text-micro text-ink-faint">
                    {s.tools} {s.tools === 1 ? 'herramienta' : 'herramientas'}
                  </span>
                  <span
                    className={clsx(
                      'rounded-pill px-2.5 py-0.5 text-micro font-bold',
                      s.on ? 'bg-emerald-soft text-emerald' : 'bg-surface-2 text-ink-muted',
                    )}
                  >
                    {s.on ? 'Activo' : 'Apagado'}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
        </Fold>

        {/* Los servidores MCP son otra entrada de herramientas: misma dirección que
            una integración, así que viven aquí, plegados. */}
        <Fold
          id="mcp"
          title="Servidores MCP"
          hint={
            mcpServers.length
              ? `${mcpServers.length} conectados · ${totalMcpTools} herramientas${mcpErrors ? ` · ${mcpErrors} con error` : ''}`
              : 'Ninguno (es opcional)'
          }
          open={mcpServers.length > 0}
          alert={mcpErrors > 0}
        >
          <Panel className="p-5">
            <div className="flex flex-wrap items-start gap-3">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-sm bg-surface-2 text-ink-muted">
                <Server className="h-4 w-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="field-label">Avanzado · solo tu cuenta</div>
                <h3 className="mt-0.5 text-base font-bold tracking-tight text-ink">
                  Herramientas extra que le conectas a Cortex
                </h3>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
                  Apunta Cortex a un servidor MCP (Model Context Protocol) —Notion, el servidor de
                  un proveedor, algo que tú mismo alojes— y sus herramientas se suman a las tuyas,
                  solo para tu cuenta.
                </p>
                <p className="mt-1 text-micro text-ink-faint">
                  Hasta <span className="tabular">{MAX_MCP_SERVERS}</span> servidores y{' '}
                  <span className="tabular">{MAX_MCP_TOOLS}</span> herramientas en total. ¿Lo que
                  buscas es preguntarle a Cortex <em>desde</em> Claude o ChatGPT?{' '}
                  <Link href="/mcp-tokens" className="font-semibold text-primary hover:underline">
                    Esa es la otra página
                  </Link>
                  .
                </p>
              </div>
            </div>
            {mcpRead.error && (
              <p className="mt-4 rounded-sm bg-amber-soft px-3 py-2 text-xs text-ink">
                No se pudieron leer tus servidores MCP. Si agregaste alguno, sigue ahí; vuelve a
                cargar en un momento.
              </p>
            )}
            <div className="mt-4 border-t border-border pt-4">
              <McpServerList servers={mcpServers} />
              {atServerCapacity && (
                <p className="mt-4 rounded-sm bg-amber-soft px-3 py-2 text-xs text-ink">
                  Llegaste al tope de <span className="tabular">{MAX_MCP_SERVERS}</span> servidores.
                  Elimina uno de arriba para agregar otro.
                </p>
              )}
              {atToolCapacity && (
                <p className="mt-2 rounded-sm bg-amber-soft px-3 py-2 text-xs text-ink">
                  Llegaste al tope de <span className="tabular">{MAX_MCP_TOOLS}</span> herramientas.
                  Cortex deja de sincronizar nuevas hasta que elimines un servidor.
                </p>
              )}
              {!atServerCapacity && (
                <div className="mt-4 border-t border-border pt-4">
                  <h4 className="text-xs font-semibold text-ink">Agregar un servidor</h4>
                  <AddMcpServerForm disabled={atServerCapacity} />
                </div>
              )}
            </div>
          </Panel>
        </Fold>

        <Fold title="Hacia dónde van los datos" hint="Lo que entra a Cortex y lo que sale">
          <DirectionPair active="outbound" />
        </Fold>

        {/* LA TELEMETRÍA QUE HABRÍA AVISADO EL PRIMER DÍA. Un solo documento se
            gastó una cuenta entera de embeddings y nadie se enteró hasta que el
            cerebro dejó de indexar: qué modelo corre, si tiene tokens gratis,
            cuánto se ha embebido este mes y qué documento se llevó la mayor
            parte. Sólo para quien administra. */}
        {isAdmin && (
          <Fold
            title="Detalles técnicos del cerebro"
            hint={semanticSearchOn ? 'Indexando por significado' : 'Solo por palabras'}
            alert={!embeddingOk}
          >
            <Panel className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-sm bg-primary-soft text-primary">
                    <Gauge className="h-5 w-5" />
                  </span>
                  <div>
                    <div className="text-sm font-bold text-ink">
                      Indexado del cerebro (embeddings)
                    </div>
                    <p className="mt-0.5 text-xs leading-snug text-ink-muted">
                      {embeddingOk ? (
                        <>
                          <span className="font-semibold text-ink">{embedding.provider.label}</span>{' '}
                          · <span className="font-mono text-micro">{embedding.model}</span> · 1024
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
                    'rounded-pill px-2.5 py-0.5 text-micro font-bold',
                    semanticSearchOn ? 'bg-emerald-soft text-emerald' : 'bg-amber-soft text-amber',
                  )}
                >
                  {semanticSearchOn ? 'Indexando por significado' : 'Solo por palabras'}
                </span>
              </div>

              {!embeddingOk && <Warn tone="rose">{embedding.error}</Warn>}
              {embeddingOk && embedding.facts && embedding.facts.freeTierTokens === 0 && (
                <Warn>
                  <span className="font-semibold">Este modelo no tiene tokens gratis: </span>
                  se paga desde el primero. {embedding.facts.note} Si no fue una decisión
                  deliberada, vuelve a <span className="font-mono">voyage-4-lite</span>, que trae
                  200 millones gratis y las mismas 1024 dimensiones.
                </Warn>
              )}
              {embeddingOk && !embedding.facts && (
                <Warn>
                  No conocemos <span className="font-mono">{embedding.model}</span>, así que no
                  podemos decir qué cuesta ni si tiene nivel gratuito. Verifícalo con{' '}
                  {embedding.provider.label} antes de indexar un corpus grande.
                </Warn>
              )}
              {embeddingOk && !embedding.keyConfigured && (
                <Warn>
                  Falta <span className="font-mono">{embedding.apiKeyEnv}</span>. Nada se pierde:
                  los documentos se guardan, se buscan por palabras y quedan en cola sin vector. En
                  cuanto exista la llave, el trabajo de reindexado los completa solo.
                </Warn>
              )}

              <div className="mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-sm border border-border bg-border sm:grid-cols-4">
                <Stat
                  label="Tokens embebidos · 30 días"
                  value={spend.tokens.toLocaleString('es-CO')}
                  sub={spend.anyEstimated ? 'incluye estimados nuestros' : 'según el proveedor'}
                />
                <Stat
                  label="Costo aproximado"
                  value={
                    embeddingOk && embedding.facts?.pricePerMillionTokensUsd != null
                      ? `US$${((spend.tokens / 1_000_000) * embedding.facts.pricePerMillionTokensUsd).toFixed(4)}`
                      : '—'
                  }
                  sub={
                    embeddingOk && embedding.facts?.pricePerMillionTokensUsd != null
                      ? `US$${embedding.facts.pricePerMillionTokensUsd}/millón · precio verificado el ${PRICES_CHECKED_ON}`
                      : 'el proveedor no publica precio por token'
                  }
                />
                <Stat
                  label="Fragmentos"
                  value={spend.texts.toLocaleString('es-CO')}
                  sub={`en ${spend.requests.toLocaleString('es-CO')} ${spend.requests === 1 ? 'llamada' : 'llamadas'}`}
                />
                <Stat
                  label="Modelos usados"
                  value={String(spend.models.length || '—')}
                  sub={
                    spend.models.length > 1
                      ? 'hubo un cambio de modelo; se está reindexando'
                      : (spend.models[0] ?? 'nada embebido en el periodo')
                  }
                />
              </div>

              {spend.topDocuments.length > 0 && (
                <div className="mt-3">
                  <span className="field-label">Lo que más se embebió</span>
                  <ul className="mt-1.5 space-y-1">
                    {spend.topDocuments.map((d) => (
                      <li
                        key={d.documentId ?? 'sin-documento'}
                        className="flex items-baseline justify-between gap-3 text-micro"
                      >
                        <span className="truncate text-ink-muted">
                          {d.title ?? (d.documentId ? 'Documento eliminado' : 'Sin documento')}
                        </span>
                        <span className="shrink-0 font-mono text-micro text-ink-faint">
                          {d.tokens.toLocaleString('es-CO')} tokens · {d.texts} fragmentos
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </Panel>
          </Fold>
        )}
      </section>
    </div>
  );
}

function Fold({
  id,
  title,
  hint,
  open,
  alert,
  children,
}: {
  id?: string;
  title: string;
  hint: string;
  open?: boolean;
  alert?: boolean;
  children: ReactNode;
}) {
  return (
    <details id={id} open={open} className="group scroll-mt-6">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-card border border-border bg-surface px-4 py-3 shadow-card [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="text-sm font-extrabold text-ink">{title}</span>
          <span
            className={clsx(
              'ml-2 text-xs tabular',
              alert ? 'font-semibold text-rose' : 'text-ink-faint',
            )}
          >
            {hint}
          </span>
        </span>
        <ChevronDown
          className="h-4 w-4 shrink-0 text-ink-faint transition-transform group-open:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

function Warn({ children, tone = 'amber' }: { children: ReactNode; tone?: 'amber' | 'rose' }) {
  return (
    <p
      className={clsx(
        'mt-3 flex items-start gap-1.5 rounded-sm px-2.5 py-1.5 text-micro leading-snug text-ink',
        tone === 'rose' ? 'bg-rose-soft' : 'bg-amber-soft',
      )}
    >
      <TriangleAlert
        className={clsx('mt-px h-3 w-3 shrink-0', tone === 'rose' ? 'text-rose' : 'text-amber')}
      />
      <span>{children}</span>
    </p>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-surface p-3">
      <span className="field-label">{label}</span>
      <div className="stat-num mt-1 text-xl leading-none text-ink">{value}</div>
      <div className="mt-1 line-clamp-2 text-micro leading-snug text-ink-faint">{sub}</div>
    </div>
  );
}
