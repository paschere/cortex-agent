import { PageHeader } from '@/components/ui/page-header';
import { requireSession } from '@/lib/session';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import Link from 'next/link';
import { WhatsappConsole } from './_components/WhatsappConsole';

/**
 * WhatsApp, as a connection.
 *
 * IT USED TO LIVE UNDER /kb, and the reasoning was sound at the time: the only
 * thing it did was feed Brain Knowledge, next to uploads, recordings, Meet and
 * Drive. Then it grew the other half — a person can hold a conversation with
 * Cortex from their phone — and the screen stopped being about documents. What
 * somebody comes here to do is "conectar WhatsApp", which is the same sentence
 * they would say about Google Drive, Gmail and Google Chat, and those all live
 * in Integrations.
 *
 * So the whole configuration is here: pairing, whose numbers may talk to Cortex,
 * and which groups are read. Brain Knowledge keeps a READ-ONLY view of which
 * groups feed which spaces and links back here — the memory decision is worth
 * seeing from the memory page, but a second copy of the same switches in two
 * places is how "¿dónde configuro WhatsApp?" stops having an answer.
 *
 * The old address redirects (see `next.config.mjs`): the link was shareable and
 * somebody has it.
 */

export const dynamic = 'force-dynamic';

export default async function WhatsappPage() {
  const user = await requireSession();

  return (
    <>
      <Link
        href="/integrations"
        className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-faint transition-colors duration-150 hover:text-primary motion-reduce:transition-none"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Integraciones
      </Link>
      <PageHeader
        title="WhatsApp"
        subtitle="Conecta el número de la empresa, decide de quién es cada teléfono que le escribe y qué grupos entran a Brain Knowledge."
        icon={<MessageCircle className="h-5 w-5" />}
      />
      <WhatsappConsole isAdmin={user.role === 'org_admin'} />
    </>
  );
}
