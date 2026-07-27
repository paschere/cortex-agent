import type { AgentDefinition } from "../types.js";
import { systemPrompt } from "./system-prompt.js";

export { systemPrompt };

export const recruitingAgent: AgentDefinition = {
  id: "recruiting",
  name: "Zipdev Recruiting",
  team: "recruiting",
  defaultModel: "gemini-3.1-flash-lite",
  systemPrompt,
  allowedTools: [
    "recruit.list_requisitions",
    "recruit.get_requisition",
    "recruit.list_candidates",
    "recruit.get_candidate",
    "recruit.find_matches",
    "recruit.score_candidate",
    "recruit.compare_candidates",
    "recruit.generate_presentation",
    "recruit.get_presentation",
    "recruit.job_insights",
    "recruit.pipeline_kanban",
    "recruit.recruiter_analytics",
    "recruit.dashboard_stats",
    "web.search",
    "web.scrape",
    "gmail.search",
    "gmail.draft",
    "gmail.send_draft",
    "gcal.list_events",
    "gcal.create_event",
    "kb.search",
    "slack.post_message",
  ],
  kbScopes: ["global", "team:recruiting", "user", "conversation"],
  greeting:
    "¡Hola! Soy tu co-pilot de Recruiting. ¿Qué requisición trabajamos hoy? Puedo buscar y rankear candidatos, armar shortlists y presentaciones para el cliente.",
};
