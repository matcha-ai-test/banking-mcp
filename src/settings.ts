import type { Env } from "./types";

export function isConfigured(env: Env): boolean {
  return Boolean(env.EB_APP_ID && env.EB_PRIVATE_KEY && env.MCP_SECRET && env.START_TOKEN);
}
