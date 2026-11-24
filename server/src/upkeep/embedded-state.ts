/**
 * Durable embedded-upkeep state.
 *
 * Detection results persist under the repository state dir so the later
 * promotion/recovery CLI can update them while the sidecar is stopped. The
 * sidecar loads the persisted state at startup — validated strictly, failing
 * closed to the default on corruption without blocking listen — and serves
 * `system.upkeep` from memory thereafter. Detection writes back only the
 * fields it owns (installed/latest versions, status, last check) and
 * preserves verification, promotion, and recovery fields.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { messageOf } from '../util/errors.ts';
import { isRecord } from '../util/records.ts';
import { exactStableString } from './versions.ts';
import type { CoordinationFsOps } from './state-path.ts';
import type {
  EmbeddedStatus,
  EmbeddedUpkeepInfo,
  EmbeddedVerificationLevel,
} from '../../../src/shared/transport/protocol.ts';

export const EMBEDDED_STATE_FILE = 'embedded-state.json';
export const EMBEDDED_STATE_SCHEMA_VERSION = 1;
/** Prefix of the unique staging files used for atomic state writes. */
const PENDING_STATE_PREFIX = 'pending-state-';

export type EmbeddedStateFs = Pick<
  CoordinationFsOps,
  'readFile' | 'writeFile' | 'rename' | 'unlink' | 'mkdir' | 'chmod'
>;

/** Durable embedded state: the protocol shape plus a schema version. */
export interface PersistedEmbeddedState extends EmbeddedUpkeepInfo {
  schemaVersion: typeof EMBEDDED_STATE_SCHEMA_VERSION;
}

/** Configuration the Upkeep needs for the durable state store. */
export interface EmbeddedStateConfig {
  stateDir: string;
  fs: EmbeddedStateFs;
  /** Loaded-on-startup persisted state; detection writes back only its fields. */
  initial: PersistedEmbeddedState;
}

/** The honest pre-detection state: nothing known yet. */
export function defaultEmbeddedState(): PersistedEmbeddedState {
  return {
    schemaVersion: EMBEDDED_STATE_SCHEMA_VERSION,
    installedVersion: null,
    latestVersion: null,
    verifiedVersion: null,
    verificationLevel: 'unknown',
    status: 'unknown',
    lastCheckAt: null,
    lastPromotionAttemptAt: null,
    lastPromotionResult: null,
    lastRecoveryAttemptAt: null,
    lastRecoveryResult: null,
  };
}

const EMBEDDED_STATUSES: readonly EmbeddedStatus[] = [
  'unknown',
  'checking',
  'current',
  'available',
  'promotion_failed',
  'needs_attention',
  'recovery_required',
  'cleanup_pending',
];

const VERIFICATION_LEVELS: readonly EmbeddedVerificationLevel[] = [
  'live',
  'deterministic_only',
  'unknown',
];

export type ParsedEmbeddedState =
  | { ok: true; state: PersistedEmbeddedState }
  | { ok: false; reason: string };

/**
 * Strict validation of the persisted state; arbitrary JSON is rejected.
 * Versions must be null or exact stable; timestamps finite nonnegative epoch
 * ms; statuses and verification levels from the closed sets the protocol
 * defines.
 */
export function parseEmbeddedState(raw: string): ParsedEmbeddedState {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'embedded state is not valid JSON' };
  }
  return validateEmbeddedStateValue(value);
}

/**
 * Shared strict validation of the in-memory state value, used by the loader
 * (after JSON.parse) and by the writer (on the object it is about to store).
 * Working on the value — never its JSON serialization — keeps non-finite
 * numbers visible: JSON.stringify silently coerces NaN and ±Infinity to null,
 * so serializing before validating would let them slip through as a valid
 * `null` timestamp.
 */
