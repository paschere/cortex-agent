import type { Frame } from 'playwright';
export function stableFrameUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.slice(0, 2000);
  }
}
export function framePath(frame: Frame): { url: string; name: string }[] {
  const path: { url: string; name: string }[] = [];
  let current: Frame | null = frame;
  while (current?.parentFrame()) {
    path.unshift({ url: stableFrameUrl(current.url()), name: current.name().slice(0, 200) });
    current = current.parentFrame();
  }
  return path;
}
