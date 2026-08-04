'use client';

import { Provenance } from '@/components/ui/provenance';
import { chipClass } from '@/lib/status-chip';
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
  // Apollo is a third party asserting these facts, so the moment we read them is
  // part of the answer — the stamp below shows it.
  const [readAt, setReadAt] = useState<string | null>(null);

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
    setReadAt(stamp());
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
    setReadAt(stamp());
  }

  return (
    <div className="mt-2.5">
      {!opened ? (
        <button
          type="button"
          onClick={loadProfile}
          className="inline-flex items-center gap-1.5 rounded-card border border-border-strong px-3 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <Building2 className="h-3.5 w-3.5" />
          Consultar {company} en Apollo
          <span className={chipClass('amber')}>gasta 1 crédito</span>
        </button>
      ) : (
        <div className="rounded-card border border-border bg-surface-2 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            {/* Apollo asserted this, and the stamp says when we read it. */}
            {readAt ? (
              <Provenance source="APOLLO" readAt={readAt} />
            ) : (
              <span className="field-label flex items-center gap-1.5">
                <Building2 className="h-3 w-3" />
                Apollo
              </span>
            )}
            {loading === 'profile' && (
              <Loader2 className="h-3 w-3 animate-spin text-ink-faint motion-reduce:animate-none" />
            )}
          </div>

          {error && (
            <p className="mt-1.5 text-[12px] text-rose">
              {error} No se gastó ningún crédito.
            </p>
          )}
          {note && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-muted">{note}</p>}

          {profile && (
            <>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
                <Fact label="Industria" value={profile.industry} />
                <Fact
                  label="Empleados"
                  value={profile.employees ? profile.employees.toLocaleString() : null}
                />
                <Fact label="Sede" value={profile.location} />
                <Fact
                  label="Fundada en"
                  value={profile.foundedYear ? `${profile.foundedYear}` : null}
                />
                <Fact label="Ingresos" value={profile.annualRevenue} />
                <Fact
                  label="Inversión"
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
                      className="rounded-sm border border-border bg-surface px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}

              {(profile.website || profile.linkedinUrl) && (
                <div className="mt-2 flex flex-wrap gap-3 text-[11.5px]">
                  {profile.website && <Outbound href={profile.website} label="Sitio web" />}
                  {profile.linkedinUrl && <Outbound href={profile.linkedinUrl} label="LinkedIn" />}
                </div>
              )}

              {profile.apolloId && articles === null && (
                <button
                  type="button"
                  disabled={loading !== null}
                  onClick={() => profile.apolloId && loadNews(profile.apolloId)}
                  className="mt-2.5 inline-flex items-center gap-1.5 rounded-card border border-border-strong bg-surface px-3 py-1.5 text-[12px] font-semibold text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink disabled:opacity-60"
                >
                  {loading === 'news' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
                  ) : (
                    <Newspaper className="h-3.5 w-3.5" />
                  )}
                  Noticias recientes: inversión, contrataciones, contratos nuevos
                  <span className={chipClass('amber')}>gasta 1 crédito</span>
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
                  <span className="tabular text-[11px] text-ink-faint">
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
      <dt className="field-label">{label}</dt>
      <dd className="tabular truncate text-[12px] font-medium text-ink" title={value}>
        {value}
      </dd>
    </div>
  );
}

/** When the lookup was made, in the stamp's compact format. */
function stamp(): string {
  return new Date().toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
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
