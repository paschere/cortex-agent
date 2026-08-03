import { ChatRoot } from '@/components/chat/ChatRoot';
import { listAgents } from '@cortex/agents';

export default function NewChatPage() {
  const agents = listAgents().map((a) => ({
    slug: a.id,
    name: a.name,
    greeting: a.greeting,
  }));
  return <ChatRoot agents={agents} />;
}
