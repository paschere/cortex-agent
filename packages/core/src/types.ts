export type UUID = string;

export type Role = 'member' | 'team_admin' | 'org_admin';
export type CollectionScope = 'global' | 'team' | 'user' | 'conversation';
export type Surface = 'web' | 'desktop' | 'mcp';
export type IntegrationProvider = 'google' | 'hubspot' | 'github' | 'linear';
export type DocumentStatus = 'pending' | 'ingesting' | 'ready' | 'failed';

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

export interface AgentDefinition {
  id: string;
  name: string;
  team: string;
  defaultModel: 'gemini-2.5-flash' | 'gemini-2.5-pro';
  systemPrompt: string;
  allowedTools: string[];
  kbScopes: Array<'global' | `team:${string}` | 'user' | 'conversation'>;
  greeting: string;
}

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
