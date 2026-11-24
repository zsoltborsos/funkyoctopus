/** True when a value is a non-null, non-array object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns an object record, or null for primitives, null, and arrays. */
export function recordOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
