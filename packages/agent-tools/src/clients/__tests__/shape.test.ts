import { describe, expect, it } from 'vitest';
import {
  APPLYING_METHODS,
  InvalidNitError,
  domainOf,
  fullNit,
  isPublicDomain,
  matchByText,
  methodApplies,
  nameKey,
  nitDv,
  normalizeDomain,
  parseNit,
  strictNameKey,
} from '../shape';

/**
 * The two things most likely to be wrong in this module, tested where they are
 * pure: the NIT arithmetic and the matcher.
 *
 * Neither of these is a unit test for its own sake. The DV check is the only
 * thing standing between a transposed digit and a duplicate client that nothing
 * will ever reconcile, and the matcher's refusal to answer when two clients fit
 * is the only thing standing between a search result and one company's mail on
 * another company's card.
 */

describe('the NIT verification digit', () => {
  // Published NITs, so the algorithm is pinned against the world rather than
  // against itself. If `public.nit_dv` in migration 0075 ever drifts from this
  // implementation, one of the two stops agreeing with these.
  it('agrees with real Colombian NITs', () => {
    expect(nitDv('890903938')).toBe(8); // Bancolombia, 890.903.938-8
    expect(nitDv('899999068')).toBe(1); // Ecopetrol, 899.999.068-1
  });

  it('refuses anything that is not a NIT rather than guessing', () => {
    expect(nitDv('abc')).toBeNull();
    expect(nitDv('123')).toBeNull();
    expect(nitDv('')).toBeNull();
  });

  it('accepts a NIT written the way a person writes it', () => {
    expect(parseNit('890.903.938-8')).toEqual({
      digits: '890903938',
      dv: 8,
      formatted: '890.903.938-8',
    });
    expect(parseNit('890903938').digits).toBe('890903938');
    expect(parseNit(' 890 903 938 ').digits).toBe('890903938');
  });

  // THE POINT OF THE WHOLE THING. A NIT with a contradicted check digit is a
  // typo, and saving it produces a second client nothing will ever match.
  it('refuses a NIT whose check digit contradicts its digits', () => {
    expect(() => parseNit('890903938-3')).toThrow(InvalidNitError);
    expect(() => parseNit('890903938-3')).toThrow(/no cuadra/);
  });

  it('accepts a NIT with no check digit, because that claims nothing', () => {
    expect(parseNit('890903938').dv).toBe(8);
  });

  it('prints a NIT the way it is read aloud', () => {
    expect(fullNit('890903938')).toBe('890.903.938-8');
    expect(fullNit(null)).toBeNull();
  });
});

describe('name keys', () => {
  it('folds accents, case and punctuation', () => {
    expect(strictNameKey('Coltráns S.A.S.')).toBe('coltranssas');
    expect(strictNameKey('COLTRANS SAS')).toBe('coltranssas');
  });

  it('drops the legal suffix for the interactive key, and keeps it for the strict one', () => {
    expect(nameKey('COLTRANS S.A.S.')).toBe('coltrans');
    expect(nameKey('Coltrans Ltda')).toBe('coltrans');
    expect(nameKey('Coltrans')).toBe('coltrans');
    // The strict mirror of the SQL function does NOT fold the suffix. The two
    // are allowed to disagree in exactly this direction — the unattended
    // backfill gets the conservative rule.
    expect(strictNameKey('COLTRANS S.A.S.')).not.toBe(strictNameKey('Coltrans'));
  });

  it('never folds a name down to nothing', () => {
    expect(nameKey('SAS')).toBe('sas');
  });
});

describe('email domains', () => {
  it('normalizes what people paste', () => {
    expect(normalizeDomain('@Coltrans.COM ')).toBe('coltrans.com');
    expect(normalizeDomain('https://www.coltrans.com/inicio')).toBe('coltrans.com');
  });

  it('reads the domain out of an address', () => {
    expect(domainOf('Carlos.Ruiz@Coltrans.com')).toBe('coltrans.com');
    expect(domainOf('not an address')).toBeNull();
  });

  it('knows a free provider from a company', () => {
    expect(isPublicDomain('gmail.com')).toBe(true);
    expect(isPublicDomain('hotmail.es')).toBe(true);
    expect(isPublicDomain('coltrans.com')).toBe(false);
  });
});

describe('which signals may be applied', () => {
  // If this test starts failing because somebody added a method, read the note
  // above APPLYING_METHODS before changing it. Widening this set is how one
  // customer's mail ends up on another customer's card.
  it('applies only what a person already stated', () => {
    expect([...APPLYING_METHODS].sort()).toEqual(['contact_email', 'email_domain']);
    expect(methodApplies('email_domain')).toBe(true);
    expect(methodApplies('contact_email')).toBe(true);
    expect(methodApplies('tax_id')).toBe(false);
    expect(methodApplies('name_exact')).toBe(false);
    expect(methodApplies('name_partial')).toBe(false);
  });
});

describe('matching free text to a client', () => {
  const COLTRANS = {
    id: 'c1',
    name: 'Coltrans',
    legal_name: 'Colombiana de Transportes S.A.S.',
    tax_id: '890903938',
  };
  const ALPHA = { id: 'c2', name: 'Alpha Cargo', legal_name: null, tax_id: '899999068' };
  const COLTRANS_LOG = { id: 'c3', name: 'Coltrans Logística', legal_name: null, tax_id: null };

  it('matches an exact name through its legal suffix', () => {
    const m = matchByText('COLTRANS S.A.S.', [COLTRANS, ALPHA]);
    expect(m.only?.clientId).toBe('c1');
    expect(m.only?.method).toBe('name_exact');
  });

  it('matches the razón social too', () => {
    const m = matchByText('Colombiana de Transportes', [COLTRANS, ALPHA]);
    expect(m.only?.clientId).toBe('c1');
  });

  it('matches a NIT quoted in the text — and still only proposes it', () => {
    const m = matchByText('Factura a NIT 890.903.938-8', [COLTRANS, ALPHA]);
    expect(m.only?.method).toBe('tax_id');
    expect(methodApplies(m.only?.method as 'tax_id')).toBe(false);
  });

  // THE RULE THAT MATTERS. Two clients fit the text equally well, so there is
  // no answer — and the caller is handed null rather than the first one.
  it('answers nothing when two clients match the same way', () => {
    const m = matchByText('Coltrans', [
      { id: 'a', name: 'Coltrans', legal_name: null, tax_id: null },
      { id: 'b', name: 'Coltrans S.A.S.', legal_name: null, tax_id: null },
    ]);
    expect(m.candidates).toHaveLength(2);
    expect(m.ambiguous).toBe(true);
    expect(m.only).toBeNull();
  });

  it('lets a clearly stronger match win over a weaker one', () => {
    const m = matchByText('Coltrans Logística', [COLTRANS, COLTRANS_LOG]);
    expect(m.only?.clientId).toBe('c3');
    expect(m.only?.method).toBe('name_exact');
  });

  it('does not match a name inside a longer word', () => {
    const m = matchByText('Multicoltransa Ltda', [COLTRANS]);
    expect(m.only).toBeNull();
    expect(m.candidates).toHaveLength(0);
  });

  it('has nothing to say about an empty counterparty', () => {
    expect(matchByText('', [COLTRANS]).candidates).toHaveLength(0);
    expect(matchByText(null, [COLTRANS]).only).toBeNull();
  });
});
