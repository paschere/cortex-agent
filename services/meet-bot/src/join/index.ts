/**
 * Join layer for Google Meet — the Vexa brick, wired into Cortex.
 *
 * Public surface. The embedder supplies a Playwright Page and observes state
 * through hooks; recording and transcription live OUTSIDE this boundary.
 */
import type { Page } from 'playwright';
import { joinGoogleMeeting, setGoogleMeetMicrophone } from './googlemeet/join';
import { waitForGoogleMeetingAdmission, checkForGoogleAdmissionSilent } from './googlemeet/admission';
import { prepareForRecording, leaveGoogleMeet } from './googlemeet/leave';
import { startGoogleRemovalMonitor } from './googlemeet/removal';
import { startDebugView } from './shared/escalation';
import { setHooks, type BotConfig, type Hooks, type JoinState } from './_host';
import { JOIN_BROWSER_ARGS, getJoinBrowserArgs } from './browser-args';

export type { BotConfig, Hooks, JoinState };
export { startDebugView, setHooks };
export { JOIN_BROWSER_ARGS, getJoinBrowserArgs };

export type Platform = 'google_meet';

export interface JoinResult {
  admitted: boolean;
  state: JoinState;
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
}

export function defaultBotName(): string {
  return process.env.DEFAULT_BOT_NAME?.trim() || process.env.MEET_BOT_NAME?.trim() || 'Cortex';
}

export async function joinMeeting(page: Page, opts: JoinOptions): Promise<JoinResult> {
  if (opts.hooks) setHooks(opts.hooks);

  const botConfig: BotConfig = {
    platform: 'google_meet',
    botName: opts.botName ?? defaultBotName(),
    authenticated: opts.authenticated,
    uiInteractionMode: opts.uiInteractionMode,
    display: opts.display,
    voiceEnabled: opts.voiceEnabled,
    automaticLeave: { waitingRoomTimeout: opts.waitingRoomTimeoutMs ?? 180_000 },
  };

  if (opts.debug) {
    await startDebugView();
  }

  await joinGoogleMeeting(page, opts.meetingUrl, botConfig.botName!, botConfig);
  const admitted = await waitForGoogleMeetingAdmission(
    page,
    botConfig.automaticLeave!.waitingRoomTimeout,
    botConfig,
  );

  return { admitted: !!admitted, state: admitted ? 'admitted' : 'awaiting_admission' };
}

export {
  joinGoogleMeeting,
  setGoogleMeetMicrophone,
  waitForGoogleMeetingAdmission,
  checkForGoogleAdmissionSilent,
  prepareForRecording,
  leaveGoogleMeet,
  startGoogleRemovalMonitor,
};
export { AdmissionError } from './shared/admission';
export type { AdmissionOutcome } from './shared/admission';
export { AuthSessionError } from './googlemeet/join';
export { resetEscalation } from './shared/escalation';
