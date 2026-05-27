import { getSupabaseServiceClient } from '@/lib/supabase/service';
import { requireSession } from '@/lib/session';
import { revalidatePath } from 'next/cache';
import { notFound } from 'next/navigation';
import { Card } from '@/components/ui/card';

// ---------------------------------------------------------------------------
// Hardcoded tool registry (mirrors seed SQL + gsheets.append_row)
// Group key → human label
// ---------------------------------------------------------------------------
const TOOL_GROUPS: { label: string; tools: string[] }[] = [
  {
    label: 'HubSpot',
    tools: [
      'hubspot.search_companies',
      'hubspot.get_company',
      'hubspot.search_deals',
      'hubspot.get_deal',
      'hubspot.list_recent_activities',
    ],
  },
  {
    label: 'Rate',
    tools: ['rate.estimate', 'rate.estimate_from_document'],
  },
  {
    label: 'Gmail',
    tools: ['gmail.search', 'gmail.read_thread', 'gmail.draft'],
  },
  {
    label: 'Calendar',
    tools: ['gcal.list_events', 'gcal.create_event'],
  },
  {
    label: 'Sheets',
    tools: ['gsheets.read_range', 'gsheets.append_row'],
  },
  {
    label: 'Knowledge Base',
    tools: ['kb.search', 'kb.list_collections'],
  },
  {
    label: 'Composite',
    tools: ['sales.draft_proposal'],
  },
];

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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
interface AgentRow {
  id: string;
  slug: string;
  name: string;
  default_model: string;
  system_prompt: string;
  allowed_tool_ids: string[];
  teams: { name: string }[] | null;
}

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [user, { slug }] = await Promise.all([requireSession(), params]);

  const sb = getSupabaseServiceClient();
  const { data } = await sb
    .from('agents')
    .select('id, slug, name, default_model, system_prompt, allowed_tool_ids, teams(name)')
    .eq('slug', slug)
    .single();

  if (!data) notFound();
  const agent = data as unknown as AgentRow;

  const isAdmin = user.role === 'org_admin';
  const boundAction = updateAgent.bind(null, agent.slug);

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold">{agent.name}</h1>
        <p className="text-sm text-neutral-500 mt-0.5">
          {agent.teams?.[0]?.name ?? 'No team'} &middot;{' '}
          <span className="font-mono">{agent.slug}</span>
        </p>
      </div>

      {isAdmin ? (
        /* -------- Edit form for org_admin -------- */
        <form action={boundAction} className="space-y-6">
          {/* Model select */}
          <Card>
            <h2 className="font-medium mb-3">Default model</h2>
            <select
              name="default_model"
              defaultValue={agent.default_model}
              className="rounded border bg-white dark:bg-neutral-900 px-3 py-2 text-sm w-full max-w-xs"
            >
              <option value="gemini-2.5-flash">gemini-2.5-flash</option>
              <option value="gemini-2.5-pro">gemini-2.5-pro</option>
            </select>
          </Card>

          {/* Allowed tools — grouped checkboxes */}
          <Card>
            <h2 className="font-medium mb-3">
              Allowed tools ({agent.allowed_tool_ids.length} enabled)
            </h2>
            <div className="space-y-4">
              {TOOL_GROUPS.map((group) => (
                <div key={group.label}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-1.5">
                    {group.label}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {group.tools.map((tool) => {
                      const checked = agent.allowed_tool_ids.includes(tool);
                      return (
                        <label
                          key={tool}
                          className="flex items-center gap-1.5 cursor-pointer text-xs"
                        >
                          <input
                            type="checkbox"
                            name="allowed_tool_ids"
                            value={tool}
                            defaultChecked={checked}
                          />
                          <span className="font-mono">{tool}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* System prompt */}
          <Card>
            <h2 className="font-medium mb-3">System prompt</h2>
            <textarea
              name="system_prompt"
              defaultValue={agent.system_prompt}
              rows={12}
              className="w-full rounded border bg-white dark:bg-neutral-900 px-3 py-2 text-sm font-mono resize-y"
            />
          </Card>

          <button
            type="submit"
            className="rounded bg-neutral-900 text-white dark:bg-white dark:text-neutral-900 px-5 py-2 text-sm font-medium hover:opacity-90"
          >
            Save
          </button>
        </form>
      ) : (
        /* -------- Read-only view -------- */
        <>
          <Card>
            <h2 className="font-medium mb-2">Default model</h2>
            <span className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-mono">
              {agent.default_model}
            </span>
          </Card>

          <Card>
            <h2 className="font-medium mb-3">
              Allowed tools ({agent.allowed_tool_ids.length})
            </h2>
            <div className="flex flex-wrap gap-2">
              {agent.allowed_tool_ids.map((t) => (
                <span
                  key={t}
                  className="rounded-full bg-neutral-100 dark:bg-neutral-800 px-2 py-0.5 text-xs font-mono"
                >
                  {t}
                </span>
              ))}
            </div>
          </Card>

          <Card>
            <h2 className="font-medium mb-2">System prompt</h2>
            <pre className="text-xs whitespace-pre-wrap font-mono leading-relaxed">
              {agent.system_prompt}
            </pre>
          </Card>
        </>
      )}
    </div>
  );
}
