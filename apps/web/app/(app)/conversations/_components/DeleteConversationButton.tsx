'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Trash2, Loader2 } from 'lucide-react';

export function DeleteConversationButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function onDelete() {
    if (!confirm('¿Eliminar esta conversación? No se puede deshacer.')) return;
    setBusy(true);
    const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
    if (res.ok) {
      router.refresh();
    } else {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onDelete}
      disabled={busy}
      aria-label="Eliminar la conversación"
      title="Eliminar la conversación"
      className="rounded-full p-2 text-ink-faint transition-colors hover:bg-rose-soft hover:text-rose disabled:opacity-50"
    >
      {busy ? (
        <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" />
      ) : (
        <Trash2 className="h-4 w-4" />
      )}
    </button>
  );
}
