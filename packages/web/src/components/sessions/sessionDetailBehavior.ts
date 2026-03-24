export function shouldAutoOpenPreviewTab({
  active,
  activeTab,
  alreadyOpened,
  connected,
  suppressAutoOpen,
}: {
  active: boolean;
  activeTab: string;
  alreadyOpened: boolean;
  connected: boolean;
  suppressAutoOpen: boolean;
}): boolean {
  // Launchpad-created sessions should stay on terminal until the user chooses preview.
  return connected && active && activeTab === "terminal" && !alreadyOpened && !suppressAutoOpen;
}
