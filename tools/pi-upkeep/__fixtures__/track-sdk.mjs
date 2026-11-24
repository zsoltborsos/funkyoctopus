import { registerHooks } from 'node:module';
const loads = [];
registerHooks({
  load(url, context, nextLoad) {
    if (url.includes('pi-coding-agent')) loads.push(url);
    return nextLoad(url, context);
  },
});
globalThis.__sdkLoads = loads;
