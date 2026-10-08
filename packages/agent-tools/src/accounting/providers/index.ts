import type {
  AccountingProvider,
  AccountingProviderId,
  CredentialField,
  ProviderInfo,
} from '../types';
import { alegraProvider } from './alegra';
import { quickbooksProvider } from './quickbooks';
import { siigoProvider } from './siigo';

/**
 * LOS PROGRAMAS CONTABLES QUE CORTEX SABE LEER.
 *
 * Uno por archivo, con la misma forma (autenticar, listar por páginas,
 * traducir a la forma común): `siigo.ts`, `alegra.ts`, `quickbooks.ts`. Sumar
 * otro es escribir su archivo, registrarlo aquí y ampliar el `check` de
 * `provider` en `accounting_connections` (hoy: siigo, alegra, quickbooks).
 * Mientras no tenga archivo puede anunciarse en `COMING_SOON`.
 */

export const ACCOUNTING_PROVIDERS: Partial<Record<AccountingProviderId, AccountingProvider>> = {
  siigo: siigoProvider,
  alegra: alegraProvider,
  quickbooks: quickbooksProvider,
};

/** Los que todavía no tienen archivo, para que la pantalla los anuncie. Hoy, ninguno. */
const COMING_SOON: Array<{ id: AccountingProviderId; name: string; credentialsHelp: string }> = [];

export function getAccountingProvider(id: string): AccountingProvider | null {
  return ACCOUNTING_PROVIDERS[id as AccountingProviderId] ?? null;
}

function infoOf(p: AccountingProvider): ProviderInfo {
  const connect = p.connect ?? 'credentials';
  return {
    id: p.id,
    name: p.name,
    available: true,
    credentialsHelp: p.credentialsHelp,
    // En OAuth no hay formulario: los campos son lo que se guarda, no lo que se escribe.
    credentialFields:
      connect === 'oauth' ? [] : p.credentialFields.map((f): CredentialField => ({ ...f })),
    entities: [...p.entities],
    options: [...(p.options ?? [])],
    paymentsLabel: p.paymentsLabel ?? 'Pagos recibidos',
    connect,
    setupMissing: p.setupMissing?.() ?? null,
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
        options: [],
        paymentsLabel: 'Pagos recibidos',
        connect: 'credentials',
        setupMissing: null,
      }),
    ),
  ];
}

/** «Siigo», o el id si no se conoce. */
export function providerName(id: string): string {
  return getAccountingProvider(id)?.name ?? COMING_SOON.find((c) => c.id === id)?.name ?? id;
}
