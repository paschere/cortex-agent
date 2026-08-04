-- "Knowledge Base" is now called "Brain Knowledge" everywhere a person can read
-- it. This migration moves the seeded agent prompts to the new name.
--
-- WHY IT MATTERS HERE. The prompts in public.agents are what the model actually
-- executes: the chat runtime and the MCP server load the row, not the static
-- definition in packages/agents. If the prompt keeps saying "the Knowledge
-- Base" while the sidebar, the page header and every tool description say
-- "Brain Knowledge", the agent and its user end up using two names for the same
-- thing in the same conversation — which reads as two different features.
--
-- WHAT IS DELIBERATELY NOT RENAMED. The internal name stays `kb`: the tool ids
-- (`kb.search`, `kb.create_document`), the tables (kb_documents, kb_chunks,
-- kb_collections), the RPCs and the /kb route are all contracts. Renaming them
-- would invalidate every `allowed_tool_ids` entry already granted, every MCP
-- token in circulation and every bookmark. Only the words a human reads change.
--
-- Idempotent throughout: every statement is an UPDATE guarded on the old text
-- still being present, so re-running converges instead of double-applying.

-- ---------------------------------------------------------------------------
-- 1. Cortex — the three phrasings it uses, each rewritten by hand
-- ---------------------------------------------------------------------------
-- Not rewritten in full the way 0056 did: 0056 had to restate the prompt
-- because the company name appeared in nearly every paragraph, and a chain of
-- replace() calls left seams. Here there are exactly three mentions, so
-- targeted replacements keep any edit an admin has made to the rest of the
-- prompt intact.
--
-- The second one changes more than the name. "The Knowledge Base is the
-- company's brain" became "Brain Knowledge is the company's brain" under a
-- literal swap — the same word twice in one sentence, saying nothing. "memory"
-- is what the sentence always meant, and it matches the wording the MCP
-- instructions already use. The replacements below mirror, verbatim, the static
-- definition in packages/agents/src/cortex/index.ts, so the row and the file
-- stay in sync.

update public.agents
set system_prompt =
  replace(
    replace(
      replace(
        system_prompt,
        '(HubSpot timeline + Knowledge Base)',
        '(HubSpot timeline + Brain Knowledge)'
      ),
      '**The Knowledge Base is the company''s brain.**',
      '**Brain Knowledge is the company''s memory.**'
    ),
    '(conversations, KB, audit)',
    '(conversations, Brain Knowledge, audit)'
  )
where slug = 'cortex';

-- ---------------------------------------------------------------------------
-- 2. Sales and Recruiting — archived agents, one mention each
-- ---------------------------------------------------------------------------
-- Both seed prompts introduce the corpus as "a knowledge base of X", an
-- indefinite article in front of what is now a proper noun. "Brain Knowledge of
-- past proposals" is not English, so each gets its own wording rather than a
-- sweep. Same text as packages/agents/src/{sales,recruiting}/system-prompt.ts.

update public.agents
set system_prompt = replace(
  system_prompt,
  'Google Sheets, and a knowledge base of past proposals and case studies',
  'Google Sheets, and Brain Knowledge — the company''s store of past proposals and case studies'
)
where slug = 'sales';

update public.agents
set system_prompt = replace(
  system_prompt,
  'a knowledge base of past placements and playbooks',
  'Brain Knowledge for past placements and playbooks'
)
where slug = 'recruiting';

-- ---------------------------------------------------------------------------
-- 3. Catch-all
-- ---------------------------------------------------------------------------
-- The seed migrations are not the only way a prompt gets written: 0010 ships a
-- sales prompt that 0016 later overwrites, 0023's Cortex prompt was superseded
-- by 0027 and then by 0056, and an admin can edit any prompt from the settings
-- page. Anything still naming the old feature after the passes above is swept.
--
-- The pairs run longest-phrase-first so the article is absorbed into the
-- replacement instead of being stranded in front of the proper noun: "search
-- the Knowledge Base" has to become "search Brain Knowledge", not "search the
-- Brain Knowledge". The `where ... ilike` guard keeps this a no-op on a
-- database that is already clean, which is what makes re-running safe.

update public.agents
set system_prompt =
  replace(
    replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(system_prompt, 'the Knowledge Base', 'Brain Knowledge'),
                'The Knowledge Base', 'Brain Knowledge'
              ),
              'the knowledge base', 'Brain Knowledge'
            ),
            'The knowledge base', 'Brain Knowledge'
          ),
          'a knowledge base', 'Brain Knowledge'
        ),
        'A knowledge base', 'Brain Knowledge'
      ),
      'Knowledge Base', 'Brain Knowledge'
    ),
    'knowledge base', 'Brain Knowledge'
  )
where system_prompt ilike '%knowledge base%';

-- Agent names are 'Cortex', 'Cortex Sales' and 'Cortex Recruiting' — nothing to
-- rename. The statement stays as the guard: if a deployment ever named an agent
-- after the feature, this catches it.
update public.agents
set name = replace(replace(name, 'Knowledge Base', 'Brain Knowledge'), 'knowledge base', 'Brain Knowledge')
where name ilike '%knowledge base%';
