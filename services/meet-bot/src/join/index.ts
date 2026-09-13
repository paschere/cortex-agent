/**
 * Join layer — Vexa's Meet / Teams / Zoom bricks, wired into Cortex.
 *
 * Public surface. The embedder supplies a Playwright Page and observes state
 * through hooks; recording and transcription live OUTSIDE this boundary.
 */
import type { Page } from 'playwright';
import { parseMeetingUrl, type MeetingPlatform } from '../meeting-url';
import { joinGoogleMeeting, setGoogleMeetMicrophone } from './googlemeet/join';
import { setGoogleMeetHand } from './googlemeet/hand';
import { waitForGoogleMeetingAdmission, checkForGoogleAdmissionSilent } from './googlemeet/admission';
import { prepareForRecording, leaveGoogleMeet } from './googlemeet/leave';
import { startGoogleRemovalMonitor, inspectGoogleMeetCall } from './googlemeet/removal';
import { joinMicrosoftTeams } from './msteams/join';
import { waitForTeamsMeetingAdmission, checkForTeamsAdmissionSilent } from './msteams/admission';
import { leaveMicrosoftTeams } from './msteams/leave';
import { startTeamsRemovalMonitor, checkForTeamsRemoval } from './msteams/removal';
import { joinZoomMeeting } from './zoom/join';
import { waitForZoomMeetingAdmission, checkForZoomAdmissionSilent } from './zoom/admission';
import { leaveZoomMeeting } from './zoom/leave';
import { startZoomRemovalMonitor } from './zoom/removal';
import { startDebugView } from './shared/escalation';
import { setHooks, type BotConfig, type Hooks, type JoinState } from './_host';
import { JOIN_BROWSER_ARGS, getJoinBrowserArgs } from './browser-args';

export type { BotConfig, Hooks, JoinState };
export { startDebugView, setHooks };
export { JOIN_BROWSER_ARGS, getJoinBrowserArgs };
export type { MeetingPlatform };

export type Platform = MeetingPlatform;

export interface JoinResult {
  admitted: boolean;
  state: JoinState;
  platform: MeetingPlatform;
}

export interface JoinOptions {
  meetingUrl: string;
  botName?: string;
  uiInteractionMode?: 'humanized' | 'synthetic';
  authenticated?: boolean;
  waitingRoomTimeoutMs?: number;
  debug?: boolean;
  hooks?: Partial<Hooks>;
  display?: string;
  voiceEnabled?: boolean;
  cameraEnabled?: boolean;
  passcode?: string;
}

export function defaultBotName(): string {
  return process.env.DEFAULT_BOT_NAME?.trim() || process.env.MEET_BOT_NAME?.trim() || 'Cortex';
}

export function platformFromUrl(meetingUrl: string): MeetingPlatform {
  const parsed = parseMeetingUrl(meetingUrl);
  if (!parsed) {
    throw new Error('El enlace tiene que ser de Google Meet, Microsoft Teams o Zoom.');
  }
  return parsed.platform;
}

export function buildBotConfig(opts: JoinOptions & { platform: MeetingPlatform }): BotConfig {
  const parsed = parseMeetingUrl(opts.meetingUrl);
  return {
    platform: opts.platform,
    botName: opts.botName ?? defaultBotName(),
    authenticated: opts.authenticated,
    uiInteractionMode: opts.uiInteractionMode,
    display: opts.display,
    voiceEnabled: opts.voiceEnabled,
    cameraEnabled: opts.cameraEnabled,
    passcode: opts.passcode ?? parsed?.passcode,
    automaticLeave: { waitingRoomTimeout: opts.waitingRoomTimeoutMs ?? 180_000 },
  };
}

