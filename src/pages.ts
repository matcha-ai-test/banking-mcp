import { AUTH_LINK_CMD } from "./mcp-output";

const CSS = [
  ":root{--ink:#1c1917;--muted:#57534e;--line:#d6d3d1;--paper:#fafaf9;--panel:#fff;--btn:#0f766e;--soft:#f0fdfa}",
  "*{box-sizing:border-box}body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;margin:0;background:var(--paper);color:var(--ink);line-height:1.55}",
  "main{max-width:720px;margin:0 auto;padding:1.35rem 1.25rem 4rem}h1{font-size:clamp(1.65rem,5vw,2.15rem);letter-spacing:-.03em;line-height:1.15;margin:.8rem 0 .5rem}p{margin:.55rem 0}a{color:var(--btn)}",
  "a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #5eead4;outline-offset:2px}",
  ".lede{color:var(--muted);font-size:1.03rem;margin:0 0 1.4rem}.badge{display:inline-block;background:var(--soft);color:#115e59;border-radius:999px;padding:.18rem .55rem;font-size:.8rem;font-weight:750}.footer,.hint{color:var(--muted);font-size:.89rem;margin-top:1.5rem}code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.84rem;word-break:break-all}",
  "label{display:block;font-weight:650;font-size:.94rem;margin:.8rem 0 .38rem}input{width:100%;max-width:28rem;font:inherit;padding:.72rem .78rem;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink)}button{font:inherit;font-weight:650;padding:.72rem 1.2rem;border:0;border-radius:9px;background:var(--btn);color:#fff;cursor:pointer}.actions{margin-top:1rem}.err{color:#b91c1c;font-weight:650}",
].join("\n");

export function esc(value: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => map[character]);
}

export function pageResponse(opts: { title: string; body: string; status?: number }): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const body = opts.body.replace(/<script(?=>)/g, `<script nonce="${nonce}"`);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title><style nonce="${nonce}">${CSS}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "X-Robots-Tag": "noindex",
      "Content-Language": "en",
    },
  });
}

export function homePage(configured: boolean): Response {
  const status = configured ? "Server configured" : "Server not configured";
  const body = `<h1>banking-mcp</h1><p class="lede">Private, read-only bank access. No bank-side write functions and no payments.</p><p><span class="badge">${status}</span></p><p>Installation and configuration are performed from the GitHub repository, not on this website.</p><p class="footer"><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>`;
  return pageResponse({ title: "banking-mcp", body });
}

export function privacyPage(): Response {
  const body = `<h1>Privacy</h1><p>banking-mcp is self-hosted and intended for a single operator. Account and transaction data is stored only in the installation's local SQLite/D1 or in the operator's own Cloudflare D1 database.</p><p>The installer stores secrets in the Git-ignored <code>.dev.vars</code> file locally or as encrypted Cloudflare Worker secrets in the cloud. Data is not sent to the banking-mcp authors.</p><p>Enable Banking, your bank, and your chosen hosting provider process data when you use the service. banking-mcp has no bank-side write tools and cannot move money or initiate payments.</p><p class="footer"><a href="/">Back</a></p>`;
  return pageResponse({ title: "Privacy", body });
}

export function termsPage(): Response {
  const body = `<h1>Terms</h1><p>banking-mcp provides read-only account information. It cannot create, change, or delete bank data, move money, or initiate payments.</p><p>The service is not a bank and does not provide financial advice. You operate the installation and are responsible for your Enable Banking application, keys, and linked accounts.</p><p class="footer"><a href="/">Back</a></p>`;
  return pageResponse({ title: "Terms", body });
}

/**
 * Served on /auth/start when the operator cookie is missing. The token lives in
 * the URL fragment (never sent to the server, never in Cloudflare's request
 * logs); this page exchanges it for the HttpOnly cookie over POST and reloads.
 */
export function authGatePage(): Response {
  const messages = {
    missing: `This page needs the operator link. Run <code>${esc(AUTH_LINK_CMD)}</code> on the operator machine and open the link it prints.`,
    failed: `The link could not be verified. Run <code>${esc(AUTH_LINK_CMD)}</code> on the operator machine and open the fresh link.`,
  };
  const body = `<h1>Connect a bank</h1><p id="msg" role="status" aria-live="polite">Verifying the link…</p><script>(function(){const msg=document.getElementById("msg"),hash=new URLSearchParams(location.hash.replace(/^#/,"")),k=hash.get("k");history.replaceState(null,"",location.pathname+location.search);if(!k){msg.innerHTML=${JSON.stringify(messages.missing)};return}fetch("/auth/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({k:k})}).then(r=>{if(!r.ok)throw new Error();location.replace(location.pathname+location.search)}).catch(()=>{msg.setAttribute("role","alert");msg.innerHTML=${JSON.stringify(messages.failed)}})})();</script>`;
  return pageResponse({ title: "Connect a bank", body });
}
