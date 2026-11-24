/** Renders an unknown caught value without losing non-Error diagnostics. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
