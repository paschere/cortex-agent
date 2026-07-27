-- Approvals become answerable from Google Chat, so a pending action has to be
-- able to say what happened to it.
--
-- Consuming an approval used to be a DELETE. That was single-use, but it left
-- three very different outcomes indistinguishable: "no such request", "already
-- approved", "declined". A button that lives in a Chat message is clicked late,
-- clicked twice, and clicked after the web page already answered — it has to
-- tell those apart to say something true.
--
-- So the row now survives its own decision, and consuming it is an ATOMIC
-- CONDITIONAL UPDATE:
--
--   update mcp_pending_actions
--      set decision = 'approved', ...
--    where id = $1 and user_id = $2 and decision is null and expires_at > now()
--   returning ...
--
-- One statement, so the second click matches zero rows and the action cannot
-- run twice. `decision is null` is the single-use guard, `user_id` is the
-- wrong-person guard, and `expires_at` is the expiry guard — all three enforced
-- by the database rather than by a read-then-write in application code.
alter table public.mcp_pending_actions
  add column if not exists decision    text,
  add column if not exists decided_at  timestamptz,
  add column if not exists decided_by  uuid references public.users(id) on delete set null,
  add column if not exists decided_via text;

alter table public.mcp_pending_actions
  drop constraint if exists mcp_pending_actions_decision_check;
alter table public.mcp_pending_actions
  add constraint mcp_pending_actions_decision_check
  check (decision is null or decision in ('approved', 'declined'));

-- decided_by is the person who actually decided, which is not necessarily the
-- owner: it is recorded so the audit trail names a human, and so a mismatch
-- would be visible if the ownership guard ever regressed.
comment on column public.mcp_pending_actions.decided_by is
  'The person who approved or declined. Must equal user_id — the claim enforces it.';
comment on column public.mcp_pending_actions.decided_via is
  'Surface the decision came from: web | google_chat | mcp.';

-- Every queue read (sidebar badge, dashboard tile, /approvals) asks the same
-- question: what is still undecided for this person?
create index if not exists mcp_pending_actions_open_idx
  on public.mcp_pending_actions(user_id, expires_at)
  where decision is null;
