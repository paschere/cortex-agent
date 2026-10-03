import { HelpCenterView } from '@/components/help/HelpCenterView';
import { requireSession } from '@/lib/session';
import { getOrgScopedClient } from '@/lib/supabase/service';
import { isSupportOperator } from '@/lib/support/operator';
import { supportChannel } from '@/lib/support/shape';
import { helpEnabledModules } from '@cortex/agent-tools';

export const dynamic = 'force-dynamic';

/**
 * EL CENTRO DE AYUDA: los artículos por categoría y un buscador.
 *
 * La búsqueda es un formulario GET (`/ayuda?q=`) y corre en el servidor con el
 * mismo índice que `help.search` usa en el chat: lo que encuentra la persona y
 * lo que le contesta Cortex salen del mismo sitio. Sin tildes en los dos lados.
 * Los artículos de un módulo que la empresa apagó no salen.
 */
export default async function HelpCenterPage({
  searchParams,
}: { searchParams: Promise<{ q?: string }> }) {
  const { q: rawQuery } = await searchParams;
  const user = await requireSession();
  const [enabled, operator] = await Promise.all([
    helpEnabledModules(getOrgScopedClient(user.organization.id)),
    isSupportOperator(user.email).catch(() => false),
  ]);
  return (
    <HelpCenterView
      query={(rawQuery ?? '').slice(0, 200).trim()}
      enabled={enabled}
      operator={operator}
      support={supportChannel(process.env.SUPPORT_CHANNEL) !== 'off'}
    />
  );
}
