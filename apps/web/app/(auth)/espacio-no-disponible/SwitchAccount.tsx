'use client';

import { authClient } from '@/lib/auth-client';
import { useState } from 'react';

const PRIMARY =
  'cortex-primary-button inline-flex min-h-10 w-full items-center justify-center rounded-pill bg-primary px-5 py-2.5 text-sm font-bold text-white transition-colors hover:bg-primary-strong disabled:opacity-60';
const OUTLINE =
  'inline-flex min-h-10 w-full items-center justify-center rounded-pill border border-border-strong bg-surface px-5 py-2.5 text-sm font-bold text-ink transition-colors hover:bg-surface-2';

/** Las dos salidas: entrar con la otra cuenta (y volver al enlace) o ir a lo propio. */
export function SwitchAccount({ loginHref }: { loginHref: string }) {
  const [working, setWorking] = useState(false);
  return (
    <div className="space-y-2.5">
      <button
        type="button"
        disabled={working}
        className={PRIMARY}
        onClick={async () => {
          setWorking(true);
          try {
            await authClient.signOut();
          } finally {
            window.location.assign(loginHref);
          }
        }}
      >
        {working ? 'Un momento…' : 'Entrar con otra cuenta'}
      </button>
      {/* Recarga entera a /dashboard sin `?workspace=`: resuelve el espacio propio. */}
      <a href="/dashboard" className={OUTLINE}>
        Ir a mi espacio
      </a>
    </div>
  );
}
