import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { requireSession } from '@/lib/session';
import { revalidatePath } from 'next/cache';
import { notFound } from 'next/navigation';
import Link from 'next/link';
import {
  Sparkles,
  Building2,
  DollarSign,
  Mail,
  Calendar,
  Table,
  FolderSearch,
  Globe,
  BookOpen,
  Boxes,
  ShieldCheck,
  Cpu,
  MessageSquare,
  ArrowLeft,
} from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { Panel, PanelHead, Eyebrow } from '@/components/ui/panel';

// ---------------------------------------------------------------------------
// Tool registry — full v2 surface, grouped with icons. `write` tools are
// confirmation-gated; we badge them so admins know they take real actions.
// ---------------------------------------------------------------------------
interface ToolDef {
  id: string;
  write?: boolean;
}
interface ToolGroup {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  tools: ToolDef[];
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    label: 'HubSpot CRM',
    icon: Building2,
    tools: [
      { id: 'hubspot.search_companies' },
      { id: 'hubspot.get_company' },
      { id: 'hubspot.search_deals' },
      { id: 'hubspot.get_deal' },
      { id: 'hubspot.search_contacts' },
      { id: 'hubspot.get_contact' },
      { id: 'hubspot.get_pipeline_summary' },
      { id: 'hubspot.get_contact_timeline' },
      { id: 'hubspot.list_recent_activities' },
      { id: 'hubspot.create_deal', write: true },
      { id: 'hubspot.update_deal', write: true },
      { id: 'hubspot.create_contact', write: true },
      { id: 'hubspot.log_activity', write: true },
    ],
  },
  {
    label: 'Gmail',
    icon: Mail,
    tools: [
      { id: 'gmail.search' },
      { id: 'gmail.read_thread' },
      { id: 'gmail.list_threads' },
      { id: 'gmail.draft' },
      { id: 'gmail.send_draft', write: true },
    ],
  },
  {
    label: 'Calendar',
    icon: Calendar,
    tools: [{ id: 'gcal.list_events' }, { id: 'gcal.create_event', write: true }],
  },
  {
    label: 'Sheets',
    icon: Table,
    tools: [{ id: 'gsheets.read_range' }, { id: 'gsheets.append_row', write: true }],
  },
  {
    label: 'Drive',
    icon: FolderSearch,
    tools: [{ id: 'gdrive.search_files' }, { id: 'gdrive.read_doc' }],
  },
  {
    label: 'Web Research',
    icon: Globe,
    tools: [{ id: 'web.search' }, { id: 'web.scrape' }],
  },
  {
    label: 'Rate Calculator',
    icon: DollarSign,
    tools: [{ id: 'rate.estimate' }, { id: 'rate.estimate_from_document' }],
  },
  {
    label: 'Knowledge Base',
    icon: BookOpen,
    tools: [{ id: 'kb.search' }, { id: 'kb.list_collections' }],
  },
  {
    label: 'Composite',
    icon: Boxes,
    tools: [{ id: 'sales.draft_proposal' }],
  },
];

const TOTAL_TOOLS = TOOL_GROUPS.reduce((n, g) => n + g.tools.length, 0);

function shortName(id: string): string {
  const part = id.split('.')[1] ?? id;
  return part.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Server action — org_admin only
// ---------------------------------------------------------------------------
async function updateAgent(slug: string, formData: FormData) {
  'use server';
  const user = await requireSession();
  if (user.role !== 'org_admin') throw new Error('forbidden');

  const defaultModel = formData.get('default_model') as string;
  const systemPrompt = formData.get('system_prompt') as string;
  const allowedToolIds = formData.getAll('allowed_tool_ids') as string[];

  const sb = getSupabaseServiceClient();
  await sb
    .from('agents')
    .update({ default_model: defaultModel, system_prompt: systemPrompt, allowed_tool_ids: allowedToolIds })
    .eq('slug', slug);

  revalidatePath(`/agents/${slug}`);
}

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  default_model: string;
  system_prompt: string;
  allowed_tool_ids: string[];
  teams: { name: string }[] | null;
}

