import { alegraAuthorization } from './alegra-client';
import {
  type ProviderBalance,
  type ProviderPnl,
  type ProviderReports,
  type ReportLine,
  parseAmount,
  round2,
} from './reports';

/**
 * LOS ESTADOS FINANCIEROS DE ALEGRA (0191).
 *
 * La API REST de Alegra (api.alegra.com/api/v1) no tiene balance general ni
 * estado de resultados. Alegra los publica como herramientas de su servidor
 * MCP (developer.alegra.com › MCP Alegra › Reports):
 *
 *   reports__getGeneralBalance  { date }        → árboles de activos, pasivos,
 *                                                  patrimonio y totales por fecha.
 *   reports__getProfitAndLoss   { from, to }    → árbol de cuentas (income, cost,
 *                                                  productionCost, expense…).
 *
 * Se llaman con JSON-RPC 2.0 (`tools/call`) en POST https://mcp.alegra.com/mcp
 * con la MISMA llave Basic (correo:token) de la conexión y la cabecera
 * `mcp-groups: reports`. Es una LECTURA: no escribe nada en Alegra.
 *
 * Las formas de respuesta se leen a la defensiva: un saldo puede venir como
 * texto («50000.00») o como objeto por período; un nodo sin hijos es una
 * hoja. Lo que no se reconoce no se adivina: queda fuera y se dice.
 */

export const ALEGRA_MCP_URL = 'https://mcp.alegra.com/mcp';

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw) : null;

/** El cuerpo de una respuesta JSON-RPC, venga como JSON o como eventos SSE. */
export function parseMcpBody(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return JSON.parse(trimmed);
  const datas = trimmed
    .split(/\r?\n/)
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter(Boolean);
  for (let i = datas.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(datas[i] as string) as Raw;
      if (parsed && ('result' in parsed || 'error' in parsed)) return parsed;
    } catch {
      // una línea que no es JSON: la siguiente
    }
  }
  throw new Error('Alegra devolvió una respuesta que no se pudo leer.');
}

/** El resultado de una herramienta MCP: `structuredContent` o el JSON del primer texto. */
export function mcpToolResult(body: unknown): unknown {
  const b = obj(body);
  if (!b) throw new Error('Alegra devolvió una respuesta vacía.');
  const error = obj(b.error);
  if (error)
    throw new Error(
      `Alegra no entregó el reporte: ${String(error.message ?? 'error').slice(0, 200)}`,
    );
  const result = obj(b.result);
  if (!result) throw new Error('Alegra devolvió una respuesta sin resultado.');
  if (result.isError === true) {
    const msg = Array.isArray(result.content)
      ? (result.content as Raw[]).map((c) => String(c.text ?? '')).join(' ')
      : '';
    throw new Error(`Alegra no entregó el reporte${msg ? `: ${msg.slice(0, 200)}` : '.'}`);
  }
  if (result.structuredContent !== undefined) return result.structuredContent;
  const content = Array.isArray(result.content) ? (result.content as Raw[]) : [];
  for (const c of content) {
    if (typeof c.text !== 'string') continue;
    try {
      return JSON.parse(c.text);
    } catch {
      // texto libre: se sigue buscando
    }
  }
  throw new Error('Alegra devolvió el reporte en un formato que no reconozco.');
}

interface AlegraNode {
  code: string | null;
  name: string;
  balance: number;
  children: AlegraNode[];
  type: string | null;
}

/** El saldo de un nodo: texto/número, o el primero (o el de `key`) de un objeto por período. */
function balanceOf(raw: unknown, key?: string): number {
  const direct = parseAmount(raw);
  if (direct !== null && typeof raw !== 'object') return direct;
  const o = obj(raw);
  if (o) {
    if (key && key in o) return parseAmount(o[key]) ?? 0;
    for (const v of Object.values(o)) {
      const n = parseAmount(v);
      if (n !== null) return n;
    }
  }
  return 0;
}

function toNode(raw: unknown, key?: string): AlegraNode | null {
  const o = obj(raw);
  if (!o) return null;
  const name = String(o.name ?? o.text ?? '').trim();
  if (!name) return null;
  const children = Array.isArray(o.children)
    ? (o.children as unknown[])
        .map((c) => toNode(c, key))
        .filter((c): c is AlegraNode => c !== null)
    : [];
  return {
    code: o.code !== undefined && o.code !== null ? String(o.code) : null,
    name,
    balance: balanceOf(o.balance ?? o.total ?? o.value, key),
    children,
    type: typeof o.type === 'string' ? o.type : null,
  };
}

