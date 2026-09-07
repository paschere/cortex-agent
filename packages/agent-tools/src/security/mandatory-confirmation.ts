/** These actions cannot be delegated by a mandate or conversation grace. */
export function mandatoryHumanConfirmation(toolId: string): boolean {
  return (
    /^(payments|banking)\.(approve|execute|send|transfer|pay)$/.test(toolId) ||
    /(?:^|\.)(delete|purge|destroy|grant_access|revoke_access|change_role|transfer_ownership)$/.test(
      toolId,
    ) ||
    ['trackers.remove', 'kb.share_space', 'reports.share', 'security.set_action_policy'].includes(
      toolId,
    )
  );
}
