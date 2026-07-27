'use server';

import { buildToolContext } from '@/lib/agent';
import { requireSession } from '@/lib/session';
import { getSupabaseServiceClient } from '@/lib/supabase/service';
import {
  apolloCompanyNews,
  apolloEnrichCompany,
  growthUpdateSignal,
  runTool,
} from '@zipdev/agent-tools';
import type { UUID } from '@zipdev/core';
import { revalidatePath } from 'next/cache';
import type { ActionResult, CompanyProfile, NewsItem, SignalStatus } from './_components/types';

/**
 * Every write on this page goes through `runTool` rather than straight to the
 * table, for one reason: Zippy already moves these signals from chat, and the
 * two surfaces must not drift. Same tool, same validation, same four states,
 * and the same audit row naming the person who did it.
 */

const PATH = '/prospects';

const STATUSES: SignalStatus[] = ['new', 'qualified', 'rejected', 'contacted'];

/** Zippy is the agent every tool call on this page is attributed to. */
async function zippyContext(userId: UUID, signal?: AbortSignal) {
  const db = getSupabaseServiceClient();
  const { data } = await db.from('agents').select('id').eq('slug', 'zippy').maybeSingle();
  if (!data?.id) return null;
  return buildToolContext({ userId, agentId: data.id as UUID, signal });
}

/** Turns any thrown tool error into a sentence a salesperson can act on. */
function describe(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : '';
  if (/not found/i.test(message)) return 'That prospect is no longer on file.';
  return message && message.length < 160 ? message : fallback;
}

const NO_AGENT = 'Zippy is not set up on this workspace yet, so nothing can be recorded.';

/**
 * Move a prospect between the four states. The caller updates its own UI first
 * and rolls back on `{ ok: false }`.
 */
export async function setProspectStatus(
  signalId: string,
  status: SignalStatus,
): Promise<ActionResult<{ reviewerName: string; reviewedAt: string }>> {
  const user = await requireSession();
  if (!STATUSES.includes(status)) return { ok: false, error: 'That is not a valid stage.' };

  const ctx = await zippyContext(user.id);
  if (!ctx) return { ok: false, error: NO_AGENT };

  try {
    // The tool stamps reviewed_by/reviewed_at from ctx.userId, so the person
    // named on the card is the person whose session made the request.
    await runTool(growthUpdateSignal, { signalId, status }, ctx, { confirmed: true });
  } catch (err) {
    return { ok: false, error: describe(err, 'That change did not save. Try again in a moment.') };
  }

  revalidatePath(PATH);
  return {
    ok: true,
    reviewerName: user.name ?? user.email,
    reviewedAt: new Date().toISOString(),
  };
}

/**
 * Apollo: paid, and only ever for the one company whose button was pressed.
 *
 * Nothing here runs on render, on a list, or on a schedule — Apollo bills per
 * company matched, and a page that enriched forty rows on load would spend forty
 * credits before anyone read a word. `confirmed: true` is honest here: the
 * button that reaches this action states the cost in its own label, so the click
 * IS the confirmation.
 */
export async function lookUpCompany(
  signalId: string,
): Promise<ActionResult<{ company: CompanyProfile | null; note: string | null }>> {
  const user = await requireSession();
  const db = getSupabaseServiceClient();

  // Read the company name from the row rather than trusting the caller: the
  // client cannot choose which company we spend a credit on.
  const { data: row } = await db
    .from('growth_signals')
    .select('company')
    .eq('id', signalId)
    .maybeSingle();
  if (!row?.company) return { ok: false, error: 'That prospect is no longer on file.' };

  const ctx = await zippyContext(user.id);
  if (!ctx) return { ok: false, error: NO_AGENT };

  try {
    const out = await runTool(apolloEnrichCompany, { name: row.company as string }, ctx, {
      confirmed: true,
    });
    if (!out.configured || out.reason) {
      return { ok: false, error: out.reason ?? 'Apollo did not answer.' };
    }
    if (!out.found || !out.company) {
      return {
        ok: true,
        company: null,
        note: 'Apollo has nothing on file under that name, so no credit was spent. The name comes from the job board, which sometimes spells it differently.',
      };
    }
    const c = out.company;
    return {
      ok: true,
      note: null,
      company: {
        apolloId: c.apolloId,
        name: c.name,
        domain: c.domain,
        website: c.website,
        linkedinUrl: c.linkedinUrl,
        industry: c.industry,
        employees: c.employees,
        location: c.location,
        foundedYear: c.foundedYear,
        annualRevenue: c.annualRevenue,
        totalFunding: c.totalFunding,
        latestFundingStage: c.latestFundingStage,
        technologies: c.technologies.slice(0, 8),
      },
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'Apollo could not be reached just now.') };
  }
}

/**
 * Recent press for a company already looked up. It takes Apollo's own reference
 * (returned by the lookup above) precisely so this costs one credit and not two
 * — naming the company by domain would make Apollo find it all over again.
 */
export async function lookUpCompanyNews(
  companyApolloId: string,
): Promise<ActionResult<{ articles: NewsItem[]; note: string | null }>> {
  const user = await requireSession();
  const ctx = await zippyContext(user.id);
  if (!ctx) return { ok: false, error: NO_AGENT };

  try {
    const out = await runTool(apolloCompanyNews, { companyApolloId, limit: 5, page: 1 }, ctx, {
      confirmed: true,
    });
    if (!out.configured || out.reason) {
      return { ok: false, error: out.reason ?? 'Apollo did not answer.' };
    }
    return {
      ok: true,
      articles: out.articles.map((a) => ({
        headline: a.headline,
        url: a.url,
        publisher: a.publisher,
        publishedAt: a.publishedAt,
        categories: a.categories,
      })),
      note: out.articles.length
        ? null
        : 'Nothing has been written about them recently — that is common for smaller companies and says nothing bad about the lead.',
    };
  } catch (err) {
    return { ok: false, error: describe(err, 'Apollo could not be reached just now.') };
  }
}