/** Los nodos de una sección del balance: `{ "2024-01-31": [...] }` o un arreglo. */
function sectionNodes(raw: unknown, date: string): AlegraNode[] {
  const list = Array.isArray(raw)
    ? raw
    : (() => {
        const o = obj(raw);
        if (!o) return [];
        const exact = o[date];
        if (Array.isArray(exact)) return exact;
        const first = Object.values(o).find(Array.isArray);
        return (first as unknown[] | undefined) ?? [];
      })();
  return list.map((n) => toNode(n, date)).filter((n): n is AlegraNode => n !== null);
}

const isNonCurrent = (name: string) => /no\s+corriente|largo\s+plazo/i.test(name);
const isCurrent = (name: string) => !isNonCurrent(name) && /corriente|corto\s+plazo/i.test(name);

/**
 * Corriente o no corriente: lo dice el nombre del nodo o de un ancestro
 * («Activo corriente»), o el grupo del PUC del código (11–14 activo, 21–26
 * pasivo). Si nada lo dice, `null`.
 */
function currentness(
  node: AlegraNode,
  inherited: boolean | null,
  kind: 'asset' | 'liability',
): boolean | null {
  if (isNonCurrent(node.name)) return false;
  if (isCurrent(node.name)) return true;
  if (inherited !== null) return inherited;
  const code = (node.code ?? '').replace(/\D/g, '');
  if (code.length >= 2) {
    const g = code.slice(0, 2);
    if (kind === 'asset')
      return ['11', '12', '13', '14'].includes(g) ? true : g.startsWith('1') ? false : null;
    return ['21', '22', '23', '24', '25', '26'].includes(g)
      ? true
      : g.startsWith('2')
        ? false
        : null;
  }
  return null;
}

/** Suma las hojas por corriente / no corriente / sin saber. */
function splitLeaves(nodes: AlegraNode[], kind: 'asset' | 'liability') {
  let current = 0;
  let nonCurrent = 0;
  let unknown = 0;
  const walk = (n: AlegraNode, inherited: boolean | null) => {
    const c = currentness(n, inherited, kind);
    if (!n.children.length) {
      if (c === true) current += n.balance;
      else if (c === false) nonCurrent += n.balance;
      else unknown += n.balance;
      return;
    }
    for (const child of n.children) walk(child, c);
  };
  for (const n of nodes) walk(n, null);
  return { current, nonCurrent, unknown };
}

const total = (nodes: AlegraNode[]) => nodes.reduce((s, n) => s + n.balance, 0);

export function alegraBalanceFrom(raw: unknown, asOf: string, currency: string): ProviderBalance {
  const o = obj(raw) ?? {};
  const assets = sectionNodes(o.assets, asOf);
  const liabilities = sectionNodes(o.liabilities, asOf);
  const equity = sectionNodes(o.equity, asOf);
  const totals = obj(obj(o.totals)?.[asOf]) ?? obj(Object.values(obj(o.totals) ?? {})[0]) ?? null;
  const totalAssets = parseAmount(totals?.assets) ?? total(assets);
  const totalLiabilities = parseAmount(totals?.liabilities) ?? total(liabilities);
  const totalEquity = parseAmount(totals?.equity) ?? total(equity);
  const a = splitLeaves(assets, 'asset');
  const l = splitLeaves(liabilities, 'liability');
  const notes: string[] = ['Fuente: Estado de Situación Financiera de Alegra.'];
  const known = (s: { current: number; unknown: number; nonCurrent: number }) =>
    Math.abs(s.unknown) < 0.5;
  if (!known(a) || !known(l))
    notes.push(
      'Alegra no separó todo el activo o el pasivo en corriente y no corriente: la razón corriente no se calcula con ese dato.',
    );
  const lines: ReportLine[] = [];
  const push = (section: string, nodes: AlegraNode[]) => {
    for (const n of nodes)
      lines.push({ section, code: n.code, name: n.name, amount: round2(n.balance) });
  };
  push('activo', assets);
  push('pasivo', liabilities);
  push('patrimonio', equity);
  return {
    provider: 'alegra',
    asOf,
    currency,
    totalAssets: round2(totalAssets),
    currentAssets: known(a) ? round2(a.current) : null,
    nonCurrentAssets: known(a) ? round2(a.nonCurrent) : null,
    totalLiabilities: round2(totalLiabilities),
    currentLiabilities: known(l) ? round2(l.current) : null,
    nonCurrentLiabilities: known(l) ? round2(l.nonCurrent) : null,
    equity: round2(totalEquity),
    lines,
    notes,
  };
}

