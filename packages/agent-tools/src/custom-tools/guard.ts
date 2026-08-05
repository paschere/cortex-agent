/**
 * Where a custom tool is allowed to point.
 *
 * READ THIS BEFORE CHANGING ANYTHING IN HERE. A custom tool makes our server
 * issue an HTTP request to a URL a customer typed. From inside our network that
 * reaches:
 *
 *   - `http://169.254.169.254/latest/meta-data/iam/security-credentials/` —
 *     the cloud metadata endpoint. One GET and the "tool" has our instance's
 *     credentials, formatted as JSON, handed to the model, and shown in chat.
 *   - `http://10.x / 172.16-31.x / 192.168.x` — anything else in the VPC:
 *     Postgres admin UIs, internal dashboards, other tenants' services.
 *   - `http://localhost:*` — the app talking to itself, past the auth layer.
 *
 * So the check is not "does the string look internal". It is layered:
 *
 *   1. SCHEME + SHAPE. https only unless a tool opts out; no credentials in the
 *      URL; no exotic scheme (file:, gopher:, ftp: are all SSRF classics).
 *   2. HOSTNAME. Reserved names — localhost, *.internal, *.local — never
 *      resolve to anything we want to reach.
 *   3. RESOLVED ADDRESS. **This is the one that matters.** A hostname check
 *      alone is trivially defeated: `evil.example.com A 169.254.169.254` is a
 *      public name pointing at the metadata service, and a blocklist of strings
 *      will wave it straight through. So we resolve the name and reject if ANY
 *      returned address is private, loopback, link-local, CGNAT, multicast or
 *      reserved — including the IPv6 spellings and the IPv4-in-IPv6 forms
 *      (::ffff:10.0.0.1, 64:ff9b::10.0.0.1, 2002:0a00::) that exist precisely
 *      to smuggle a v4 address past a v6 check.
 *   4. CONNECTION PINNING. Validating a name and then handing the name to the
 *      HTTP stack leaves a window: the attacker's DNS answers publicly to our
 *      check and privately to our connect (DNS rebinding). `http.ts` closes it
 *      by connecting to the exact address this module validated, via a `lookup`
 *      that ignores DNS entirely. `assertPublicUrl` therefore RETURNS the
 *      address it approved; callers must use it rather than re-resolving.
 *   5. REDIRECTS. Off by default. When a tool enables them, every hop runs this
 *      whole function again — a 302 to an internal address is the standard way
 *      around step 3, and following one blindly makes steps 1-4 decorative.
 *
 * Numeric-form addresses (`http://2130706433/`, `http://0x7f.1/`) need no
 * special handling: the WHATWG URL parser normalises them to dotted-quad before
 * we ever see `hostname`. There is a test for it, because that is the kind of
 * fact that stops being true quietly.
 */

/** Thrown by `assertPublicUrl`. Caught by the executor and turned into prose. */
export class BlockedDestinationError extends Error {
  constructor(
    message: string,
    /** Short machine-readable cause, for logs and the tester. */
    readonly code:
      | 'malformed'
      | 'scheme'
      | 'insecure'
      | 'credentials'
      | 'reserved-hostname'
      | 'private-address'
      | 'unresolvable',
  ) {
    super(message);
    this.name = 'BlockedDestinationError';
  }
}

/** Hostnames that never point anywhere a tool has business reaching. */
const RESERVED_HOSTNAME_RE = [
  /^localhost$/i,
  /\.localhost$/i,
  // Cloud-provider internal zones (GCP `*.internal`, AWS `*.ec2.internal`).
  /^internal$/i,
  /\.internal$/i,
  // mDNS. Resolves on the LAN the server sits on, which is not the internet.
  /\.local$/i,
  // Kubernetes service discovery.
  /\.cluster\.local$/i,
  /^metadata\.google\.internal$/i,
];

interface V4 {
  a: number;
  b: number;
  c: number;
  d: number;
}

function parseIpv4(host: string): V4 | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const [a, b, c, d] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
  if ([a, b, c, d].some((n) => Number.isNaN(n) || n > 255)) return null;
  return { a: a as number, b: b as number, c: c as number, d: d as number };
}

/**
 * Every IPv4 range that is not "somewhere on the public internet".
 *
 * The list is longer than the one the brief names, and each addition is there
 * for a reason rather than for completeness: 100.64/10 is carrier-grade NAT and
 * is routable inside a lot of cloud VPCs; 192.0.0/24 holds protocol assignments
 * including the DS-Lite gateway; 198.18/15 is the benchmarking range that
 * several providers use internally; 224/4 and 240/4 are multicast and reserved,
 * and a request to either is never a legitimate API call.
 */
