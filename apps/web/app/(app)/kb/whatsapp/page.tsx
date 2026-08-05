import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { MessageCircle } from 'lucide-react';
import { WhatsappConsole } from './_components/WhatsappConsole';

/**
 * WhatsApp, as a mouth of Brain Knowledge.
 *
 * It lives under /kb rather than under /integrations because that is what it
 * is: a fifth way the brain is fed, next to uploads, recordings, Meet and
 * Drive. The direct-message half rides along on the same connection and is
 * configured on the same screen, since there is only one thing to pair.
 */

export const dynamic = 'force-dynamic';

export default async function WhatsappPage() {
  const user = await requireSession();

  return (
    <>
      <PageHeader
        title="WhatsApp"
        subtitle="Los grupos que elijas entran a Brain Knowledge con quién dijo qué y cuándo. Y puedes escribirle a Cortex por mensaje directo."
        icon={<MessageCircle className="h-5 w-5" />}
      />
      <WhatsappConsole isAdmin={user.role === 'org_admin'} />
    </>
  );
}
