import { requireSession } from '@/lib/session';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

export default async function AdminLayout({ children }: { children: ReactNode }) {
  const user = await requireSession();
  if (user.role !== 'org_admin') notFound();
  return <>{children}</>;
}
