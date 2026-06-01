import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AgentDefinition } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const systemPrompt = readFileSync(join(__dirname, 'system-prompt.md'), 'utf-8');

export const salesAgent: AgentDefinition = {
  id: 'sales',
  name: 'Zipdev Sales',
  team: 'sales',
  defaultModel: 'gemini-2.5-flash',
  systemPrompt,
  allowedTools: [
    'hubspot.search_companies',
    'hubspot.get_company',
    'hubspot.search_deals',
    'hubspot.get_deal',
    'hubspot.list_recent_activities',
    'rate.estimate',
    'rate.estimate_from_document',
    'gmail.search',
    'gmail.read_thread',
    'gmail.draft',
    'gcal.list_events',
    'gcal.create_event',
    'gsheets.read_range',
    'gsheets.append_row',
    'kb.search',
    'kb.list_collections',
    'sales.draft_proposal',
  ],
  kbScopes: ['global', 'team:sales', 'user', 'conversation'],
  greeting: '¡Hola! Soy tu Sales co-pilot. ¿En qué cliente trabajamos hoy?',
};
