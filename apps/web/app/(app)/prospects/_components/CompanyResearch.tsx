'use client';

import { clsx } from 'clsx';
import { Building2, ExternalLink, Loader2, Newspaper } from 'lucide-react';
import { useState } from 'react';
import { lookUpCompany, lookUpCompanyNews } from '../actions';
import type { CompanyProfile, NewsItem } from './types';

/**
 * On-demand Apollo research for ONE company.
 *
 * Apollo bills per lookup, so nothing here happens on render and nothing here
 * happens for a list — it is one button, on one card, pressed by one person, and
 * the button says what the press costs before it is pressed. The news lookup
 * only appears after the profile is loaded, because it reuses the reference the
 * profile returned and so costs one credit instead of two.
 *
 * Results are held for the session and never written back to the signal: the
 * stored row is what Cortex found on a job board, and mixing a paid third-party
 * snapshot into it would blur where each fact came from.
 */
export function CompanyResearch({
  signalId,
  company,
  available,
}: {
  signalId: string;
  company: string;
  available: boolean;
}) {
  const [profile, setProfile] = useState<CompanyProfile | null>(null);
  const [articles, setArticles] = useState<NewsItem[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<'profile' | 'news' | null>(null);
  const [opened, setOpened] = useState(false);

  if (!available) return null;

  async function loadProfile() {
    setLoading('profile');
    setError(null);
    setNote(null);
    setOpened(true);
    const result = await lookUpCompany(signalId);
    setLoading(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setProfile(result.company);
    setNote(result.note);
  }

  async function loadNews(apolloId: string) {
    setLoading('news');
    setError(null);
    const result = await lookUpCompanyNews(apolloId);
    setLoading(null);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setArticles(result.articles);
    setNote(result.note);
  }

  return (
    <div className="mt-2.5">
      {!opened ? (
        <button
          type="button"
          onClick={loadProfile}
          className="inline-flex items-center gap-1.5 rounded-pill border border-border px-3 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink"
        >
          <Building2 className="h-3.5 w-3.5" />
          Look up {company} in Apollo
          <span className="rounded-pill bg-amber-soft px-1.5 py-0.5 text-[10px] font-bold text-amber">
            costs 1 credit
          </span>
        </button>
      ) : (
        <div className="rounded-[10px] border border-border bg-surface-2 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-ink-faint">
            <Building2 className="h-3 w-3" />
            Apollo
            {loading === 'profile' && <Loader2 className="h-3 w-3 animate-spin" />}
          </div>

          {error && <p className="mt-1.5 text-[12px] text-rose">{error}</p>}
          {note && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">{note}</p>}

          {profile && (
            <>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                <Fact label="Industry" value={profile.industry} />
                <Fact
                  label="Headcount"
                  value={profile.employees ? profile.employees.toLocaleString() : null}
                />
                <Fact label="Based in" value={profile.location} />
                <Fact
                  label="Founded"
                  value={profile.foundedYear ? `${profile.foundedYear}` : null}
                />
                <Fact label="Revenue" value={profile.annualRevenue} />
                <Fact
                  label="Funding"
                  value={
                    profile.totalFunding
                      ? `${profile.totalFunding}${profile.latestFundingStage ? ` · ${profile.latestFundingStage}` : ''}`
                      : null
                  }
                />
              </dl>

              {profile.technologies.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {profile.technologies.map((t) => (
                    <span
                      key={t}
                      className="rounded-pill bg-surface px-2 py-0.5 text-[10.5px] font-medium text-ink-muted"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {(profile.website || profile.linkedinUrl) && (
                <div className="mt-2 flex flex-wrap gap-3 text-[11.5px]">
                  {profile.website && <Outbound href={profile.website} label="Website" />}
                  {profile.linkedinUrl && <Outbound href={profile.linkedinUrl} label="LinkedIn" />}
                </div>
              )}

              {profile.apolloId && articles === null && (
                <button
                  type="button"
                  disabled={loading !== null}
                  onClick={() => profile.apolloId && loadNews(profile.apolloId)}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-pill border border-border bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:border-border-strong hover:text-ink disabled:opacity-60"
                >
                  {loading === 'news' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Newspaper className="h-3.5 w-3.5" />
                  )}
                  Recent news — funding, hiring, new contracts
                  <span className="rounded-pill bg-amber-soft px-1.5 py-0.5 text-[10px] font-bold text-amber">
                    costs 1 credit
                  </span>
                </button>
              )}
            </>
          )}

          {articles && articles.length > 0 && (
            <ul className="mt-2.5 space-y-1.5 border-t border-border pt-2.5">
              {articles.map((a) => (
                <li key={`${a.url ?? a.headline}`} className="text-[12px] leading-snug">
                  <a
                    href={a.url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={clsx(
                      'font-medium',
                      a.url ? 'text-primary hover:text-primary-strong' : 'text-ink-muted',
                    )}
                  >
                    {a.headline ?? 'Untitled'}
                  </a>
                  <span className="text-ink-faint">
                    {a.publisher ? ` · ${a.publisher}` : ''}
                    {a.publishedAt ? ` · ${a.publishedAt.slice(0, 10)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="min-w-0">
      <dt className="text-[10.5px] text-ink-faint">{label}</dt>
      <dd className="truncate text-[12px] font-medium text-ink" title={value}>
        {value}
      </dd>
    </div>
  );
}

function Outbound({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 font-semibold text-primary hover:text-primary-strong"
    >
      <ExternalLink className="h-3 w-3" />
      {label}
    </a>
  );
}
