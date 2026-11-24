/**
 * Process entrypoint.
 *
 * Every supported sidecar start routes through here: `npm run server:start`
 * and `npm run dev:server` (and therefore `dev:all`). It first applies the
 * optional settings file (`server/src/config-file.ts`), then loads the server
 * core (`./index.ts`). The embedded-pi promotion
 * tooling lives in `tools/pi-upkeep/` and refuses to run while a sidecar
 * answers on the configured port, so startup takes no lock and checks no
 * sentinel.
 */

import { applyConfigFile, configFilePath } from './config-file.ts';

// Before the core is imported: config.ts reads process.env once, when it loads.
const configPath = configFilePath(process.env);
const applied = await applyConfigFile(configPath, process.env);
if (applied.length > 0) console.log(`config: ${applied.length} settings from ${configPath}`);

await import('./index.ts');
