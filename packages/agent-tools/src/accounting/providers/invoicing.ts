/**
 * EMITIR FACTURAS EN SIIGO Y ALEGRA (migración 0182): la mitad de cada
 * programa que ESCRIBE. Lo que se manda lo arma `sales/einvoice.ts` (puro) y
 * lo decide una persona; aquí sólo se habla con el programa:
 *
 *   - el catálogo que hace falta para armar la factura (tipos de documento,
 *     vendedores, formas de pago, impuestos), ya traducido a una forma común;
 *   - buscar el cliente por NIT antes de mandar nada, para decir «ese cliente
 *     no está en Siigo» en vez de esperar a que Siigo lo rechace;
 *   - el POST, que nunca reintenta solo lo que pudo haber llegado.
 *
 * Siigo (siigoapi.docs.apiary.io): `GET /v1/document-types?type=FV`,
 * `GET /v1/users`, `GET /v1/payment-types?document_type=FV`, `GET /v1/taxes`,
 * `GET /v1/customers?identification=`, `POST /v1/invoices` con la cabecera
 * `Idempotency-Key`. Alegra (developer.alegra.com): `GET /number-templates`,
 * `GET /sellers`, `GET /taxes`, `GET /contacts?identification=`,
 * `POST /invoices`.
 *
 * Las listas se leen con tolerancia: unas versiones devuelven un arreglo y
 * otras `{ results: [...] }`, y un filtro que el programa ignore se vuelve a
 * aplicar aquí (nunca se toma «el primero que vino» como el cliente buscado).
 */

import type { CreatedProviderInvoice, InvoicingCatalog, ProviderInvoicing } from '../types';
import type { AlegraClient } from './alegra-client';
import type { SiigoClient } from './siigo-client';

type Loose = Record<string, unknown>;

function list(body: unknown): Loose[] {
  if (Array.isArray(body)) return body as Loose[];
  const b = body as { results?: unknown; data?: unknown } | null;
  if (Array.isArray(b?.results)) return b.results as Loose[];
  if (Array.isArray(b?.data)) return b.data as Loose[];
  return [];
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());
const digits = (v: unknown): string => str(v).replace(/\D/g, '');
const active = (r: Loose) => r.active !== false && r.status !== 'inactive';

function taxKind(type: string): InvoicingCatalog['taxes'][number]['kind'] {
  const t = type.toLowerCase();
  if (t === 'iva') return 'iva';
  if (t === 'retefuente' || t.includes('fuente')) return 'retefuente';
  if (t === 'reteica' || t.includes('ica')) return 'reteica';
  if (t === 'reteiva') return 'reteiva';
  return 'other';
}

/** El NIT de un cliente tal como lo guarda el programa, comparado sin DV. */
export function sameTaxId(stored: unknown, wanted: string): boolean {
  const a = digits(stored);
  const b = digits(wanted);
  if (!a || !b) return false;
  // «900123456-7» guardado junto, o con el DV aparte: se acepta con o sin él.
  return a === b || (a.length === b.length + 1 && a.startsWith(b));
}

export function siigoEinvoiceStatus(status: unknown): string | null {
  const s = str(status).toLowerCase();
  if (!s) return null;
  if (s === 'accepted') return 'Aceptada';
  if (s === 'rejected') return 'Rechazada';
  if (s === 'draft' || s === 'notsent' || s === 'unsent') return 'Sin enviar';
  return 'Pendiente';
}

export function alegraEinvoiceStatus(status: unknown): string | null {
  const s = str(status).toUpperCase();
  if (!s) return null;
  if (s.includes('REJECTED')) return 'Rechazada';
  if (s.includes('ACCEPTED')) return 'Aceptada';
  return 'Pendiente';
}

