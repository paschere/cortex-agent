import { ConnectCortex, CopyButton } from '@/components/connect/ConnectCortex';
import { DirectionPair } from '@/components/connect/DirectionPair';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { Panel } from '@/components/ui/panel';
import { Field } from '@/components/ui/provenance';
import { getMcpUrl } from '@/lib/mcp-url';
import { requireSession } from '@/lib/session';
import { chipClass, type StatusTone } from '@/lib/status-chip';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { clsx } from 'clsx';
import { Cable, KeyRound, ShieldCheck, TriangleAlert } from 'lucide-react';
import { issueToken, revokeToken } from './actions';

export const dynamic = 'force-dynamic';

const FIELD =
  'w-full rounded-sm border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-primary';

interface AgentRow {
  id: string;
  name: string;
}

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
  created_at: string;
  agent_id: string | null;
  agents: { name: string } | null;
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-CO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

/**
 * A token is a document: in force, lapsed, or stamped void. The register shows
 * which, always — an unlabelled row would leave the reader counting dates.
 */
type TokenState = 'active' | 'expired' | 'revoked';

function stateOf(t: TokenRow): TokenState {
  if (t.revoked_at) return 'revoked';
  if (t.expires_at && new Date(t.expires_at) < new Date()) return 'expired';
  return 'active';
}

const STATE: Record<TokenState, { label: string; tone: StatusTone }> = {
  active: { label: 'Vigente', tone: 'emerald' },
  expired: { label: 'Vencido', tone: 'amber' },
  revoked: { label: 'Revocado', tone: 'rose' },
};

function StateTag({ state }: { state: TokenState }) {
  const s = STATE[state];
  return <span className={clsx('shrink-0', chipClass(s.tone))}>{s.label}</span>;
}

