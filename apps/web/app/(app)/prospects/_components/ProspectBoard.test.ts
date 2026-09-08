import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../actions', () => ({ setProspectStatus: vi.fn() }));
import { ProspectBoard } from './ProspectBoard';

describe('Outreach entry flow', () => {
  it('prepares an industry-neutral discovery request in the selected company', () => {
    const html = renderToStaticMarkup(
      createElement(ProspectBoard, {
        prospects: [],
        truncated: false,
        workspaceId: 'company-a',
      }),
    );
    expect(html).toContain('cliente ideal');
    expect(html).toContain('señales de compra');
    expect(html).not.toContain('portales de empleo');
    expect(html).toContain('/schedules?workspace=company-a');
    expect(html).toContain('/chat?prompt=');
    expect(html).toContain('&amp;workspace=company-a');
  });
});
