import type { ReactNode } from 'react';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-8">
      {/* One column, never wider than a filled-in form is comfortable to read. */}
      <main className="w-full max-w-[25rem]">{children}</main>
    </div>
  );
}
