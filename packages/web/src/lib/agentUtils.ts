/** Normalize an agent name to a lowercase kebab-case identifier. */
export function normalizeAgentName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, "-");
}
