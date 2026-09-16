// src/index.ts reaches the workerd-only `cloudflare:workers` module through
// `agents/mcp`. node:test cannot load that specifier, so stub the few exports
// the import graph touches. Import this module before importing ../src/index.ts;
// it is opt-in so the rest of the suite keeps loading the real modules.

import { registerHooks } from "node:module";

const STUB_SOURCE = `
export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }
export class RpcTarget {}
export class RpcStub {}
export class EmailMessage {}
export class WorkflowEntrypoint {}
export const env = {};
export const exports = {};
export function withEnv(_e, fn) { return fn(); }
export default {};
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("cloudflare:")) {
      return { url: `cloudflare-stub:${specifier}`, shortCircuit: true, format: "module" };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("cloudflare-stub:")) {
      return { format: "module", source: STUB_SOURCE, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
