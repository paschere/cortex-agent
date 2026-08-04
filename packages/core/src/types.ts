export type UUID = string;

export type Role = "member" | "team_admin" | "org_admin";
export type CollectionScope = "global" | "team" | "user" | "conversation";
export type Surface = "web" | "desktop" | "mcp";
export type IntegrationProvider = "google" | "hubspot" | "github" | "linear";
export type DocumentStatus = "pending" | "ingesting" | "ready" | "failed";

export interface User {
  id: UUID;
  email: string;
  name: string | null;
  role: Role;
  google_sub: string | null;
  created_at: string;
}

export interface Team {
  id: UUID;
  name: string;
}

/**
 * Models an agent can answer with. Generation runs on Claude; embeddings run on
 * Voyage (Anthropic has no embedding endpoint) — see
 * packages/agent-tools/src/kb/embedder.ts.
 */
export type ModelId = "claude-opus-5" | "claude-sonnet-5";

export interface AgentDefinition {
  id: string;
  name: string;
  team: string;
  defaultModel: ModelId;
  systemPrompt: string;
  allowedTools: string[];
  greeting: string;
}

/**
 * A Brain Knowledge space. `scope` is the visibility: 'global' (everyone) or
 * 'user' (one person, named by scope_id). The 'team' and 'conversation' values
 * of CollectionScope are retired — migration 0049 converted the last rows and
 * added a check constraint refusing new ones.
 */
export interface KbCollection {
  id: UUID;
  scope: CollectionScope;
  scope_id: UUID | null;
  name: string;
  agent_id: UUID | null;
  gdrive_folder_id: string | null;
  created_at: string;
}

export interface KbChunkHit {
  documentId: UUID;
  documentTitle: string;
  chunkIndex: number;
  content: string;
  score: number;
}