function isPrivateV4({ a, b, c, d }: V4): boolean {
  if (a === 0) return true; // 0.0.0.0/8 — "this network"
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // 127/8 — loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 — CGNAT
  if (a === 169 && b === 254) return true; // 169.254/16 — link-local, incl. .169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 — IETF protocol
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 — benchmarking
  if (a >= 224) return true; // 224/4 multicast, 240/4 reserved, 255.255.255.255
  return false;
}

/** Expand an IPv6 literal to its eight 16-bit groups, or null if unparseable. */
function parseIpv6(host: string): number[] | null {
  const raw = host.replace(/^\[|\]$/g, '');
  if (!raw.includes(':')) return null;

  // A trailing dotted quad (::ffff:127.0.0.1) contributes two groups.
  let text = raw;
  let tail: number[] = [];
  const dotted = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(text);
  if (dotted?.[1]) {
    const v4 = parseIpv4(dotted[1]);
    if (!v4) return null;
    tail = [(v4.a << 8) | v4.b, (v4.c << 8) | v4.d];
    text = text.slice(0, dotted.index).replace(/:$/, '');
    if (text === '') text = '::';
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (!s) return [];
    const out: number[] = [];
    for (const part of s.split(':')) {
      if (part === '' || !/^[0-9a-f]{1,4}$/i.test(part)) return null;
      out.push(Number.parseInt(part, 16));
    }
    return out;
  };

  const head = toGroups(halves[0] ?? '');
  if (!head) return null;
  if (halves.length === 1) {
    const all = [...head, ...tail];
    return all.length === 8 ? all : null;
  }
  const rest = toGroups(halves[1] ?? '');
  if (!rest) return null;
  const known = head.length + rest.length + tail.length;
  if (known > 8) return null;
  return [...head, ...new Array(8 - known).fill(0), ...rest, ...tail];
}

function isPrivateV6(groups: number[]): boolean {
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups;

  // :: (unspecified) and ::1 (loopback)
  if (groups.every((g) => g === 0)) return true;
  if (groups.slice(0, 7).every((g) => g === 0) && g7 === 1) return true;

  // fc00::/7 — unique local. fe80::/10 — link-local. ff00::/8 — multicast.
  if ((g0 & 0xfe00) === 0xfc00) return true;
  if ((g0 & 0xffc0) === 0xfe80) return true;
  if ((g0 & 0xff00) === 0xff00) return true;

  // The IPv4-carrying forms. Each one is a legitimate transition mechanism and
  // each one is also a way to write 169.254.169.254 that a naive v6 check
  // treats as a public address.
  const embedded = (hi: number, lo: number): V4 => ({
    a: hi >> 8,
    b: hi & 0xff,
    c: lo >> 8,
    d: lo & 0xff,
  });
  // ::ffff:a.b.c.d — IPv4-mapped
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff) {
    return isPrivateV4(embedded(g6, g7));
  }
  // ::a.b.c.d — IPv4-compatible (deprecated, still parsed by every stack)
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateV4(embedded(g6, g7));
  }
  // 64:ff9b::a.b.c.d — NAT64
  if (g0 === 0x0064 && g1 === 0xff9b) return isPrivateV4(embedded(g6, g7));
  // 2002:a.b.c.d::/16 — 6to4, the v4 address sits in groups 1-2
  if (g0 === 0x2002) return isPrivateV4(embedded(g1, g2));

  return false;
}

/** True when this literal address must never be connected to. */
export function isBlockedAddress(address: string): boolean {
  const v4 = parseIpv4(address);
  if (v4) return isPrivateV4(v4);
  const v6 = parseIpv6(address);
  if (v6) return isPrivateV6(v6);
  // Not an address we can reason about. Refuse rather than guess.
  return true;
}

export function isReservedHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return RESERVED_HOSTNAME_RE.some((re) => re.test(host));
}

/** One address the host resolved to. */
export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Injectable so the DNS half is testable without a network or a fake resolver. */
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

/**
 * The default resolver. Node-only, and that is fine: every surface that runs a
 * custom tool declares `runtime = 'nodejs'`. If `node:dns` is ever unavailable
 * this THROWS rather than falling through — an unverifiable destination is a
 * blocked destination, which is the opposite of what external-mcp.ts chose for
 * MCP servers, and deliberately so: an MCP server is a URL a user pasted from a
 * vendor's docs, while a custom tool is a URL chosen freely by whoever wants to
 * see what our network can reach.
 */
