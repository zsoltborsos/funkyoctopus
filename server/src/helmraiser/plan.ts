import { config } from '../config.ts';
import {
  MAX_HELMRAISER_RUN_FILE_BYTES,
  readHelmraiserRunFile,
  resolveHelmraiserRun,
} from './run-files.ts';

/** Maximum plan text returned over the wire (256 KiB, before the notice). */
export const MAX_HELMRAISER_PLAN_BYTES = MAX_HELMRAISER_RUN_FILE_BYTES;
export const HELMRAISER_PLAN_TRUNCATION_NOTICE = '\n\n[plan truncated after 256 KiB]';

/**
 * Read one run's plan without allowing its identifier or symlinks to escape
 * `<data dir>/runs`. Only a bounded prefix is read into memory.
 */
export async function readHelmraiserPlan(
  runId: string,
  dataDir = config.helmraiserDataDir,
): Promise<{ text: string; path: string }> {
  const run = await resolveHelmraiserRun(runId, dataDir).catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith('Helmraiser run does not exist:')) {
      throw new Error(`Helmraiser plan does not exist for run ${runId}`);
    }
    throw error;
  });
  const file = await readHelmraiserRunFile(run, runId, 'plan.md');
  if (!file) throw new Error(`Helmraiser plan does not exist for run ${runId}`);
  return {
    path: file.path,
    text: file.truncated ? `${file.text}${HELMRAISER_PLAN_TRUNCATION_NOTICE}` : file.text,
  };
}
