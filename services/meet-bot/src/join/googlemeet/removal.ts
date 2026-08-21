import { Page } from "playwright";
import { log } from "../_host";
import {
  callEndedFromSnapshot,
  callLostInCallChrome,
  snapshotGoogleMeetCall,
} from "./call-end";

export async function checkForGoogleRemoval(page: Page): Promise<boolean> {
  try {
    const snap = await page.evaluate(snapshotGoogleMeetCall);
    const verdict = callEndedFromSnapshot(snap);
    if (verdict.ended) {
      log(`🚨 Google Meet call ended: ${verdict.reason}`);
      return true;
    }
    return false;
  } catch (error: any) {
    log(`Error checking for Google Meet removal: ${error.message}`);
    return false;
  }
}

export async function inspectGoogleMeetCall(page: Page): Promise<{
  ended: boolean;
  reason: string | null;
  lostChrome: boolean;
}> {
  try {
    const snap = await page.evaluate(snapshotGoogleMeetCall);
    const verdict = callEndedFromSnapshot(snap);
    return {
      ended: verdict.ended,
      reason: verdict.reason,
      lostChrome: callLostInCallChrome(snap),
    };
  } catch {
    return { ended: false, reason: null, lostChrome: false };
  }
}

export function startGoogleRemovalMonitor(page: Page, onRemoval?: () => void | Promise<void>): () => void {
  log("Starting periodic Google Meet removal monitoring...");
  let removalDetected = false;

  const removalCheckInterval = setInterval(async () => {
    try {
      const isRemoved = await checkForGoogleRemoval(page);
      if (isRemoved && !removalDetected) {
        removalDetected = true;
        log("🚨 Google Meet removal detected from Node.js side. Initiating graceful shutdown...");
        clearInterval(removalCheckInterval);
        try { await onRemoval?.(); } catch {}
      }
    } catch (error: any) {
      log(`Error during Google Meet removal check: ${error.message}`);
    }
  }, 1500);

  return () => {
    clearInterval(removalCheckInterval);
  };
}