export default async function ConnectClientPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const user = await requireSession();
  const sp = await searchParams;
  const justIssued = sp.just_issued ?? null;
  const mcpUrl = await getMcpUrl();

  const sb = getOrgScopedClient(user.organization.id);

  const [{ data: tokenRows }, { data: agentRows }] = await Promise.all([
    sb
      .from('mcp_tokens')
      .select(
        'id, name, prefix, last_used_at, revoked_at, expires_at, created_at, agent_id, agents(name)',
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false }),
    // Selector: archived agents must not be attachable to a new token.
    sb
      .from('agents')
      .select('id, name')
      .eq('archived', false)
      .order('name'),
  ]);

  const tokens: TokenRow[] = (tokenRows ?? []) as unknown as TokenRow[];
  const agents: AgentRow[] = (agentRows ?? []) as unknown as AgentRow[];
  const liveTokens = tokens.filter((t) => !t.revoked_at).length;

  return (
    <>
      <PageHeader
        title="Conectar Claude"
        subtitle="Usa Cortex desde Claude, Claude Code, ChatGPT o cualquier cliente MCP: las mismas herramientas, tus permisos y todo queda en la auditoría."
        icon={<Cable className="h-5 w-5" />}
      />

      <DirectionPair active="inbound" />

      <div className="space-y-4">
        {/* Primary path: OAuth. No token involved. */}
        <Panel className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-primary-soft text-primary">
              <ShieldCheck className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <h2 className="text-base font-bold tracking-tight text-ink">
                No necesitas token: solo inicia sesión
              </h2>
              <p className="mt-0.5 max-w-2xl text-xs leading-relaxed text-ink-muted">
                Claude, Claude Code y ChatGPT se conectan por OAuth: pegas la URL de abajo, te
                mandan a Google y apruebas una vez. Nada que copiar, nada que guardar, y el acceso
                se acaba junto con tu cuenta de Cortex.
              </p>
            </div>
          </div>

          <ConnectCortex url={mcpUrl} />
        </Panel>

        {/* Fallback path: static bearer tokens. */}
        <Panel className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-card bg-surface-2 text-ink-muted">
              <KeyRound className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="field-label">Avanzado</div>
              <h2 className="mt-0.5 text-base font-bold tracking-tight text-ink">
                Tokens de acceso personal
              </h2>
              <p className="mt-1 max-w-2xl text-xs leading-relaxed text-ink-muted">
                Solo para clientes que no manejan OAuth: un script, un puente que alojas tú, un
                cliente MCP viejo. Un token actúa como tú: quien lo tenga usa tus herramientas y ve
                tus datos, hasta que lo revoques desde aquí.
              </p>
              {liveTokens > 0 && (
                <p className="mt-1 text-micro text-ink-faint">
                  <span className="tabular text-ink-muted">{liveTokens}</span>{' '}
                  {liveTokens === 1 ? 'token vigente' : 'tokens vigentes'} en tu cuenta.
                </p>
              )}
            </div>
          </div>

          {/* One-time plaintext. It is never rendered again after this response. */}
          {justIssued && (
            <div className="mt-4 rounded-card border border-amber/40 bg-amber-soft p-4">
              <p className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-amber">
                <TriangleAlert className="h-4 w-4" />
                Copia este token ahora: no se vuelve a mostrar.
              </p>
              <div className="flex flex-wrap items-center gap-2 rounded-card border border-amber/30 bg-surface px-3 py-2">
                <code className="min-w-0 flex-1 break-all font-mono text-xs text-ink">
                  {justIssued}
                </code>
                <CopyButton text={justIssued} label="Copiar el token" />
              </div>
              <p className="mt-2 text-micro text-amber">
                Si sales de esta página el token desaparece de aquí para siempre: solo se guarda su
                hash. Guárdalo en un lugar seguro.
              </p>
            </div>
          )}

          <div className="mt-4 grid gap-4 border-t border-border pt-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
            {/* Issue */}
            <form action={issueToken} className="space-y-3">
              <div>
                <label htmlFor="token-name" className="field-label mb-1 block">
                  Nombre del token
                </label>
                <input
                  id="token-name"
                  name="name"
                  required
                  maxLength={60}
                  placeholder="Portátil del trabajo"
                  className={FIELD}
                />
              </div>
              <div>
                <label htmlFor="agent-select" className="field-label mb-1 block">
                  Agente
                </label>
                <select id="agent-select" name="agentId" className={FIELD}>
                  <option value="">Cualquier agente</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-micro text-ink-faint">
                  Escoge uno para limitar el token a las herramientas de ese agente.
                </p>
              </div>
              <Button type="submit">Generar el token</Button>
            </form>

            {/* The register: one row per token, every date and id in mono. */}
            <div>
              <div className="field-label">Tus tokens</div>
              {tokens.length === 0 ? (
                <p className="mt-3 max-w-md text-sm leading-relaxed text-ink-muted">
                  No has emitido ningún token. Ponle nombre a la izquierda y genéralo, aunque casi
                  todo el mundo se conecta por OAuth arriba y nunca necesita uno.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-border border-t border-border">
                  {tokens.map((t) => {
                    const state = stateOf(t);
                    return (
                      <li key={t.id} className="py-3.5">
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-ink">{t.name}</span>
                            <StateTag state={state} />
                            {/* Prefix only — the token itself is stored hashed. */}
                            <span className="tabular text-xs text-ink-muted">{t.prefix}…</span>
                          </div>
                          {state !== 'revoked' && (
                            <form action={revokeToken} className="shrink-0">
                              <input type="hidden" name="tokenId" value={t.id} />
                              <Button
                                type="submit"
                                variant="danger"
                                title="Mata este token de inmediato, en todas partes donde se use"
                              >
                                Revocar
                              </Button>
                            </form>
                          )}
                        </div>
                        <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-2.5 sm:grid-cols-4">
                          <Field label="Agente">
                            <span className="text-sm">{t.agents?.name ?? 'Cualquiera'}</span>
                          </Field>
                          <Field label="Último uso">
                            <span className="text-sm">{fmt(t.last_used_at)}</span>
                          </Field>
                          <Field label="Creado">
                            <span className="text-sm">{fmt(t.created_at)}</span>
                          </Field>
                          <Field label={t.revoked_at ? 'Revocado' : 'Vence'}>
                            <span className="text-sm">{fmt(t.revoked_at ?? t.expires_at)}</span>
                          </Field>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>
        </Panel>
      </div>
    </>
  );
}
