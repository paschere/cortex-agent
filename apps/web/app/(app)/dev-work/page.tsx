import { PageHeader } from "@/components/ui/page-header";
import { Panel } from "@/components/ui/panel";
import {
  DEV_REPO_COLUMNS,
  DEV_TASK_COLUMNS,
  type DevTask,
  formatCost,
  isMissingTable,
  repoLabel,
  toDevRepository,
  toDevTask,
} from "@/lib/dev-work";
import { requireSession } from "@/lib/session";
import { getSupabaseServiceClient } from "@/lib/supabase/service";
import {
  CircleAlert,
  CircleDollarSign,
  FolderGit2,
  Hammer,
  Hourglass,
  Loader,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { RefreshButton } from "../schedules/_components/RefreshButton";
import { TaskCard } from "./_components/TaskCard";

export const dynamic = "force-dynamic";

/** How many runs the page holds. Everything older lives in the database. */
const PAGE_SIZE = 100;
const WINDOW_DAYS = 7;

function SectionLabel({
  icon,
  children,
  count,
  chip,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  count: number;
  chip: string;
}) {
  return (
    <div className="mb-2.5 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-faint">
      {icon}
      {children}
      <span
        className={`rounded-pill px-1.5 py-0.5 text-[10px] font-bold ${chip}`}
      >
        {count}
      </span>
    </div>
  );
}

export default async function DevWorkPage() {
  await requireSession();
  const db = getSupabaseServiceClient();

  const [taskRes, repoRes] = await Promise.all([
    db
      .from("dev_tasks")
      .select(DEV_TASK_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(PAGE_SIZE),
    db.from("dev_repositories").select(DEV_REPO_COLUMNS).order("name"),
  ]);

  // The intake agent owns these tables. Until its migration lands they simply
  // do not exist, and a database error is not something the person reading this
  // page can act on — so say what is true instead.
  const notReady =
    isMissingTable(taskRes.error) || isMissingTable(repoRes.error);

  const tasks: DevTask[] = (
    (taskRes.data ?? []) as unknown as Record<string, unknown>[]
  ).map(toDevTask);
  const repos = (
    (repoRes.data ?? []) as unknown as Record<string, unknown>[]
  ).map(toDevRepository);
  const repoById = new Map(repos.map((r) => [r.id, r]));

  // Requester names, resolved in one round trip.
  const requesterIds = [
    ...new Set(tasks.map((t) => t.requestedBy).filter(Boolean)),
  ] as string[];
  const nameById = new Map<string, string>();
  if (requesterIds.length > 0) {
    const { data: people } = await db
      .from("users")
      .select("id, name, email")
      .in("id", requesterIds);
    for (const p of people ?? []) {
      nameById.set(
        p.id as string,
        (p.name as string | null) ?? (p.email as string),
      );
    }
  }
  const requesterFor = (t: DevTask): string | null =>
    (t.requestedBy ? nameById.get(t.requestedBy) : null) ?? t.requestedByName;

  const needsYou = tasks.filter((t) => t.status === "needs_review");
  const inFlight = tasks.filter(
    (t) => t.status === "queued" || t.status === "running",
  );
  const finished = tasks.filter(
    (t) =>
      t.status === "done" || t.status === "failed" || t.status === "cancelled",
  );

  const since = Date.now() - WINDOW_DAYS * 86_400_000;
  const recent = tasks.filter((t) => new Date(t.createdAt).getTime() >= since);
  const failedRecently = recent.filter((t) => t.status === "failed").length;
  const shippedRecently = recent.filter((t) => t.status === "done").length;
  const spend = recent.reduce((sum, t) => sum + (t.costUsd ?? 0), 0);
  const spendText = recent.some((t) => t.costUsd !== null)
    ? formatCost(spend)
    : null;
  const enabledRepos = repos.filter((r) => r.enabled).length;

  const stats = [
    {
      label: "Working now",
      value: String(inFlight.length),
      sub: inFlight.length > 0 ? "in progress" : "nothing running",
      icon: Loader,
      chip: "bg-primary-soft text-primary",
    },
    {
      label: "Waiting for you",
      value: String(needsYou.length),
      sub: needsYou.length > 0 ? "needs a person" : "all reviewed",
      icon: Hourglass,
      chip:
        needsYou.length > 0
          ? "bg-amber-soft text-amber"
          : "bg-surface-2 text-ink-faint",
    },
    {
      label: `Shipped · ${WINDOW_DAYS}d`,
      value: String(shippedRecently),
      sub: "changes handed over",
      icon: Hammer,
      chip: "bg-emerald-soft text-emerald",
    },
    {
      label: `Failed · ${WINDOW_DAYS}d`,
      value: String(failedRecently),
      sub: failedRecently > 0 ? "worth a look" : "none",
      icon: CircleAlert,
      chip:
        failedRecently > 0
          ? "bg-rose-soft text-rose"
          : "bg-emerald-soft text-emerald",
    },
    spendText
      ? {
          label: `Spend · ${WINDOW_DAYS}d`,
          value: spendText,
          sub: "across these runs",
          icon: CircleDollarSign,
          chip: "bg-surface-2 text-ink-muted",
        }
      : {
          label: "Repositories",
          value: String(enabledRepos),
          sub: `Cortex may edit ${enabledRepos === 1 ? "one repo" : `${enabledRepos} repos`}`,
          icon: FolderGit2,
          chip: "bg-surface-2 text-ink-muted",
        },
  ];

  return (
    <>
      <PageHeader
        title="Dev Work"
        subtitle="Every change Cortex is making to Cortex's own software, on its own. Watch it here — and stop it here."
        icon={<Hammer className="h-5 w-5" />}
        actions={
          <>
            <Link
              href="/dev-work/repositories"
              className="inline-flex items-center gap-1.5 rounded-[10px] border border-border bg-surface px-3 py-1.5 text-[12.5px] font-semibold text-ink-muted shadow-card transition hover:bg-surface-2 hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <ShieldCheck className="h-3.5 w-3.5" /> Repositories
            </Link>
            <RefreshButton />
          </>
        }
      />

      {notReady ? (
        <Panel className="p-10 text-center text-[13px] text-ink-faint">
          <Hammer className="mx-auto mb-3 h-8 w-8 text-primary" />
          <p className="mb-1 font-semibold text-ink">
            Not switched on in this environment yet
          </p>
          <p className="mx-auto max-w-md">
            Cortex cannot pick up its own development work here — the groundwork
            for it has not been installed. Once it is, every run shows up on
            this page as it happens.
          </p>
        </Panel>
      ) : (
        <>
          <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
            {stats.map((s) => (
              <Panel key={s.label} className="flex items-center gap-3 p-3.5">
                <span
                  className={`grid h-9 w-9 shrink-0 place-items-center rounded-[10px] ${s.chip}`}
                >
                  <s.icon className="h-4 w-4" />
                </span>
                <div className="min-w-0">
                  <div
                    className="truncate text-[15px] font-extrabold leading-tight text-ink"
                    title={s.value}
                  >
                    {s.value}
                  </div>
                  <div
                    className="truncate text-[10.5px] text-ink-faint"
                    title={s.label}
                  >
                    {s.label}
                  </div>
                  <div
                    className="truncate text-[10.5px] text-ink-faint"
                    title={s.sub}
                  >
                    {s.sub}
                  </div>
                </div>
              </Panel>
            ))}
          </div>

          {tasks.length === 0 ? (
            <Panel className="p-10 text-center text-[13px] text-ink-faint">
              <Hammer className="mx-auto mb-3 h-8 w-8 text-primary" />
              <p className="mb-1 font-semibold text-ink">
                Cortex has not been asked for anything
              </p>
              <p className="mx-auto max-w-md">
                Assign a Linear issue to Cortex and it turns up here — you will
                see it pick the work up, and you can stop it at any point.
              </p>
            </Panel>
          ) : (
            <div className="space-y-8">
              {needsYou.length > 0 && (
                <section>
                  <SectionLabel
                    icon={<Hourglass className="h-3.5 w-3.5 text-amber" />}
                    count={needsYou.length}
                    chip="bg-amber-soft text-amber"
                  >
                    Waiting for you
                  </SectionLabel>
                  <div className="space-y-3">
                    {needsYou.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        repository={repoLabel(
                          repoById.get(t.repositoryId ?? ""),
                        )}
                        requester={requesterFor(t)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {inFlight.length > 0 && (
                <section>
                  <SectionLabel
                    icon={<Loader className="h-3.5 w-3.5 text-primary" />}
                    count={inFlight.length}
                    chip="bg-primary-soft text-primary"
                  >
                    Happening now
                  </SectionLabel>
                  <div className="space-y-3">
                    {inFlight.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        repository={repoLabel(
                          repoById.get(t.repositoryId ?? ""),
                        )}
                        requester={requesterFor(t)}
                      />
                    ))}
                  </div>
                </section>
              )}

              {finished.length > 0 && (
                <section>
                  <SectionLabel
                    icon={<Hammer className="h-3.5 w-3.5 text-ink-faint" />}
                    count={finished.length}
                    chip="bg-surface-2 text-ink-faint"
                  >
                    Finished
                  </SectionLabel>
                  <div className="space-y-3">
                    {finished.map((t) => (
                      <TaskCard
                        key={t.id}
                        task={t}
                        repository={repoLabel(
                          repoById.get(t.repositoryId ?? ""),
                        )}
                        requester={requesterFor(t)}
                      />
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </>
      )}
    </>
  );
}
