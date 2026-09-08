import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourceIntake } from './SourceIntake';

describe('source intake navigation', () => {
  it('renders every intake path with the selected company, including MCP and API anchors', () => {
    const html = renderToStaticMarkup(createElement(SourceIntake, { workspaceId: 'company-a' }));
    for (const path of [
      '/feed?workspace=company-a',
      '/kb?workspace=company-a',
      '/tools?workspace=company-a#custom-tools',
      '/integrations?workspace=company-a#mcp',
      '/finance?workspace=company-a#sources',
    ]) {
      expect(html).toContain(`href="${path}"`);
    }
  });
});
