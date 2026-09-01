import type { Env } from "./types";

// Values shipped in .dev.vars.example. A one-click "Deploy to Cloudflare" can
// seed these into the new Worker, so treat them as unconfigured: /mcp must stay
// closed until the operator injects real secrets. A fake connection password
// that reads as "configured" would otherwise gate nothing.
const PLACEHOLDERS = new Set([
  "your-enable-banking-application-id",
  "generated-connection-password",
  "generated-bank-link-token",
]);

function isRealSecret(value: string | undefined): boolean {
  return typeof value === "string" && value.length > 0 && !PLACEHOLDERS.has(value);
}

export function isConfigured(env: Env): boolean {
  return (
    isRealSecret(env.EB_APP_ID) &&
    isRealSecret(env.MCP_SECRET) &&
    isRealSecret(env.START_TOKEN) &&
    // The example PEM carries a literal "..." ellipsis; a real key never does.
    typeof env.EB_PRIVATE_KEY === "string" &&
    env.EB_PRIVATE_KEY.length > 0 &&
    !env.EB_PRIVATE_KEY.includes("...")
  );
}
