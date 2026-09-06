import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ cookies: vi.fn(), session: vi.fn(), redirect: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: mocks.cookies }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('@/lib/session', () => ({ getOptionalSession: mocks.session }));
vi.mock('./_landing/Landing', () => ({ Landing: () => null }));
import RootPage from './page';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.cookies.mockResolvedValue({ getAll: () => [{ name: 'better-auth.session_token' }] });
  mocks.session.mockResolvedValue({ organization: { id: 'existing-company' } });
  mocks.redirect.mockImplementation(() => {
    throw new Error('redirected');
  });
});
describe('permanent setup entry', () => {
  it('always opens setup for a signed-in company', async () => {
    await expect(RootPage()).rejects.toThrow('redirected');
    expect(mocks.redirect).toHaveBeenCalledWith('/onboarding');
  });
  it('keeps the public landing for anonymous visitors without a session lookup', async () => {
    mocks.cookies.mockResolvedValue({ getAll: () => [] });
    await RootPage();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
  it('does not loop expired sessions back to setup', async () => {
    mocks.session.mockResolvedValue(null);
    await RootPage();
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
