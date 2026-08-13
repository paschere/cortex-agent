import { ChatRoot } from '@/components/chat/ChatRoot';
import { requireSession } from '@/lib/session';
import { readWaitingNotice } from '@/lib/waiting';
import { listAgents } from '@cortex/agents';

/**
 * Una conversación nueva empieza con una línea que nadie pidió: si hay trabajo
 * parado en las cuatro colas, se dice aquí antes de la primera pregunta. Sale
 * de los conteos que el layout ya calcula para los badges del menú, así que
 * abrir un chat no cuesta ninguna consulta nueva de listas — ver
 * `readWaitingNotice`.
 */
export default async function NewChatPage() {
  const user = await requireSession();
  const agents = listAgents().map((a) => ({
    slug: a.id,
    name: a.name,
    greeting: a.greeting,
  }));
  const waiting = await readWaitingNotice(user.organization.id, user.id);
  return <ChatRoot agents={agents} waiting={waiting} />;
}
