import { describe, expect, it } from 'vitest';
import { type RepoRow, type RepoSelectionInput, pickRepository } from './repository-rule';

function repo(key: string, over: Partial<RepoRow> = {}): RepoRow {
  return {
    id: `id-${key}`,
    key,
    clone_url: `https://github.com/Zipdev-Team/${key}.git`,
    default_branch: 'main',
    allow_pull_requests: true,
    is_active: true,
    linear_team_keys: null,
    linear_project_ids: null,
    ...over,
  };
}

const NOTHING: RepoSelectionInput = {
  directiveKey: null,
  labelKey: null,
  projectId: null,
  teamKey: null,
};

const ALLOWLIST = [
  repo('zipdev-agent', { linear_team_keys: ['ENG'] }),
  repo('zipdev-matcher', { linear_project_ids: ['project-matcher'] }),
  repo('payroll', { allow_pull_requests: false }),
];

describe('pickRepository', () => {
  it('honours an explicit Repo: line above everything else', () => {
    const result = pickRepository(ALLOWLIST, {
      ...NOTHING,
      directiveKey: 'payroll',
      labelKey: 'zipdev-agent',
      teamKey: 'ENG',
      projectId: 'project-matcher',
    });
    expect(result).toMatchObject({ ok: true, via: 'description' });
    if (result.ok) expect(result.repository.key).toBe('payroll');
  });

  it('honours a repo: label above the team mapping', () => {
    const result = pickRepository(ALLOWLIST, { ...NOTHING, labelKey: 'payroll', teamKey: 'ENG' });
    expect(result).toMatchObject({ ok: true, via: 'label' });
    if (result.ok) expect(result.repository.key).toBe('payroll');
  });

  it('prefers a project mapping over a team mapping', () => {
    const rows = [
      repo('zipdev-agent', { linear_team_keys: ['ENG'] }),
      repo('zipdev-matcher', { linear_project_ids: ['p1'], linear_team_keys: ['ENG'] }),
    ];
    const result = pickRepository(rows, { ...NOTHING, projectId: 'p1', teamKey: 'ENG' });
    expect(result).toMatchObject({ ok: true, via: 'project' });
    if (result.ok) expect(result.repository.key).toBe('zipdev-matcher');
  });

  it('falls back to the team mapping, case-insensitively', () => {
    const result = pickRepository(ALLOWLIST, { ...NOTHING, teamKey: 'eng' });
    expect(result).toMatchObject({ ok: true, via: 'team' });
    if (result.ok) expect(result.repository.key).toBe('zipdev-agent');
  });

  it('carries allow_pull_requests through, so the executor cannot decide it', () => {
    const result = pickRepository(ALLOWLIST, { ...NOTHING, directiveKey: 'payroll' });
    expect(result.ok && result.repository.allowPullRequests).toBe(false);
  });

  it('REJECTS when nothing says which repo — it never picks one', () => {
    const result = pickRepository(ALLOWLIST, NOTHING);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/does not say which repository/);
      expect(result.available).toEqual(['payroll', 'zipdev-agent', 'zipdev-matcher']);
    }
  });

  it('REJECTS even when exactly one repo is registered', () => {
    expect(pickRepository([repo('payroll')], NOTHING).ok).toBe(false);
  });

  it('REJECTS a repo that is not on the allowlist rather than falling back', () => {
    const result = pickRepository(ALLOWLIST, {
      ...NOTHING,
      directiveKey: 'zipdev-secrets',
      teamKey: 'ENG',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not a repository I am allowed to work in/);
      expect(result.askedFor).toBe('zipdev-secrets');
    }
  });

  it('REJECTS a registered but deactivated repo, and says so', () => {
    const rows = [repo('payroll', { is_active: false })];
    const result = pickRepository(rows, { ...NOTHING, directiveKey: 'payroll' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/inactive/);
  });

  it('REJECTS an ambiguous team mapping instead of choosing', () => {
    const rows = [
      repo('zipdev-agent', { linear_team_keys: ['ENG'] }),
      repo('zipdev-matcher', { linear_team_keys: ['ENG'] }),
    ];
    const result = pickRepository(rows, { ...NOTHING, teamKey: 'ENG' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/more than one repository/);
  });

  it('ignores inactive rows when a team mapping is applied', () => {
    const rows = [
      repo('zipdev-agent', { linear_team_keys: ['ENG'], is_active: false }),
      repo('zipdev-matcher', { linear_team_keys: ['ENG'] }),
    ];
    const result = pickRepository(rows, { ...NOTHING, teamKey: 'ENG' });
    expect(result.ok && result.repository.key).toBe('zipdev-matcher');
  });
});