export async function enterMeeting(
  page: Page,
  meetingUrl: string,
  botName: string,
  botConfig: BotConfig,
): Promise<void> {
  const platform = (botConfig.platform as MeetingPlatform | undefined) ?? platformFromUrl(meetingUrl);
  if (platform === 'teams') {
    await joinMicrosoftTeams(page, meetingUrl, botName, botConfig);
    return;
  }
  if (platform === 'zoom') {
    await joinZoomMeeting(page, meetingUrl, botName, botConfig);
    return;
  }
  await joinGoogleMeeting(page, meetingUrl, botName, botConfig);
}

export async function waitForMeetingAdmission(
  page: Page,
  timeoutMs: number,
  botConfig: BotConfig,
): Promise<boolean> {
  if (botConfig.platform === 'teams') {
    return waitForTeamsMeetingAdmission(page, timeoutMs, botConfig);
  }
  if (botConfig.platform === 'zoom') {
    return waitForZoomMeetingAdmission(page, timeoutMs, botConfig);
  }
  return waitForGoogleMeetingAdmission(page, timeoutMs, botConfig);
}

export async function leaveMeeting(
  page: Page | null,
  botConfig: BotConfig,
  reason = 'cortex_leave',
): Promise<boolean> {
  if (botConfig.platform === 'teams') {
    return leaveMicrosoftTeams(page, botConfig, reason);
  }
  if (botConfig.platform === 'zoom') {
    return leaveZoomMeeting(page, botConfig, reason);
  }
  return leaveGoogleMeet(page, botConfig, reason);
}

export function startRemovalMonitor(
  page: Page,
  platform: MeetingPlatform,
  onRemoval: () => void | Promise<void>,
): () => void {
  if (platform === 'teams') return startTeamsRemovalMonitor(page, onRemoval);
  if (platform === 'zoom') return startZoomRemovalMonitor(page, onRemoval);
  return startGoogleRemovalMonitor(page, onRemoval);
}

export async function inspectMeetingCall(
  page: Page,
  platform: MeetingPlatform,
): Promise<{ ended: boolean; reason: string | null; lostChrome: boolean }> {
  if (platform === 'google_meet') return inspectGoogleMeetCall(page);
  if (page.isClosed()) {
    return { ended: true, reason: 'Se cerró la pestaña de la reunión.', lostChrome: true };
  }
  if (platform === 'teams') {
    const removed = await checkForTeamsRemoval(page);
    return {
      ended: removed,
      reason: removed ? 'Te sacaron de Teams.' : null,
      lostChrome: removed,
    };
  }
  return { ended: false, reason: null, lostChrome: false };
}

export async function joinMeeting(page: Page, opts: JoinOptions): Promise<JoinResult> {
  if (opts.hooks) setHooks(opts.hooks);
  const platform = platformFromUrl(opts.meetingUrl);
  const botConfig = buildBotConfig({ ...opts, platform });

  if (opts.debug) {
    await startDebugView();
  }

  await enterMeeting(page, opts.meetingUrl, botConfig.botName!, botConfig);
  const admitted = await waitForMeetingAdmission(
    page,
    botConfig.automaticLeave!.waitingRoomTimeout,
    botConfig,
  );

  return { admitted: !!admitted, state: admitted ? 'admitted' : 'awaiting_admission', platform };
}

export {
  joinGoogleMeeting,
  setGoogleMeetMicrophone,
  setGoogleMeetHand,
  waitForGoogleMeetingAdmission,
  checkForGoogleAdmissionSilent,
  prepareForRecording,
  leaveGoogleMeet,
  startGoogleRemovalMonitor,
  inspectGoogleMeetCall,
  joinMicrosoftTeams,
  waitForTeamsMeetingAdmission,
  checkForTeamsAdmissionSilent,
  leaveMicrosoftTeams,
  startTeamsRemovalMonitor,
  joinZoomMeeting,
  waitForZoomMeetingAdmission,
  checkForZoomAdmissionSilent,
  leaveZoomMeeting,
  startZoomRemovalMonitor,
};
export { AdmissionError } from './shared/admission';
export type { AdmissionOutcome } from './shared/admission';
export { AuthSessionError } from './googlemeet/join';
export { resetEscalation } from './shared/escalation';
