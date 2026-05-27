import { Hono } from 'hono';
import { bearerAuth } from './auth';
import { listToolsForAuth } from './bridge';

export interface Env {
  NEXT_PUBLIC_SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  TOKEN_ENCRYPTION_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  HUBSPOT_CLIENT_ID: string;
  HUBSPOT_CLIENT_SECRET: string;
  GOOGLE_GENERATIVE_AI_API_KEY: string;
  RATE_ESTIMATOR_URL: string;
  RATE_ESTIMATOR_SERVICE_TOKEN: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get('/', (c) => c.text('zipdev-mcp ok'));
app.get('/health', (c) => c.json({ ok: true }));

// All other routes require bearer auth
app.use('/mcp/*', bearerAuth());
app.use('/sse', bearerAuth());

app.get('/mcp/whoami', (c) => {
  const mcp = c.get('mcp');
  return c.json({ userId: mcp.userId, agentId: mcp.agentId });
});

app.get('/mcp/tools', async (c) => {
  const mcp = c.get('mcp');
  const tools = await listToolsForAuth({ env: c.env, userId: mcp.userId, agentId: mcp.agentId });
  return c.json({ tools: tools.map((t) => ({ id: t.id, description: t.description })) });
});

export default app;
