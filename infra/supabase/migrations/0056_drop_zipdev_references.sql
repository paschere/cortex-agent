-- Drop the last references to Zipdev from seeded data.
--
-- WHY. Cortex started as one company's internal tool and is now a multi-tenant
-- product. Everything a tenant's database inherits from the seed migrations
-- still names that company: the agents introduce themselves as "Zipdev Sales",
-- the super-agent tells the model it works "for Zipdev, a nearshore
-- developer-talent company", and the seeded dev repositories point at that
-- company's GitHub org. A model reading those prompts will confidently talk
-- about a company its user has never heard of, and the repository rows send
-- unattended dev tasks at somebody else's code.
--
-- The prompts are the interesting part. They are not rewritten wholesale — the
-- domain knowledge in them (how to qualify a deal, how to score a candidate,
-- when to escalate) is what makes the agents useful and is company-agnostic
-- already. Only the identity is replaced, so the result reads as if it had
-- always been written generically rather than as a redacted document.
--
-- Idempotent throughout: every statement is an UPDATE keyed on a stable
-- identifier, or is guarded, so re-running converges to the same rows.

-- ---------------------------------------------------------------------------
-- 1. Cortex — rewritten in full
-- ---------------------------------------------------------------------------
-- This one names the company in almost every paragraph, so a chain of
-- replace() calls would leave seams. It is restated here in one piece,
-- including the no-jargon rule appended by 0039 — keeping that text inline
-- means 0039's `not like '%Never speak like an engineer%'` guard still holds
-- and cannot append it a second time.

update public.agents
set system_prompt = $PROMPT$You are **Cortex**, the company's super-agent — one teammate that works across sales, recruiting, HR, and client care for the whole organization. You take the repetitive 80% of the work off people's plates so their day goes to decisions, not tabs.

Your four fronts:
- **Sell more:** run HubSpot end to end (deals, contacts, timelines, pipeline hygiene, follow-ups), draft and send outreach in the user's voice, and quote rates mid-conversation with the rate tools (`rate.estimate`, `rate.estimate_from_document`, `sales.draft_proposal`).
- **Recruit better:** search the talent pool, score candidates with reasons (`recruit.*`), compare finalists and flag trade-offs, and let the user interrogate any profile — answers grounded in real interviews, assessments, and history.
- **HR without friction:** answer payroll and team questions with real numbers (`payroll.*`, `people.*`). Anything sensitive — a conflict, a resignation risk, someone struggling — you bring privately to a human with context, then step back. Never handle those alone.
- **Take care of clients:** prep the user before calls (HubSpot timeline + Knowledge Base), draft check-ins and progress reports in the client's language, and flag at-risk accounts early.

You also operate the surrounding stack: GitHub and Linear (`github.*`, `linear.*`) for engineering visibility, Google Workspace (`gmail.*`, `gcal.*`, `gsheets.*`, `gdrive.*`), Slack, web research (`web.*`), and unattended routines (`schedule.*` — e.g. "every Friday at 4, send each client their report").

Behavioral rules:
1. **The Knowledge Base is the company's brain.** Search it (`kb.search`) before answering anything that could be covered by internal knowledge — clients, playbooks, rates, candidates, processes, past proposals — and persist durable work products back with `kb.create_document`.
2. **Ground every claim in tool data.** Never invent a deal, contact, candidate, rate, repo, issue, or statistic. Fetch it this turn and cite ids inline (HubSpot deal ids, candidate names, `owner/repo#123`, `ENG-45`) so the user can verify. When you don't know, say so.
3. **Confirm before any write.** Creating, updating, sending, posting, or scheduling is confirmation-gated: show the exact payload (recipient, title, body, amounts) and wait for explicit approval before executing. Nothing important happens without the user.
4. **Log everything.** Prefer flows that leave a trail in Cortex (conversations, KB, audit) over ones that live only in someone's head.
5. **Escalate the human stuff.** HR cases, unhappy clients, and hiring decisions end with a person: you prepare the context, the user decides.
6. **Respond in the user's language.** Spanish in → Spanish out. English in → English out. Client-facing drafts go in the client's language.

Be sharp, concise, and evidence-first. Numbers over adjectives. Lead with the answer, then the support. You are a teammate, not a chatbot: given a goal, plan it, execute it, and report — asking one clarifying question up front if you truly need it.

Never speak like an engineer to a non-engineer. Do not name internal systems, repositories, services, endpoints, tools, payload sizes, character counts, field names, or data-quality diagnostics ("the company field is empty in 49 of 57 records"). Translate every technical finding into business language: what you found, what it means for their work, and what you suggest doing next. If data is missing or unusable, say in one sentence what you could not find and what you need in order to get it — never describe the plumbing.$PROMPT$
where slug = 'cortex';

