import { z } from 'zod';
import { ForbiddenError, ValidationError } from '@zipdev/core';
import { registerTool } from '../index';
import type { ToolContext } from '../types';
import { ingestMarkdown } from './ingest';

const Scope = z.enum(['global', 'team', 'user', 'conversation']);

/**
 * Find an existing collection for (scope, scopeId) or create one. `scopeId` is
 * null only for the global scope (per the kb_collections check constraint).
 */
async function resolveCollection(
  db: ToolContext['db'],
  scope: z.infer<typeof Scope>,
  scopeId: string | null,
  name: string,
): Promise<string> {
  let q = db.from('kb_collections').select('id').eq('scope', scope);
  q = scopeId === null ? q.is('scope_id', null) : q.eq('scope_id', scopeId);
  const { data: existing, error: findErr } = await q.maybeSingle();
  if (findErr) throw findErr;
  if (existing) return existing.id as string;

  const { data: created, error: insErr } = await db
    .from('kb_collections')
    .insert({ scope, scope_id: scopeId, name })
    .select('id')
    .single();
  if (insErr || !created) throw new Error(`Failed to create collection: ${insErr?.message}`);
  return created.id as string;
}

async function callerIsOrgAdmin(db: ToolContext['db'], userId: string): Promise<boolean> {
  const { data } = await db.from('users').select('role').eq('id', userId).maybeSingle();
  return data?.role === 'org_admin';
}

export const kbCreateDocument = registerTool({
  id: 'kb.create_document',
  description:
    'Persist agent-authored Markdown into the internal knowledge base so it becomes searchable via kb.search. Writes to the collection for the given scope (defaults to the current user). Global and team scopes require admin authority.',
  inputSchema: z.object({
    title: z.string().min(1),
    markdown: z.string().min(1),
    scope: Scope.default('user'),
    teamId: z.string().uuid().optional(),
  }),
  outputSchema: z.object({
    documentId: z.string(),
    chunks: z.number().int(),
    collectionId: z.string(),
  }),
  rateLimit: { perMinute: 6 },
  handler: async (input, ctx) => {
    let collectionId: string;

    if (input.scope === 'user') {
      collectionId = await resolveCollection(ctx.db, 'user', ctx.userId, 'My Documents');
    } else if (input.scope === 'conversation') {
      if (!ctx.conversationId) {
        throw new ValidationError('conversation scope requires an active conversation');
      }
      collectionId = await resolveCollection(
        ctx.db,
        'conversation',
        ctx.conversationId,
        'Conversation Documents',
      );
    } else if (input.scope === 'team') {
      if (!input.teamId) throw new ValidationError('team scope requires teamId');
      // user must be team_admin on that team (or org_admin) — mirror the
      // authority logic in apps/web/app/api/kb/documents/route.ts
      const { data: membership } = await ctx.db
        .from('team_members')
        .select('role')
        .eq('team_id', input.teamId)
        .eq('user_id', ctx.userId)
        .maybeSingle();
      const isOrgAdmin = await callerIsOrgAdmin(ctx.db, ctx.userId);
      if (membership?.role !== 'team_admin' && !isOrgAdmin) {
        throw new ForbiddenError('Must be a team admin to write to this team');
      }
      collectionId = await resolveCollection(ctx.db, 'team', input.teamId, 'Team Documents');
    } else {
      // global
      if (!(await callerIsOrgAdmin(ctx.db, ctx.userId))) {
        throw new ForbiddenError('Must be an org admin to write to the global KB');
      }
      collectionId = await resolveCollection(ctx.db, 'global', null, 'Global Documents');
    }

    const { documentId, chunks } = await ingestMarkdown(ctx.db, {
      collectionId,
      title: input.title,
      content: input.markdown,
      uploadedBy: ctx.userId,
    });

    return { documentId, chunks, collectionId };
  },
});
