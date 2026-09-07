'use client';

import type { CompanyGroup } from '@/lib/company-groups';
import { Building2, FolderKanban, Loader2, Plus, X } from 'lucide-react';
import { useState } from 'react';

export function CompanyGroups({
  initialGroups,
  initialAvailable,
}: { initialGroups: CompanyGroup[]; initialAvailable: Array<{ id: string; name: string }> }) {
  const [groups, setGroups] = useState(initialGroups);
  const [available, setAvailable] = useState(initialAvailable);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const response = await fetch('/api/company-groups');
    if (!response.ok) throw new Error('No se pudieron actualizar los grupos.');
    const data = (await response.json()) as {
      groups: CompanyGroup[];
      availableCompanies: Array<{ id: string; name: string }>;
    };
    setGroups(data.groups);
    setAvailable(data.availableCompanies);
  }
  async function mutate(body: unknown, method: 'POST' | 'PATCH') {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/company-groups', {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? 'No se pudo guardar.');
      }
      await refresh();
      setName('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="overflow-hidden rounded-xl border border-[#2c2934] bg-[#19171e] text-zinc-100 shadow-[0_20px_60px_rgba(20,16,28,0.14)]">
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/10 px-5 py-5">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
            <FolderKanban className="h-4 w-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold">Grupos empresariales</h2>
            <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-500">
              Ordenan tus empresas. Un grupo no comparte datos, cerebros, conexiones ni permisos.
            </p>
          </div>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void mutate({ name }, 'POST');
          }}
          className="flex w-full gap-2 sm:w-auto"
        >
          <label htmlFor="group-name" className="sr-only">
            Nombre del grupo
          </label>
          <input
            id="group-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={120}
            placeholder="Nombre del grupo"
            className="min-h-9 min-w-0 flex-1 rounded-lg border border-white/10 bg-white/5 px-3 text-xs text-white outline-none placeholder:text-zinc-600 focus:border-primary/60 sm:w-48"
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-semibold text-white disabled:opacity-40"
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            Crear grupo
          </button>
        </form>
      </div>
      {error && (
        <p
          role="alert"
          className="mx-5 mt-4 rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200"
        >
          {error}
        </p>
      )}
      <div className={`grid gap-px bg-white/10 ${groups.length > 1 ? 'md:grid-cols-2' : ''}`}>
        {groups.map((group) => (
          <article key={group.id} className="bg-[#19171e] p-5">
            <h3 className="text-sm font-semibold">{group.name}</h3>
            <div className="mt-3 space-y-2">
              {group.companies.map((company) => (
                <div
                  key={company.id}
                  className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.025] px-3 py-2"
                >
                  <Building2 className="h-3.5 w-3.5 text-zinc-500" />
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-300">
                    {company.name}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        { groupId: group.id, organizationId: company.id, action: 'remove' },
                        'PATCH',
                      )
                    }
                    aria-label={`Quitar ${company.name} de ${group.name}`}
                    className="rounded p-1 text-zinc-600 hover:bg-white/5 hover:text-zinc-300"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
              {group.companies.length === 0 && (
                <p className="py-2 text-xs text-zinc-600">Todavía no contiene empresas.</p>
              )}
            </div>
            {available.length > 0 && (
              <select
                aria-label={`Añadir empresa a ${group.name}`}
                value=""
                disabled={busy}
                onChange={(event) =>
                  event.target.value &&
                  void mutate(
                    { groupId: group.id, organizationId: event.target.value, action: 'add' },
                    'PATCH',
                  )
                }
                className="mt-3 min-h-9 w-full rounded-lg border border-white/10 bg-[#211f27] px-2 text-xs text-zinc-400 outline-none focus:border-primary/60"
              >
                <option value="">Añadir una empresa…</option>
                {available.map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            )}
          </article>
        ))}
        {groups.length === 0 && (
          <div className="bg-[#19171e] px-5 py-7 md:col-span-2">
            <p className="text-sm text-zinc-300">Aún no organizas empresas en grupos.</p>
            <p className="mt-1 text-xs text-zinc-600">
              Crea uno cuando dirijas varias empresas que quieras ver juntas.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