/** De qué tipo es un nodo del estado de resultados de Alegra. */
function pnlKind(n: AlegraNode, inherited: string | null): string | null {
  const t = (n.type ?? '').toLowerCase();
  if (t) return t;
  const name = n.name.toLowerCase();
  if (/no operacional/.test(name) && /ingreso/.test(name)) return 'otherincome';
  if (/no operacional/.test(name) && /gasto/.test(name)) return 'otherexpense';
  if (/costo/.test(name)) return 'cost';
  if (/ingreso/.test(name)) return 'income';
  if (/gasto/.test(name)) return 'expense';
  return inherited;
}

export function alegraPnlFrom(
  raw: unknown,
  from: string,
  to: string,
  currency: string,
): ProviderPnl {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(obj(raw)?.data)
      ? (obj(raw)?.data as unknown[])
      : Array.isArray(obj(raw)?.rows)
        ? (obj(raw)?.rows as unknown[])
        : [];
  const nodes = list.map((n) => toNode(n)).filter((n): n is AlegraNode => n !== null);
  const sums: Record<string, number> = {};
  const lines: ReportLine[] = [];
  for (const n of nodes) {
    const kind = pnlKind(n, null) ?? 'other';
    // El total del nodo de arriba ya trae a sus hijos: no se baja más.
    sums[kind] = (sums[kind] ?? 0) + Math.abs(n.balance);
    lines.push({ section: kind, code: n.code, name: n.name, amount: round2(Math.abs(n.balance)) });
  }
  const pick = (...keys: string[]) => keys.reduce((s, k) => s + (sums[k] ?? 0), 0);
  const revenue = pick('income');
  const cost = pick('cost', 'productioncost');
  const opex = pick('expense');
  const otherIncome = pick('otherincome', 'nonoperatingincome');
  const otherExpenses = pick('otherexpense', 'nonoperatingexpense', 'other');
  return {
    provider: 'alegra',
    from,
    to,
    currency,
    revenue: round2(revenue),
    costOfSales: round2(cost),
    operatingExpenses: round2(opex),
    otherIncome: round2(otherIncome),
    otherExpenses: round2(otherExpenses),
    incomeTax: null,
    netIncome: round2(revenue + otherIncome - cost - opex - otherExpenses),
    lines,
    notes: ['Fuente: Estado de Resultados de Alegra.'],
  };
}

export function alegraReports(credentials: {
  email: string;
  token: string;
  fetch?: typeof fetch;
  currency?: () => Promise<string>;
}): ProviderReports {
  const doFetch = credentials.fetch ?? fetch;
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    id += 1;
    let res: Response;
    try {
      res = await doFetch(ALEGRA_MCP_URL, {
        method: 'POST',
        headers: {
          Authorization: alegraAuthorization(credentials.email, credentials.token),
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'mcp-groups': 'reports',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
        signal: AbortSignal.timeout(90_000),
      });
    } catch {
      throw new Error(
        'No se pudo conectar con Alegra para leer los reportes. Inténtalo en unos minutos.',
      );
    }
    const text = await res.text();
    if (res.status === 401 || res.status === 403)
      throw new Error(
        'Alegra no aceptó la llave para leer los reportes. Revisa la conexión en Integraciones.',
      );
    if (!res.ok) throw new Error(`Alegra no entregó el reporte (${res.status}).`);
    return mcpToolResult(parseMcpBody(text));
  };
  const currency = async () => (credentials.currency ? credentials.currency() : 'COP');
  return {
    async balanceSheet(asOf) {
      const raw = await call('reports__getGeneralBalance', {
        date: asOf,
        periodsCount: 0,
        includeComparativeAnalysis: false,
        analysisType: 'none',
        filterZeroBalance: true,
      });
      return alegraBalanceFrom(raw, asOf, await currency());
    },
    async profitAndLoss(from, to) {
      const raw = await call('reports__getProfitAndLoss', {
        from,
        to,
        optionalParams: {
          includeComparativeAnalysis: false,
          includeHorizontalAnalysis: false,
          includeVerticalAnalysis: false,
          includeZeroBalanceAccounts: false,
        },
      });
      return alegraPnlFrom(raw, from, to, await currency());
    },
  };
}
