// Secrets that are set via `wrangler secret put` and not in wrangler.jsonc.
// These augment the auto-generated Env from worker-configuration.d.ts.
declare namespace Cloudflare {
  interface Env {
    LLM_API_KEY: string;
  }
}
