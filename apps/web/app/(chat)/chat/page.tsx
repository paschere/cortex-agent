import { ChatRoot } from '@/components/chat/ChatRoot';
import { requireSession } from '@/lib/session';
import { readWaitingNotice } from '@/lib/waiting';
import { listAgents } from '@cortex/agents';

/**
 * Una conversación nueva empieza con lo que hay que hacer, no con un conteo:
 * si hay trabajo parado, la línea nombra el primer asunto y ofrece un sí.
 * Los conteos salen de `countNavSignals`; el nombre propio es una lectura más
 * — el primer elemento de la primera cola, ver `readWaitingNotice`.
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
