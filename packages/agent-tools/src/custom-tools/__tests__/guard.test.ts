import { describe, expect, it } from 'vitest';
import {
  BlockedDestinationError,
  type HostResolver,
  assertPublicUrl,
  describeStaticUrlProblem,
  isBlockedAddress,
  isReservedHostname,
} from '../guard';

/**
 * The destination check is the part of this feature that, if it is wrong, hands
 * an attacker our cloud credentials. So these are not "does the function
 * return true" tests — each case below is an attack that has a name.
 */

/** A resolver that answers with whatever the test says, and records the ask. */
function resolverFor(map: Record<string, string[]>): HostResolver {
  return async (hostname) => {
    const addresses = map[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({
      address,
      family: address.includes(':') ? (6 as const) : (4 as const),
    }));
  };
}

const PUBLIC = resolverFor({ 'api.empresa.com': ['203.0.113.10'] });

async function blockCodeOf(url: string, opts = {}): Promise<string> {
  try {
    await assertPublicUrl(url, { resolve: PUBLIC, ...opts });
  } catch (err) {
    if (err instanceof BlockedDestinationError) return err.code;
    throw err;
  }
  return 'allowed';
}

describe('isBlockedAddress — the ranges, one by one', () => {
  it('blocks every IPv4 range that is not the public internet', () => {
    for (const address of [
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.1',
      '169.254.1.1',
      // The one that matters most: the cloud metadata endpoint.
      '169.254.169.254',
      '0.0.0.0',
      '100.64.0.1', // CGNAT
      '198.18.0.1', // benchmarking
      '224.0.0.1', // multicast
      '255.255.255.255',
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const address of ['8.8.8.8', '203.0.113.10', '172.32.0.1', '172.15.0.1', '11.0.0.1']) {
      expect(isBlockedAddress(address), address).toBe(false);
    }
  });

  it('blocks the IPv6 spellings, including the ones that carry an IPv4 inside', () => {
    for (const address of [
      '::1',
      '::',
      'fd00::1', // unique local
      'fe80::1', // link-local
      'ff02::1', // multicast
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:169.254.169.254', // IPv4-mapped metadata endpoint
      '::10.0.0.1', // IPv4-compatible
      '64:ff9b::169.254.169.254', // NAT64
      '2002:a9fe:a9fe::1', // 6to4 carrying 169.254.169.254
    ]) {
      expect(isBlockedAddress(address), address).toBe(true);
    }
  });

  it('allows a genuine public IPv6 address', () => {
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('refuses anything it cannot parse rather than guessing', () => {
    expect(isBlockedAddress('not-an-address')).toBe(true);
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
  });
});

describe('reserved hostnames', () => {
  it('blocks the names that never point outward', () => {
    for (const host of [
      'localhost',
      'app.localhost',
      'db.internal',
      'metadata.google.internal',
      'printer.local',
      'svc.cluster.local',
    ]) {
      expect(isReservedHostname(host), host).toBe(true);
    }
  });

  it('does not block a public name that merely contains one of them', () => {
    expect(isReservedHostname('internal-api.empresa.com')).toBe(false);
    expect(isReservedHostname('localhost.empresa.com')).toBe(false);
  });
});

describe('assertPublicUrl', () => {
  it('allows a public https endpoint and returns the address to connect to', async () => {
    const approved = await assertPublicUrl('https://api.empresa.com/guias/1', { resolve: PUBLIC });
    expect(approved.address).toBe('203.0.113.10');
    expect(approved.url.pathname).toBe('/guias/1');
  });

  it('blocks a literal internal address', async () => {
    expect(await blockCodeOf('https://10.0.0.5/admin')).toBe('private-address');
    expect(await blockCodeOf('https://[::1]/')).toBe('private-address');
  });

  it('blocks the cloud metadata endpoint spelled every way it can be spelled', async () => {
    expect(
      await blockCodeOf('http://169.254.169.254/latest/meta-data/', { allowInsecureHttp: true }),
    ).toBe('private-address');
    // Decimal form. The WHATWG URL parser normalises this to 169.254.169.254
    // before we ever look at it — asserted here because that is a fact about a
    // dependency, and facts about dependencies change quietly.
    expect(new URL('http://2852039166/').hostname).toBe('169.254.169.254');
    expect(await blockCodeOf('http://2852039166/', { allowInsecureHttp: true })).toBe(
      'private-address',
    );
    expect(await blockCodeOf('http://metadata.google.internal/', { allowInsecureHttp: true })).toBe(
      'reserved-hostname',
    );
  });

  it('THE ONE THAT MATTERS: a public name resolving to a private address is blocked', async () => {
    // Nothing about `cliente-erp.com` looks wrong. A string blocklist waves it
    // through, and the request lands on the metadata service.
    const rebinding = resolverFor({ 'cliente-erp.com': ['169.254.169.254'] });
    await expect(
      assertPublicUrl('https://cliente-erp.com/api', { resolve: rebinding }),
    ).rejects.toThrow(/resolves to 169\.254\.169\.254/);
  });

  it('blocks when only ONE of several answers is private', async () => {
    const mixed = resolverFor({ 'dual.example.com': ['203.0.113.10', '10.1.2.3'] });
    await expect(assertPublicUrl('https://dual.example.com/', { resolve: mixed })).rejects.toThrow(
      /10\.1\.2\.3/,
    );
  });

  it('requires https unless the tool opted out', async () => {
    expect(await blockCodeOf('http://api.empresa.com/')).toBe('insecure');
    expect(await blockCodeOf('http://api.empresa.com/', { allowInsecureHttp: true })).toBe(
      'allowed',
    );
  });

  it('refuses non-http schemes and credentials in the URL', async () => {
    expect(await blockCodeOf('file:///etc/passwd')).toBe('scheme');
    expect(await blockCodeOf('gopher://api.empresa.com/')).toBe('scheme');
    expect(await blockCodeOf('https://user:pass@api.empresa.com/')).toBe('credentials');
  });

  it('refuses a host that does not resolve, rather than letting the socket decide', async () => {
    expect(await blockCodeOf('https://nowhere.example/')).toBe('unresolvable');
  });
});

describe('describeStaticUrlProblem — the save-time half', () => {
  it('refuses obvious internal targets without touching DNS', () => {
    expect(describeStaticUrlProblem('http://localhost:3000/x', true)).toMatch(/interno/);
    expect(describeStaticUrlProblem('https://169.254.169.254/', false)).toMatch(/privada/);
    expect(describeStaticUrlProblem('http://api.empresa.com/', false)).toMatch(/https/);
  });

  it('accepts a name that does not resolve yet — a staging host is not an attack', () => {
    expect(describeStaticUrlProblem('https://staging.empresa.com/api', false)).toBeNull();
  });
});
