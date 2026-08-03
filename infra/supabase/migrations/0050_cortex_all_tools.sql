-- Cortex holds every tool family, including the ones not written yet.
--
-- WHY THIS EXISTS. `allowed_tool_ids` was a hand-maintained list of family
-- patterns, and every new integration was therefore invisible until somebody
-- remembered to append it. That is not a hypothetical failure: the Apollo
-- tools were built, tested and deployed, and did nothing for a day because
-- 'apollo.*' was missing from this column. `chat.*`, `inbox.*` and `bamboo.*`
-- were missing for the same reason.
--
-- `matchPattern` in packages/agent-tools/src/registry.ts understands a bare
-- '*' as "every family except the test fixtures", so this row stops needing
-- maintenance at all.
--
-- WHAT THIS DOES NOT DO. It does not widen what Cortex may *execute*. This
-- column decides which tools exist for the agent; three things still run
-- downstream of it and are untouched here:
--
--   - team_tool_permissions (migration 0038) subtracts per team,
--   - the security classifier gates or blocks by risk, sensitivity and blast
--     radius, and requires a human for anything it flags,
--   - requiresConfirmation still stops a write before it happens.
--
-- Applied by hand to production; kept here so a rebuilt environment matches.
-- Scoped to cortex on purpose: the archived sales and recruiting agents keep
-- their narrow lists, which is the record of what they were allowed to reach.

update public.agents
set allowed_tool_ids = array['*']
where slug = 'cortex';
