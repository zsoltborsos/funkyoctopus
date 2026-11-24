/**
 * Shared bounded-diagnostic utilities (SDK-free).
 *
 * The promotion engine and the live canary both bound every diagnostic to the
 * reason ceiling before it leaves, so the ceiling and the truncation helper
 * live here — a module with no imports at all — rather than in canary.ts.
 * That keeps the promotion engine's static import graph free of the embedded
 * SDK: importing promote.ts must never evaluate pi, because the promotion
 * transaction imports it before the candidate npm install, and a cached
 * pre-install SDK would be the one the live canary later reused.
 */

/** Byte ceiling on failure reasons/diagnostics reported to the promotion gate. */
export const MAX_REASON_BYTES = 4 * 1024;

/**
 * Bound a reason to the byte ceiling, marking truncation explicitly. The
 * marker itself is trimmed (code-point-wise, never splitting a surrogate
 * pair) when even it cannot fit whole, so the result is always `<= maxBytes`
 * of valid UTF-8 — including for an injected ceiling smaller than the marker.
 */
export function boundedReason(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const marker = '… (truncated)';
  const limit = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let head = '';
  let size = 0;
  for (const char of text) {
    const charSize = Buffer.byteLength(char);
    if (size + charSize > limit) break;
    head += char;
    size += charSize;
  }
  let result = `${head}${marker}`;
  if (Buffer.byteLength(result) > maxBytes) {
    const codePoints = [...result];
    while (Buffer.byteLength(codePoints.join('')) > maxBytes) codePoints.pop();
    result = codePoints.join('');
  }
  return result;
}
