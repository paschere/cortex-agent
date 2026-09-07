import { describe, expect, it } from 'vitest';
import { assertWorkspaceScope, globalToolAllowed, sameWorkspaceScope } from './scope';

describe('global chat boundaries', () => {
  it('none is not personal or all', () => {
    expect(() => assertWorkspaceScope([], ['a'])).not.toThrow();
    expect(sameWorkspaceScope([], ['a'])).toBe(false);
  });
  it('revocation rejects the entire mixed conversation rather than leaking old messages', () => {
    expect(() => assertWorkspaceScope(['a', 'b'], ['a'])).toThrow();
  });
  it('normalizes order but rejects scope changes', () => {
    expect(sameWorkspaceScope(['b', 'a', 'a'], ['a', 'b'])).toBe(true);
    expect(sameWorkspaceScope(['a'], ['a', 'b'])).toBe(false);
  });
  it('being a founder elsewhere never grants management readers here', () => {
    expect(globalToolAllowed('goals.list', 'member')).toBe(false);
    expect(globalToolAllowed('goals.list', 'owner')).toBe(true);
    expect(globalToolAllowed('kb.search', 'member')).toBe(true);
  });
  it('denies writes and future tools by default', () => {
    for (const id of ['gmail.send', 'kb.ingest', 'new.read', 'security.grant']) {
      expect(globalToolAllowed(id, 'owner')).toBe(false);
    }
  });
});
