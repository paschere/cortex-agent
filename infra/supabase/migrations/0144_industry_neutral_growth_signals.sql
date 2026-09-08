alter table public.growth_signals
  alter column company drop not null,
  alter column role_title drop not null,
  add column if not exists candidate_name text,
  add column if not exists offer text,
  add column if not exists ideal_client text,
  add column if not exists industry text,
  add column if not exists buying_signal text,
  add column if not exists opportunity_need text,
  add column if not exists evidence_excerpt text;

comment on column public.growth_signals.role_title is
  'Optional legacy hiring use case. Generic commercial opportunities do not require a job title.';
comment on column public.growth_signals.candidate_name is
  'Unverified name shown by broad search. It remains separate from company until a person confirms the target.';
comment on column public.growth_signals.offer is
  'What this workspace could sell to the prospect; supplied by the user, never inferred as a fact.';
comment on column public.growth_signals.ideal_client is
  'The user-defined ideal-client profile used to search and qualify the opportunity.';
comment on column public.growth_signals.buying_signal is
  'The public event or condition that may indicate commercial timing.';
comment on column public.growth_signals.opportunity_need is
  'The prospect need that the public evidence may support; a hypothesis until reviewed.';
comment on column public.growth_signals.evidence_excerpt is
  'Short excerpt from the source. Evidence for review, not automatic verification of the prospect or need.';
