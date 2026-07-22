-- Add the GitHub and Linear native integration providers to the enum used by
-- public.integrations.provider. Enum-only: ADD VALUE cannot run in the same
-- transaction that also uses the new value, so this file does not reference
-- 'github'/'linear' anywhere else.
alter type integration_provider add value if not exists 'github';
alter type integration_provider add value if not exists 'linear';