export const nodeResolver: HostResolver = async (hostname) => {
  const dns = await import('node:dns/promises');
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

export interface AssertOptions {
  /** Per-tool escape hatch for plain http. Defaults to false. */
  allowInsecureHttp?: boolean;
  resolve?: HostResolver;
}

export interface ApprovedDestination {
  url: URL;
  /** The exact address the connection must be pinned to. */
  address: string;
  family: 4 | 6;
}

/**
 * Validate a destination and return the address the caller must connect to.
 *
 * Throws `BlockedDestinationError` on anything suspect. The return value is not
 * optional decoration: connecting by hostname after calling this re-opens the
 * rebinding hole step 4 exists to close.
 */
export async function assertPublicUrl(
  rawUrl: string,
  opts: AssertOptions = {},
): Promise<ApprovedDestination> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedDestinationError(`"${rawUrl}" is not a valid URL.`, 'malformed');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new BlockedDestinationError(
      `Only http and https are allowed; "${url.protocol}" is not.`,
      'scheme',
    );
  }
  if (url.protocol === 'http:' && !opts.allowInsecureHttp) {
    throw new BlockedDestinationError(
      'This destination uses plain http. Enable "permitir HTTP sin cifrar" on the tool if the endpoint genuinely has no TLS.',
      'insecure',
    );
  }
  // `http://user:pass@host/` both leaks a credential into every log line and is
  // a classic way to make a URL read as one host and resolve as another.
  if (url.username || url.password) {
    throw new BlockedDestinationError(
      'Credentials embedded in the URL are not allowed. Use the authentication section instead.',
      'credentials',
    );
  }
  if (isReservedHostname(url.hostname)) {
    throw new BlockedDestinationError(
      `"${url.hostname}" is a reserved internal hostname.`,
      'reserved-hostname',
    );
  }

  const bare = url.hostname.replace(/^\[|\]$/g, '');

  // An IP literal never goes to DNS; judge it directly.
  const literalV4 = parseIpv4(bare);
  const literalV6 = bare.includes(':') ? parseIpv6(bare) : null;
  if (literalV4 || literalV6) {
    if (isBlockedAddress(bare)) {
      throw new BlockedDestinationError(
        `${bare} is a private, loopback, link-local or otherwise reserved address.`,
        'private-address',
      );
    }
    return { url, address: bare, family: literalV4 ? 4 : 6 };
  }

  const resolve = opts.resolve ?? nodeResolver;
  let records: ResolvedAddress[];
  try {
    records = await resolve(bare);
  } catch (err) {
    throw new BlockedDestinationError(
      `Could not resolve "${bare}": ${err instanceof Error ? err.message : String(err)}`,
      'unresolvable',
    );
  }
  if (records.length === 0) {
    throw new BlockedDestinationError(`"${bare}" does not resolve to any address.`, 'unresolvable');
  }

  // EVERY address, not the first. A host that answers with one public and one
  // private address is not half-safe; whichever the stack picked would be the
  // one that mattered, and we do not get to choose after the fact.
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new BlockedDestinationError(
        `"${bare}" resolves to ${record.address}, which is a private or reserved address.`,
        'private-address',
      );
    }
  }

  const chosen = records[0] as ResolvedAddress;
  return { url, address: chosen.address, family: chosen.family };
}

/**
 * The cheap half, for save-time validation in the panel: everything except DNS.
 * Returns null when the URL is acceptable so far, or a Spanish sentence when it
 * is not. Save time is the wrong moment to fail on a name that does not resolve
 * yet (a staging host that is not up, a DNS record being propagated), but it is
 * exactly the right moment to refuse `http://localhost:3000`.
 */
export function describeStaticUrlProblem(
  rawUrl: string,
  allowInsecureHttp: boolean,
): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'La URL no es válida.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'Solo se permiten direcciones http y https.';
  }
  if (url.protocol === 'http:' && !allowInsecureHttp) {
    return 'La dirección debe ser https, o hay que activar explícitamente "permitir HTTP sin cifrar".';
  }
  if (url.username || url.password) {
    return 'No se permiten usuario y contraseña dentro de la URL; usa la sección de autenticación.';
  }
  if (isReservedHostname(url.hostname)) {
    return `"${url.hostname}" es un nombre interno reservado y no se puede consultar desde Cortex.`;
  }
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  if ((parseIpv4(bare) || bare.includes(':')) && isBlockedAddress(bare)) {
    return `${bare} es una dirección privada, de loopback o reservada.`;
  }
  return null;
}
