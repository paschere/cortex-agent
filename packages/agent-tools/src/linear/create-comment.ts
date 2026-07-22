import { z } from 'zod';
import { registerTool } from '../index';
import { linearFetch } from './client';

const Output = z.object({
  id: z.string(),
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});

const MUTATION = `
  mutation CreateComment($input: CommentCreateInput!) {
    commentCreate(input: $input) {
      success
      comment {
        id
        body
        createdAt
        url
      }
    }
  }
`;

export const createComment = registerTool({
  id: 'linear.create_comment',
  description:
    'Add a comment to a Linear issue. Pass the issue UUID (from linear.get_issue) as issueId; body is markdown.',
  inputSchema: z.object({
    issueId: z.string().min(1),
    body: z.string().min(1),
  }),
  outputSchema: Output,
  requiresConfirmation: true,
  requiredScopes: [{ provider: 'linear', scopes: ['write'] }],
  rateLimit: { perMinute: 20 },
  handler: async (input, ctx) => {
    type R = {
      commentCreate: {
        success: boolean;
        comment: { id: string; body: string; createdAt: string; url: string };
      };
    };
    const data = await linearFetch<R>(ctx, MUTATION, {
      input: { issueId: input.issueId, body: input.body },
    });
    const comment = data.commentCreate.comment;
    return {
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      url: comment.url,
    };
  },
});
