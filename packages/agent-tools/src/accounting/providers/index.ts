import type {
  AccountingProvider,
  AccountingProviderId,
  CredentialField,
  ProviderInfo,
} from '../types';
import { siigoProvider } from './siigo';

/**
 * LOS PROGRAMAS CONTABLES QUE CORTEX SABE LEER.
 *
 * Uno por archivo. Sumar Alegra es: escribir `alegra.ts` con la misma forma
 * que `siigo.ts` (autenticar, listar por páginas, traducir a la forma común),
 * registrarlo aquí y quitarle el «Próximamente». La tabla
 * `accounting_connections` ya lo acepta (`provider` en la 0165).
 */

export const ACCOUNTING_PROVIDERS: Partial<Record<AccountingProviderId, AccountingProvider>> = {
  siigo: siigoProvider,
};

/** Los que todavía no tienen archivo, para que la pantalla los anuncie. */
const COMING_SOON: Array<{ id: AccountingProviderId; name: string; credentialsHelp: string }> = [
  {
    id: 'alegra',
    name: 'Alegra',
    credentialsHelp: 'Con el correo de la cuenta y el token de la API de Alegra.',
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    credentialsHelp: 'Con el inicio de sesión de Intuit (OAuth).',
  },
];

export function getAccountingProvider(id: string): AccountingProvider | null {
  return ACCOUNTING_PROVIDERS[id as AccountingProviderId] ?? null;
}

function infoOf(p: AccountingProvider): ProviderInfo {
  return {
    id: p.id,
    name: p.name,
    available: true,
    credentialsHelp: p.credentialsHelp,
    credentialFields: p.credentialFields.map((f): CredentialField => ({ ...f })),
    entities: [...p.entities],
    paymentsLabel: p.paymentsLabel ?? 'Pagos recibidos',
  };
}

/** Todos los programas, conectables primero, en el orden de la pantalla. */
export function listAccountingProviders(): ProviderInfo[] {
  return [
    ...Object.values(ACCOUNTING_PROVIDERS)
      .filter((p): p is AccountingProvider => Boolean(p))
      .map(infoOf),
    ...COMING_SOON.filter((c) => !ACCOUNTING_PROVIDERS[c.id]).map(
      (c): ProviderInfo => ({
        ...c,
        available: false,
        credentialFields: [],
        entities: [],
        paymentsLabel: 'Pagos recibidos',
      }),
    ),
  ];
}

/** «Siigo», o el id si no se conoce. */
export function providerName(id: string): string {
  return getAccountingProvider(id)?.name ?? COMING_SOON.find((c) => c.id === id)?.name ?? id;
}
