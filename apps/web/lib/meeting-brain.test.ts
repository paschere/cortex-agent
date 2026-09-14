import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@cortex/agent-tools', () => ({ getTool: (id: string) => ({ id }), runTool: mocks.run }));
import type { ToolContext } from '@cortex/agent-tools';
import { loadMeetingBrain } from './meeting-brain';

describe('meeting brain lookup', () => {
  beforeEach(() => {
    mocks.run.mockReset();
  });
  it('retrieves the current question with a company-shared ceiling on every call', async () => {
    mocks.run.mockImplementation(async (tool) =>
      tool.id === 'kb.list_spaces'
        ? {
            spaces: [
              { id: 'company', kind: 'global' },
              { id: 'private', kind: 'personal' },
              { id: 'team', kind: 'shared' },
            ],
          }
        : { coverage: 'nothing', hits: [] },
    );
    const ctx = {} as ToolContext;
    const evidence = await loadMeetingBrain('precio actual', ctx);
    await loadMeetingBrain('plazo actual', ctx);
    expect(ctx.kbSpaceIds).toEqual(['company']);
    expect(mocks.run).toHaveBeenCalledTimes(4);
    expect(mocks.run.mock.calls[3]?.[1]).toEqual({ query: 'plazo actual', limit: 8 });
    expect(evidence).toContain('otras herramientas y fuentes autorizadas');
  });
  it('fails closed on space lookup errors and distinguishes failure from no results', async () => {
    mocks.run.mockRejectedValue(new Error('offline'));
    const ctx = {} as ToolContext;
    const evidence = await loadMeetingBrain('cartera', ctx);
    expect(ctx.kbSpaceIds).toEqual([]);
    expect(evidence).toContain('FALLÓ');
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });
});
