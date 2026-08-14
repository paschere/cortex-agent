'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { clsx } from 'clsx';
import { Archive, ArchiveRestore, Copy, Loader2, MoreHorizontal, Pencil } from 'lucide-react';

/** ⋯ menu on a gallery card: edit, duplicate, archive / unarchive. */
export function PipelineCardMenu({
  slug,
  archived = false,
}: {
  slug: string;
  archived?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function call(url: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) {
    setBusy(true);
    try {
      const res = await fetch(url, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: unknown };
        window.alert(typeof data.error === 'string' ? data.error : 'No se pudo hacer ese cambio.');
        return null;
      }
      return (await res.json()) as { slug: string };
    } catch {
      window.alert('No hubo conexión. Vuelve a intentarlo.');
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function duplicate() {
    const out = await call(`/api/pipelines/${slug}/duplicate`, 'POST');
    if (out) {
      router.push(`/pipelines/${out.slug}/edit`);
      router.refresh();
    }
  }

  async function setArchived(next: boolean) {
    if (next && !window.confirm('¿Archivar este flujo? Se guarda el historial de ejecuciones.'))
      return;
    const out = next
      ? await call(`/api/pipelines/${slug}`, 'DELETE')
      : await call(`/api/pipelines/${slug}`, 'PATCH', { archived: false });
    if (out) router.refresh();
  }

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label="Acciones del flujo"
          disabled={busy}
          className="grid h-7 w-7 place-items-center rounded-card border border-border bg-surface text-ink-faint transition-colors hover:text-ink data-[state=open]:text-ink"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <MoreHorizontal className="h-4 w-4" />
          )}
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="z-50 min-w-[170px] overflow-hidden rounded-card border border-border bg-surface p-1 shadow-pop"
        >
          <Item onSelect={() => router.push(`/pipelines/${slug}/edit`)}>
            <Pencil className="h-3.5 w-3.5" /> Editar
          </Item>
          <Item onSelect={duplicate}>
            <Copy className="h-3.5 w-3.5" /> Duplicar
          </Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          {archived ? (
            <Item onSelect={() => setArchived(false)}>
              <ArchiveRestore className="h-3.5 w-3.5" /> Desarchivar
            </Item>
          ) : (
            <Item tone="rose" onSelect={() => setArchived(true)}>
              <Archive className="h-3.5 w-3.5" /> Archivar
            </Item>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Item({
  children,
  onSelect,
  tone = 'default',
}: {
  children: React.ReactNode;
  onSelect: () => void;
  tone?: 'default' | 'rose';
}) {
  return (
    <DropdownMenu.Item
      onSelect={(e) => {
        e.preventDefault();
        onSelect();
      }}
      className={clsx(
        'flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-xs font-semibold outline-none transition-colors',
        tone === 'rose'
          ? 'text-rose data-[highlighted]:bg-rose-soft'
          : 'text-ink-muted data-[highlighted]:bg-primary-soft data-[highlighted]:text-primary-ink',
      )}
    >
      {children}
    </DropdownMenu.Item>
  );
}
