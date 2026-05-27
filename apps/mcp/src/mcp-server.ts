import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { listToolsForAuth, callTool, type BridgeContext } from './bridge';
import { PROMPTS, getPromptDefinition } from './prompts';
import { RESOURCES, readResource } from './resources';

export function buildMcpServer(ctx: BridgeContext): Server {
  const server = new Server(
    { name: 'zipdev-agent', version: '0.1.0' },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  // list_tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = await listToolsForAuth(ctx);
    return {
      tools: tools.map((t) => ({
        name: t.id.replaceAll('.', '_'), // MCP-safe name (Claude expects no dots)
        description: t.description,
        inputSchema: zodToJsonSchema(t.inputSchema, {
          name: 'schema',
          $refStrategy: 'none',
        }) as { type: 'object'; properties?: Record<string, unknown> },
      })),
    };
  });

  // call_tool
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const result = await callTool(
      ctx,
      req.params.name,
      req.params.arguments ?? {},
    );
    if (result.ok) {
      return {
        content: [{ type: 'text', text: JSON.stringify(result.result, null, 2) }],
      };
    }
    if ('confirmationRequired' in result) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              { __confirmation_required: true, ...result.confirmationRequired },
              null,
              2,
            ),
          },
        ],
        isError: true,
      };
    }
    return {
      content: [{ type: 'text', text: result.error }],
      isError: true,
    };
  });

  // list_prompts
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return { prompts: PROMPTS };
  });

  // get_prompt
  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    const def = getPromptDefinition(req.params.name, req.params.arguments ?? {});
    if (!def) throw new Error(`Unknown prompt: ${req.params.name}`);
    return def;
  });

  // list_resources
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return { resources: RESOURCES };
  });

  // read_resource
  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    return readResource(ctx, req.params.uri);
  });

  return server;
}