export function siigoInvoicing(client: SiigoClient): ProviderInvoicing {
  return {
    async catalog() {
      const [docs, users, payments, taxes] = await Promise.all([
        client.get<unknown>('/v1/document-types', { type: 'FV' }),
        client.get<unknown>('/v1/users', { page: 1, page_size: 100 }),
        client.get<unknown>('/v1/payment-types', { document_type: 'FV' }),
        client.get<unknown>('/v1/taxes'),
      ]);
      return {
        documentTypes: list(docs)
          .filter(active)
          .map((d) => ({
            id: str(d.id),
            name: str(d.name) || str(d.code) || `Documento ${str(d.id)}`,
            electronic:
              /electr/i.test(str(d.electronic_type)) && !/^no/i.test(str(d.electronic_type)),
            discountType: /value|valor/i.test(str(d.discount_type))
              ? ('value' as const)
              : ('percentage' as const),
          })),
        sellers: list(users)
          .filter(active)
          .map((u) => ({
            id: str(u.id),
            name:
              [str(u.first_name), str(u.last_name)].filter(Boolean).join(' ') || str(u.username),
          })),
        paymentTypes: list(payments)
          .filter(active)
          .map((p) => ({
            id: str(p.id),
            name: str(p.name),
            credit: p.due_date === true || /cr[eé]dito/i.test(str(p.name)),
          })),
        taxes: list(taxes)
          .filter(active)
          .map((t) => ({
            id: str(t.id),
            name: str(t.name),
            kind: taxKind(str(t.type)),
            percentage: Number(t.percentage) || 0,
          })),
      } satisfies InvoicingCatalog;
    },
    async findCustomer(taxId) {
      const body = await client.get<unknown>('/v1/customers', { identification: taxId });
      const hit = list(body).find((c) => sameTaxId(c.identification, taxId));
      if (!hit) return null;
      const name = Array.isArray(hit.name)
        ? (hit.name as unknown[]).map(str).join(' ')
        : str(hit.name);
      return { id: str(hit.id), name: name || null };
    },
    async createInvoice(payload, opts): Promise<CreatedProviderInvoice> {
      const out = await client.post<Loose>('/v1/invoices', payload, {
        idempotencyKey: opts.idempotencyKey,
      });
      const stamp = (out?.stamp ?? null) as Loose | null;
      return {
        id: str(out?.id),
        number: str(out?.name) || (out?.number ? str(out.number) : null),
        cufe: str(stamp?.cufe) || null,
        einvoiceStatus: siigoEinvoiceStatus(stamp?.status),
        url: str(out?.public_url) || null,
        total: Number.isFinite(Number(out?.total)) ? Number(out?.total) : null,
      };
    },
  };
}

export function alegraInvoicing(client: AlegraClient): ProviderInvoicing {
  return {
    async catalog() {
      // Vendedores y numeraciones son opcionales en Alegra: si la cuenta no
      // los tiene (o el plan no deja leerlos), la factura sale sin ellos.
      const [templates, sellers, taxes] = await Promise.all([
        client.get<unknown>('/number-templates', { documentType: 'invoice' }).catch(() => []),
        client.get<unknown>('/sellers').catch(() => []),
        client.get<unknown>('/taxes'),
      ]);
      return {
        documentTypes: list(templates)
          .filter((t) => active(t) && (!t.documentType || str(t.documentType) === 'invoice'))
          .map((t) => ({
            id: str(t.id),
            name:
              [str(t.name), str(t.prefix)].filter(Boolean).join(' · ') || `Numeración ${str(t.id)}`,
            electronic: t.isElectronic === true,
            discountType: 'percentage' as const,
          })),
        sellers: list(sellers)
          .filter(active)
          .map((s) => ({ id: str(s.id), name: str(s.name) })),
        paymentTypes: [],
        taxes: list(taxes)
          .filter(active)
          .map((t) => ({
            id: str(t.id),
            name: str(t.name),
            kind: taxKind(str(t.type)),
            percentage: Number(t.percentage) || 0,
          })),
      } satisfies InvoicingCatalog;
    },
    async findCustomer(taxId) {
      const body = await client.get<unknown>('/contacts', {
        identification: taxId,
        type: 'client',
      });
      const hit = list(body).find((c) => {
        const obj = c.identificationObject as Loose | undefined;
        return sameTaxId(c.identification, taxId) || sameTaxId(obj?.number, taxId);
      });
      return hit ? { id: str(hit.id), name: str(hit.name) || null } : null;
    },
    async createInvoice(payload): Promise<CreatedProviderInvoice> {
      const out = await client.post<Loose>('/invoices', payload);
      const template = (out?.numberTemplate ?? null) as Loose | null;
      const stamp = (out?.stamp ?? null) as Loose | null;
      return {
        id: str(out?.id),
        number: str(template?.fullNumber) || null,
        cufe: str(stamp?.cufe) || null,
        einvoiceStatus: alegraEinvoiceStatus(stamp?.legalStatus),
        url: null,
        total: Number.isFinite(Number(out?.total)) ? Number(out?.total) : null,
      };
    },
  };
}