function validateEmbeddedStateValue(value: unknown): ParsedEmbeddedState {
  if (!isRecord(value)) return { ok: false, reason: 'embedded state root is not an object' };
  if (value['schemaVersion'] !== EMBEDDED_STATE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `unsupported embedded state schema version: ${String(value['schemaVersion'])}`,
    };
  }
  const installedVersion = parseVersionField(value['installedVersion']);
  if (installedVersion === INVALID) return { ok: false, reason: installedReason('installedVersion') };
  const latestVersion = parseVersionField(value['latestVersion']);
  if (latestVersion === INVALID) return { ok: false, reason: installedReason('latestVersion') };
  const verifiedVersion = parseVersionField(value['verifiedVersion']);
  if (verifiedVersion === INVALID) return { ok: false, reason: installedReason('verifiedVersion') };
  const verificationLevel = value['verificationLevel'];
  if (
    typeof verificationLevel !== 'string' ||
    !(VERIFICATION_LEVELS as readonly string[]).includes(verificationLevel)
  ) {
    return { ok: false, reason: `verificationLevel is invalid: ${String(verificationLevel)}` };
  }
  const status = value['status'];
  if (typeof status !== 'string' || !(EMBEDDED_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, reason: `embedded status is invalid: ${String(status)}` };
  }
  const lastCheckAt = parseTimestampField(value['lastCheckAt']);
  if (lastCheckAt === INVALID) return { ok: false, reason: installedReason('lastCheckAt') };
  const lastPromotionAttemptAt = parseTimestampField(value['lastPromotionAttemptAt']);
  if (lastPromotionAttemptAt === INVALID) {
    return { ok: false, reason: installedReason('lastPromotionAttemptAt') };
  }
  const lastRecoveryAttemptAt = parseTimestampField(value['lastRecoveryAttemptAt']);
  if (lastRecoveryAttemptAt === INVALID) {
    return { ok: false, reason: installedReason('lastRecoveryAttemptAt') };
  }
  const lastPromotionResult = parseStringField(value['lastPromotionResult']);
  if (lastPromotionResult === INVALID) {
    return { ok: false, reason: installedReason('lastPromotionResult') };
  }
  const lastRecoveryResult = parseStringField(value['lastRecoveryResult']);
  if (lastRecoveryResult === INVALID) {
    return { ok: false, reason: installedReason('lastRecoveryResult') };
  }
  return {
    ok: true,
    state: {
      schemaVersion: EMBEDDED_STATE_SCHEMA_VERSION,
      installedVersion,
      latestVersion,
      verifiedVersion,
      verificationLevel: verificationLevel as EmbeddedVerificationLevel,
      status: status as EmbeddedStatus,
      lastCheckAt,
      lastPromotionAttemptAt,
      lastPromotionResult,
      lastRecoveryAttemptAt,
      lastRecoveryResult,
    },
  };
}

const INVALID = Symbol('invalid-field');

function parseVersionField(value: unknown): string | null | typeof INVALID {
  if (value === null) return null;
  if (typeof value !== 'string') return INVALID;
  const exact = exactStableString(value);
  return exact === null ? INVALID : exact;
}

function parseTimestampField(value: unknown): number | null | typeof INVALID {
  if (value === null) return null;
  // Epoch ms per the protocol: finite and never negative.
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : INVALID;
}

function parseStringField(value: unknown): string | null | typeof INVALID {
  if (value === null) return null;
  return typeof value === 'string' ? value : INVALID;
}

function installedReason(field: string): string {
  return `embedded state ${field} is invalid`;
}

export function embeddedStatePath(stateDir: string): string {
  return join(stateDir, EMBEDDED_STATE_FILE);
}

export type EmbeddedStateLoad =
  | { kind: 'loaded'; state: PersistedEmbeddedState }
  | { kind: 'absent' }
  | { kind: 'invalid'; reason: string };

