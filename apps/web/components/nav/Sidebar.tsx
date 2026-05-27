import Link from 'next/link';
import type { Role } from '@zipdev/core';

export function Sidebar({ role }: { role: Role }) {
  return (
    <aside className="border-r p-4 space-y-1 text-sm">
      <div className="text-xs uppercase tracking-wider text-neutral-500 mt-3 mb-1">Workspace</div>
      <Link href="/" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Dashboard</Link>
      <Link href="/chat" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Chat</Link>
      <Link href="/conversations" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Conversations</Link>
      <div className="text-xs uppercase tracking-wider text-neutral-500 mt-3 mb-1">Knowledge</div>
      <Link href="/kb/me" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">My KB</Link>
      <Link href="/kb" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Team / Global KB</Link>
      <div className="text-xs uppercase tracking-wider text-neutral-500 mt-3 mb-1">Setup</div>
      <Link href="/integrations" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Integrations</Link>
      <Link href="/mcp-tokens" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">MCP tokens</Link>
      <Link href="/agents" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Agents</Link>
      {role === 'org_admin' && (
        <>
          <div className="text-xs uppercase tracking-wider text-neutral-500 mt-3 mb-1">Admin</div>
          <Link href="/admin/users" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Users</Link>
          <Link href="/admin/teams" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Teams</Link>
          <Link href="/admin/audit" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Audit log</Link>
          <Link href="/admin/usage" className="block rounded px-2 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Usage</Link>
        </>
      )}
    </aside>
  );
}
