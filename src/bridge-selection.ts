/**
 * Which bridge (if any) the extension may claim without asking the user.
 *
 * Only a bridge whose name exactly matches the workspace folder name is
 * auto-claimed. We deliberately do NOT fall back to "the first bridge": with
 * several Claude Code sessions open, that would voice another project's
 * session in this window. With no match the panel stays in the waiting state
 * and the user can pick a session from the bridge dropdown.
 *
 * No `vscode` dependency so it can be unit-tested in plain Node.
 */
export function selectAutoConnectBridge(
  bridges: ReadonlyArray<{ name: string }>,
  workspaceName: string | null | undefined,
): string | null {
  if (!workspaceName) return null;
  return bridges.find((b) => b.name === workspaceName)?.name ?? null;
}
