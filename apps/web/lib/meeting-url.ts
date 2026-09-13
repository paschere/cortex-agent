export type MeetingPlatform = 'google_meet' | 'teams' | 'zoom';

export interface ParsedMeetingUrl {
  platform: MeetingPlatform;
  href: string;
  code: string;
  passcode?: string;
}

function shortPath(pathname: string): string | null {
  const last = pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop();
  return last ? last.slice(0, 16) : null;
}

export function parseMeetingUrl(raw?: string | null): ParsedMeetingUrl | null {
  if (!raw) return null;
  let href = raw.trim();
  if (!/^https?:\/\//i.test(href)) href = `https://${href}`;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();

  if (host === 'meet.google.com' || host.endsWith('.meet.google.com')) {
    const m = url.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})\b/i);
    if (!m?.[1]) return null;
    return { platform: 'google_meet', href: url.toString(), code: m[1].toLowerCase() };
  }

  if (
    host === 'teams.microsoft.com' ||
    host === 'teams.live.com' ||
    host.endsWith('.teams.microsoft.com') ||
    host.endsWith('.teams.live.com')
  ) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(`${url.pathname}${url.search}`);
    } catch {
      return null;
    }
    const thread = decoded.match(/19:meeting_([A-Za-z0-9_-]+)/i);
    const code = thread?.[1]?.slice(0, 14) ?? shortPath(url.pathname) ?? 'teams';
    return { platform: 'teams', href: url.toString(), code };
  }

  if (
    host === 'zoom.us' ||
    host.endsWith('.zoom.us') ||
    host === 'zoom.com' ||
    host.endsWith('.zoom.com')
  ) {
    const id = url.pathname.match(/\/(?:j|wc|meeting|s)\/(\d+)/);
    const vanity = url.pathname.match(/\/my\/([A-Za-z0-9._-]+)/);
    const code =
      id?.[1] ?? vanity?.[1] ?? (host === 'events.zoom.us' ? shortPath(url.pathname) : null);
    if (!code) return null;
    const passcode = url.searchParams.get('pwd') ?? undefined;
    return { platform: 'zoom', href: url.toString(), code, ...(passcode ? { passcode } : {}) };
  }

  return null;
}

export function isMeetingUrl(raw: string): boolean {
  return parseMeetingUrl(raw) !== null;
}

export function meetingPlatformLabel(platform: MeetingPlatform): string {
  if (platform === 'google_meet') return 'Meet';
  if (platform === 'teams') return 'Teams';
  return 'Zoom';
}
