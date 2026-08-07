/**
 * How the company name reaches a workspace that does not exist yet.
 *
 * The workspace is not created on the signup screen. It is provisioned lazily on
 * the first authenticated request (lib/organization.ts), which is what keeps
 * "sign up in order to accept an invitation" from minting a stray personal
 * workspace — and that ordering is worth keeping exactly as it is. But the
 * person types their company one navigation earlier, so the name has to survive
 * the trip.
 *
 * A short-lived cookie is how, and it is deliberately the humblest mechanism
 * available. `requireSession` reads it once, on the request that provisions, and
 * it is only ever a NAME: losing it costs a default workspace title somebody can
 * change later, and a forged one cannot grant membership of anything, because it
 * reaches no branch except the one that writes `ba_organization.name`.
 *
 * SameSite=Lax so it survives the OAuth round trip back from Google. Ten minutes
 * because that is the outer edge of "I just signed up".
 *
 * This file has no directive and imports nothing, so both the `'use client'`
 * signup form and the server-only session module can read the same constant
 * instead of two string literals that drift.
 */
export const WORKSPACE_NAME_COOKIE = 'cortex_workspace_name';

export const WORKSPACE_NAME_MAX_AGE_SECONDS = 600;

/** Longest company name kept. Matches the column and the workspace title. */
export const WORKSPACE_NAME_MAX_LENGTH = 120;