export async function loadEmbeddedState(
  stateDir: string,
  fs: Pick<EmbeddedStateFs, 'readFile'>,
): Promise<EmbeddedStateLoad> {
  const path = embeddedStatePath(stateDir);
  let raw: string;
  try {
    raw = await fs.readFile(path);
  } catch (error) {
    if (isEnoent(error)) return { kind: 'absent' };
    return { kind: 'invalid', reason: `embedded state is unreadable: ${messageOf(error)}` };
  }
  const parsed = parseEmbeddedState(raw);
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason };
  // A persisted 'checking' can only be stale — the sidecar never persists a
  // transient check, so normalize it rather than reviving it.
  const state =
    parsed.state.status === 'checking' ? { ...parsed.state, status: 'unknown' as const } : parsed.state;
  return { kind: 'loaded', state };
}

/**
 * Atomically persists the embedded state: a private unique staging file
 * renamed over the state path. A crash leaves at worst an inert staging file,
 * never a torn state file; write/rename failures propagate so the caller can
 * treat persistence as best-effort.
 *
 * The in-memory state is validated with the same strict validator the loader
 * uses **before** serialization — anything the next restart would reject is
 * refused here, and non-finite timestamps cannot hide behind JSON.stringify's
 * silent null coercion. Nothing is written, staged, or overwritten when
 * validation fails, so a write is always readable back (a future CLI caller
 * can never publish state that then wipes the durable store).
 */
export async function saveEmbeddedState(
  stateDir: string,
  fs: EmbeddedStateFs,
  state: PersistedEmbeddedState,
  deps: { randomId?: () => string } = {},
): Promise<void> {
  const validated = validateEmbeddedStateValue(state);
  if (!validated.ok) {
    throw new Error(`refusing to persist invalid embedded state: ${validated.reason}`);
  }
  const serialized = JSON.stringify(state, null, 2);
  const pending = join(stateDir, `${PENDING_STATE_PREFIX}${deps.randomId ? deps.randomId() : randomUUID()}.json`);
  try {
    await fs.writeFile(pending, serialized, { mode: 0o600 });
  } catch (error) {
    await swallowUnlink(fs, pending);
    throw error;
  }
  try {
    await fs.rename(pending, embeddedStatePath(stateDir));
  } catch (error) {
    await swallowUnlink(fs, pending);
    throw error;
  }
}

/** The protocol view of persisted state (drops the schema version). */
export function embeddedInfoOf(state: PersistedEmbeddedState): EmbeddedUpkeepInfo {
  return {
    installedVersion: state.installedVersion,
    latestVersion: state.latestVersion,
    verifiedVersion: state.verifiedVersion,
    verificationLevel: state.verificationLevel,
    status: state.status,
    lastCheckAt: state.lastCheckAt,
    lastPromotionAttemptAt: state.lastPromotionAttemptAt,
    lastPromotionResult: state.lastPromotionResult,
    lastRecoveryAttemptAt: state.lastRecoveryAttemptAt,
    lastRecoveryResult: state.lastRecoveryResult,
  };
}

/** The durable form of the protocol view (adds the schema version). */
export function persistedOf(info: EmbeddedUpkeepInfo): PersistedEmbeddedState {
  return {
    schemaVersion: EMBEDDED_STATE_SCHEMA_VERSION,
    installedVersion: info.installedVersion,
    latestVersion: info.latestVersion,
    verifiedVersion: info.verifiedVersion,
    verificationLevel: info.verificationLevel,
    status: info.status,
    lastCheckAt: info.lastCheckAt,
    lastPromotionAttemptAt: info.lastPromotionAttemptAt,
    lastPromotionResult: info.lastPromotionResult,
    lastRecoveryAttemptAt: info.lastRecoveryAttemptAt,
    lastRecoveryResult: info.lastRecoveryResult,
  };
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Best-effort removal of a staging file; leftovers are inert and never read. */
async function swallowUnlink(fs: Pick<EmbeddedStateFs, 'unlink'>, path: string): Promise<void> {
  try {
    await fs.unlink(path);
  } catch {
    // Already gone or not removable — the state path itself is never touched.
  }
}
