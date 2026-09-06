import { expect, test } from '@playwright/test';

test('an anonymous visitor loads the human texture and scrubs the scene', async ({ page }) => {
  const textureResponse = page.waitForResponse(
    (response) =>
      response.url().includes('cortex-human-connection') &&
      response.request().resourceType() === 'image',
  );
  await page.goto('/');
  const stage = page.locator('.connection-story__stage');
  await stage.scrollIntoViewIfNeeded();
  const texture = await textureResponse;
  expect(texture.status()).toBe(200);
  expect(texture.headers()['content-type']).toMatch(/^image\//);
  expect(new URL(texture.url()).pathname).toMatch(/^\/_next\/static\/media\//);
  expect(texture.request().redirectedFrom()).toBeNull();
  await expect(stage).toHaveAttribute('data-ready', 'true');

  for (const [progress, phase] of [
    [0, '0'],
    [0.55, '1'],
    [0.98, '2'],
    [0, '0'],
  ] as const) {
    await page.locator('.connection-story__track').evaluate((track, value) => {
      const stage = track.querySelector<HTMLElement>('.connection-story__stage');
      if (!stage) throw new Error('Missing animation stage');
      const inset = Number.parseFloat(getComputedStyle(stage).top) || 0;
      window.scrollTo({
        top:
          window.scrollY +
          track.getBoundingClientRect().top -
          inset +
          (track.clientHeight - stage.clientHeight) * value,
        behavior: 'instant',
      });
    }, progress);
    await expect(stage).toHaveAttribute('data-phase', phase);
    await expect(stage).toHaveAttribute('data-ready', 'true');
  }
});
