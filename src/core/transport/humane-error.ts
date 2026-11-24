import { UNAVAILABLE_CODES, type UnavailableCode, wireErrorCode } from '@shared/transport/errors.ts';

/** Where each optional tool is installed from. One constant per tool, so a link changes in one place. */
export const HELMRAISER_INSTALL_URL = 'https://zsoltborsos.net';
export const LEEBOARD_INSTALL_URL = 'https://zsoltborsos.net';

const OPTIONAL_TOOLS = {
  helmraiser: { name: 'Helmraiser', url: HELMRAISER_INSTALL_URL },
  leeboard: { name: 'Leeboard', url: LEEBOARD_INSTALL_URL },
} as const;

export type OptionalTool = keyof typeof OPTIONAL_TOOLS;

/**
 * The line for an optional tool that is not on this machine: what is missing,
 * that FunkyOctopus works without it, and where to get it. `text` ends before
 * the link so a view can render the URL as one.
 */
export function notInstalledLine(tool: OptionalTool): { text: string; url: string } {
  const { name, url } = OPTIONAL_TOOLS[tool];
  return { text: `${name} is not installed — FunkyOctopus works without it. Install:`, url };
}

const plainLine = (tool: OptionalTool): string => {
  const { text, url } = notInstalledLine(tool);
  return `${text} ${url}`;
};

/**
 * The one line the browser shows for a backend that is not available, as plain
 * text. Keyed by the seam's wire code so a new unavailable state is a one-row
 * addition here, not a new `if` in a panel. Unavailable means the tool's CLI
 * could not be run, which is to say it is not installed.
 */
export const START_COMMANDS: Record<UnavailableCode, { name: string; hint: string }> = {
  [UNAVAILABLE_CODES.helmraiser]: { name: 'Helmraiser', hint: plainLine('helmraiser') },
  [UNAVAILABLE_CODES.leeboard]: { name: 'Leeboard', hint: plainLine('leeboard') },
};

export interface HumaneError {
  /** What the user reads. Humane for a known unavailable code, raw otherwise. */
  message: string;
  code: string | null;
  /** True when the backend is simply not running — render as attention, not fault. */
  unavailable: boolean;
}

function isUnavailableCode(code: string | null): code is UnavailableCode {
  return code !== null && Object.prototype.hasOwnProperty.call(START_COMMANDS, code);
}

/** The start line for a backend status chip; null when the name is not a known seam. */
export function startHint(backend: string): string | null {
  const entry = Object.values(START_COMMANDS).find((e) => e.name.toLowerCase() === backend.toLowerCase());
  return entry ? entry.hint : null;
}

/**
 * Map whatever a seam gave back — a thrown `WireCallError`, a plain `Error`, or
 * an in-band `{ code, message }` envelope (the Leeboard seam's shape) — to one
 * humane line. `fallback` is used when there is no message at all.
 */
export function humaneError(source: unknown, fallback: string): HumaneError {
  const envelope = isEnvelope(source) ? source : null;
  const code = envelope?.code ?? wireErrorCode(source) ?? null;
  const raw = envelope?.message ?? (source instanceof Error ? source.message : null) ?? fallback;
  if (isUnavailableCode(code)) {
    return { message: START_COMMANDS[code].hint, code, unavailable: true };
  }
  return { message: raw || fallback, code, unavailable: false };
}

function isEnvelope(value: unknown): value is { code: string; message?: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Error) &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}