-- ---------------------------------------------------------------------------
-- 2. Sales and Recruiting — surgical replacements
-- ---------------------------------------------------------------------------
-- These two are archived agents with long, still-valuable playbooks. The brand
-- appears in a handful of known phrasings, each of which needs its own wording
-- to stay grammatical ("You are **Zipdev Sales**" cannot become "You are **the
-- company Sales**"), so they are replaced by hand rather than swept.

update public.agents
set
  name = 'Sales',
  system_prompt = replace(
    replace(
      replace(
        replace(
          replace(
            system_prompt,
            'You are **Zipdev Sales**, the AI co-pilot embedded in Zipdev''s sales team.',
            'You are the **Sales co-pilot**, embedded in the company''s sales team.'
          ),
          'Zipdev places engineers and operators',
          'The company places engineers and operators'
        ),
        '# Rate ranges reference (2026-Q1, Zipdev internal pricing)',
        '# Rate ranges reference (2026-Q1, internal pricing)'
      ),
      '### Why Zipdev',
      '### Why us'
    ),
    'a specific Zipdev differentiator',
    'a specific differentiator of ours'
  )
where slug = 'sales';

update public.agents
set
  name = 'Recruiting',
  system_prompt = replace(
    replace(
      replace(
        system_prompt,
        'You are **Zipdev Recruiting**, the AI co-pilot embedded in Zipdev''s recruiting team.',
        'You are the **Recruiting co-pilot**, embedded in the company''s recruiting team.'
      ),
      'Zipdev sources and vets engineers',
      'The company sources and vets engineers'
    ),
    'never present them as vetted Zipdev candidates',
    'never present them as vetted candidates from the pool'
  )
where slug = 'recruiting';

-- ---------------------------------------------------------------------------
-- 3. Catch-all
-- ---------------------------------------------------------------------------
-- The seed migrations are not the only way a prompt gets written: 0010 ships a
-- shorter sales prompt that 0016 later overwrites, and an admin can edit any of
-- these from the settings page. Anything still naming the company after the
-- passes above is swept generically. The `where ... ilike` guards keep this a
-- no-op on a database that is already clean, which is what makes re-running the
-- migration safe.

update public.agents
set system_prompt = replace(replace(system_prompt, 'Zipdev''s', 'the company''s'), 'Zipdev', 'the company')
where system_prompt like '%Zipdev%';

update public.agents
set name = btrim(replace(name, 'Zipdev', ''))
where name like '%Zipdev%';

-- Teams are seeded as 'Sales' and 'Engineering' — already generic, so there is
-- nothing to rename here. The statement stays as the guard: if a deployment
-- ever named a team after the company, this catches it.
update public.teams
set name = btrim(replace(name, 'Zipdev', ''))
where name like '%Zipdev%' and btrim(replace(name, 'Zipdev', '')) <> '';

-- ---------------------------------------------------------------------------
-- 4. Seeded dev repositories
-- ---------------------------------------------------------------------------
-- 0046 seeded three repositories belonging to one company's GitHub org. On any
-- other tenant they are worse than useless: `resolveRepository` will happily
-- hand an unattended dev task a clone URL pointing at a stranger's codebase.
--
-- They are deactivated rather than deleted, because dev_tasks reference them
-- and losing the row would orphan the history of runs that already happened.
-- is_active = false takes them out of selection while leaving the audit trail
-- readable; the original deployment can flip them back on.

update public.dev_repositories
set is_active = false,
    updated_at = now()
where clone_url ilike '%github.com/Zipdev-Team/%'
  and is_active;

-- ---------------------------------------------------------------------------
-- 5. Signup domain restriction
-- ---------------------------------------------------------------------------
-- 0009's trigger fell back to a hardcoded company domain whenever
-- `app.allowed_email_domain` was unset, so a fresh multi-tenant database
-- rejected every sign-up that was not on that one company's domain — with an
-- error message naming it.
--
-- The default is now "no restriction", which matches what ALLOWED_EMAIL_DOMAIN
-- documents in .env.example: empty means open signup, and setting it turns a
-- deployment back into a single-company instance. Restricting is still one
-- setting away; guessing which company to restrict to is not something the
-- database can do.

create or replace function public.handle_new_auth_user() returns trigger
language plpgsql security definer as $$
declare
  v_domain text := lower(split_part(new.email, '@', 2));
  v_allowed text := nullif(btrim(coalesce(current_setting('app.allowed_email_domain', true), '')), '');
begin
  if v_allowed is not null and v_domain <> v_allowed then
    raise exception 'sign-in restricted to % accounts', v_allowed;
  end if;
  insert into public.users(id, email, name, role, google_sub)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    case when not exists (select 1 from public.users) then 'org_admin'::user_role else 'member'::user_role end,
    new.raw_user_meta_data->>'sub'
  )
  on conflict (id) do update
    set email = excluded.email, name = coalesce(excluded.name, public.users.name);
  return new;
end;
$$;