export default async function AgentDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const [user, { slug }] = await Promise.all([requireSession(), params]);

  const sb = getSupabaseServiceClient();
  const { data } = await sb
    .from('agents')
    .select('id, slug, name, default_model, system_prompt, allowed_tool_ids, teams(name)')
    .eq('slug', slug)
    .single();

  if (!data) notFound();
  const agent = data as unknown as AgentRow;
  const enabled = new Set(agent.allowed_tool_ids);
  const isAdmin = user.role === 'org_admin';
  const boundAction = updateAgent.bind(null, agent.slug);
  const promptWords = agent.system_prompt.trim().split(/\s+/).length;

  const Wrapper = isAdmin ? 'form' : 'div';
  const wrapperProps = isAdmin ? { action: boundAction } : {};

  return (
    <>
      <Link
        href="/agents"
        className="mb-4 inline-flex items-center gap-1.5 text-[13px] font-medium text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="h-4 w-4" /> All agents
      </Link>

      <PageHeader
        title={agent.name}
        subtitle={`${agent.teams?.[0]?.name ?? 'No team'} · ${agent.allowed_tool_ids.length} of ${TOTAL_TOOLS} tools enabled`}
        icon={<Sparkles className="h-5 w-5" />}
        actions={
          <Link
            href="/chat"
            className="inline-flex items-center gap-1.5 rounded-pill bg-primary px-4 py-2 text-[13px] font-semibold text-white shadow-pop hover:bg-primary-strong"
          >
            <MessageSquare className="h-4 w-4" /> Open chat
          </Link>
        }
      />

      {/* Identity strip */}
      <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Panel className="flex items-center gap-3 p-4">
          <span className="grid h-10 w-10 place-items-center rounded-[12px] bg-primary-soft text-primary">
            <Cpu className="h-5 w-5" />
          </span>
          <div>
            <Eyebrow>Model</Eyebrow>
            <div className="mt-0.5 font-mono text-[13px] font-semibold text-ink">{agent.default_model}</div>
          </div>
        </Panel>
        <Panel className="flex items-center gap-3 p-4">
          <span className="grid h-10 w-10 place-items-center rounded-[12px] bg-sky-soft text-sky">
            <Boxes className="h-5 w-5" />
          </span>
          <div>
            <Eyebrow>Slug</Eyebrow>
            <div className="mt-0.5 font-mono text-[13px] font-semibold text-ink">{agent.slug}</div>
          </div>
        </Panel>
        <Panel className="flex items-center gap-3 p-4">
          <span className="grid h-10 w-10 place-items-center rounded-[12px] bg-emerald-soft text-emerald">
            <ShieldCheck className="h-5 w-5" />
          </span>
          <div>
            <Eyebrow>Status</Eyebrow>
            <div className="mt-0.5 flex items-center gap-1.5 text-[13px] font-semibold text-ink">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald" /> Online
            </div>
          </div>
        </Panel>
      </div>

      <Wrapper {...wrapperProps} className="space-y-4 pb-24">
        {/* Model picker */}
        <Panel className="p-5">
          <Eyebrow>Default model</Eyebrow>
          <div className="mt-3 flex flex-wrap gap-2">
            {['gemini-2.5-flash', 'gemini-2.5-pro'].map((m) => (
              <label
                key={m}
                className="cursor-pointer"
                aria-disabled={!isAdmin}
              >
                <input
                  type="radio"
                  name="default_model"
                  value={m}
                  defaultChecked={agent.default_model === m}
                  disabled={!isAdmin}
                  className="peer sr-only"
                />
                <span className="inline-flex items-center gap-2 rounded-pill border border-border bg-surface px-4 py-2 font-mono text-[13px] text-ink-muted transition-colors peer-checked:border-primary/40 peer-checked:bg-primary-soft peer-checked:text-primary-ink peer-checked:font-semibold">
                  <Cpu className="h-3.5 w-3.5" />
                  {m}
                </span>
              </label>
            ))}
          </div>
        </Panel>

        {/* Tools */}
        <Panel className="p-5">
          <div className="flex items-center justify-between">
            <Eyebrow>Capabilities</Eyebrow>
            <span className="rounded-pill bg-primary-soft px-2.5 py-1 text-[11px] font-semibold text-primary-ink">
              {agent.allowed_tool_ids.length} / {TOTAL_TOOLS} enabled
            </span>
          </div>
          <div className="mt-4 space-y-5">
            {TOOL_GROUPS.map((group) => {
              const Icon = group.icon;
              const on = group.tools.filter((t) => enabled.has(t.id)).length;
              return (
                <div key={group.label}>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-surface-2 text-ink-muted">
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <span className="text-[13px] font-semibold text-ink">{group.label}</span>
                    <span className="text-[11px] text-ink-faint">
                      {on}/{group.tools.length}
                    </span>
                  </div>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {group.tools.map((t) => (
                      <label
                        key={t.id}
                        className="group/tool cursor-pointer"
                        aria-disabled={!isAdmin}
                      >
                        <input
                          type="checkbox"
                          name="allowed_tool_ids"
                          value={t.id}
                          defaultChecked={enabled.has(t.id)}
                          disabled={!isAdmin}
                          className="peer sr-only"
                        />
                        <span className="flex items-center justify-between gap-2 rounded-[10px] border border-border bg-surface px-3 py-2 text-[13px] text-ink-muted transition-colors hover:border-border-strong peer-checked:border-primary/40 peer-checked:bg-primary-soft peer-checked:text-ink peer-disabled:opacity-60">
                          <span className="flex items-center gap-2">
                            <span className="h-3.5 w-3.5 shrink-0 rounded-[5px] border border-border-strong bg-surface peer-checked:border-primary peer-checked:bg-primary" />
                            <span className="font-medium">{shortName(t.id)}</span>
                          </span>
                          {t.write && (
                            <span className="rounded-pill bg-amber-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-amber">
                              Write
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>

        {/* System prompt */}
        <Panel className="p-5">
          <div className="flex items-center justify-between">
            <Eyebrow>System prompt</Eyebrow>
            <span className="text-[11px] text-ink-faint">{promptWords} words</span>
          </div>
          {isAdmin ? (
            <textarea
              name="system_prompt"
              defaultValue={agent.system_prompt}
              rows={16}
              spellCheck={false}
              className="scroll-slim mt-3 w-full resize-y rounded-[12px] border border-border bg-surface-2 p-3.5 font-mono text-[12.5px] leading-relaxed text-ink focus:border-primary/40 focus:bg-surface focus:outline-none focus:ring-4 focus:ring-primary/10"
            />
          ) : (
            <pre className="scroll-slim mt-3 max-h-[480px] overflow-auto whitespace-pre-wrap rounded-[12px] border border-border bg-surface-2 p-3.5 font-mono text-[12.5px] leading-relaxed text-ink-muted">
              {agent.system_prompt}
            </pre>
          )}
        </Panel>

        {/* Sticky save bar (admin only) */}
        {isAdmin && (
          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-border bg-surface/90 backdrop-blur-md md:left-64">
            <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 md:px-8">
              <span className="text-[13px] text-ink-faint">Changes apply to every conversation with this agent.</span>
              <button
                type="submit"
                className="rounded-pill bg-primary px-6 py-2 text-[13px] font-semibold text-white shadow-pop hover:bg-primary-strong"
              >
                Save changes
              </button>
            </div>
          </div>
        )}
      </Wrapper>
    </>
  );
}
