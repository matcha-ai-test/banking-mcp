export type Lang = "sv" | "en";

const CSS = [
  ":root{--ink:#1c1917;--muted:#57534e;--line:#d6d3d1;--paper:#fafaf9;--panel:#fff;--btn:#0f766e;--soft:#f0fdfa}",
  "*{box-sizing:border-box}body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;margin:0;background:var(--paper);color:var(--ink);line-height:1.55}",
  "main{max-width:720px;margin:0 auto;padding:1.35rem 1.25rem 4rem}h1{font-size:clamp(1.65rem,5vw,2.15rem);letter-spacing:-.03em;line-height:1.15;margin:.8rem 0 .5rem}p{margin:.55rem 0}a{color:var(--btn)}",
  "a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #5eead4;outline-offset:2px}.topbar{display:flex;justify-content:flex-end;min-height:2rem}.lang{display:inline-flex;gap:.25rem;padding:.2rem;border:1px solid var(--line);border-radius:10px;background:#fff}.lang a{color:var(--muted);padding:.2rem .55rem;border-radius:7px;text-decoration:none;font-size:.86rem;font-weight:650}.lang a[aria-current=page]{color:#fff;background:var(--btn)}",
  ".lede{color:var(--muted);font-size:1.03rem;margin:0 0 1.4rem}.badge{display:inline-block;background:var(--soft);color:#115e59;border-radius:999px;padding:.18rem .55rem;font-size:.8rem;font-weight:750}.footer,.hint{color:var(--muted);font-size:.89rem;margin-top:1.5rem}code{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.84rem;word-break:break-all}",
  "label{display:block;font-weight:650;font-size:.94rem;margin:.8rem 0 .38rem}input,select{width:100%;font:inherit;padding:.72rem .78rem;border:1px solid var(--line);border-radius:9px;background:#fff;color:var(--ink)}.row{display:grid;grid-template-columns:1fr 1fr;gap:.8rem}fieldset{border:0;padding:0;margin:1rem 0}legend{font-weight:750;margin-bottom:.45rem}.choices{display:grid;grid-template-columns:1fr 1fr;gap:.65rem}.choice{display:flex;gap:.65rem;align-items:flex-start;margin:0;padding:.8rem;border:1px solid var(--line);border-radius:10px;background:#fff;cursor:pointer}.choice:has(input:checked){border-color:var(--btn);background:var(--soft);box-shadow:0 0 0 1px var(--btn)}.choice input{width:auto;margin:.27rem 0 0;accent-color:var(--btn)}.choice span,.choice small{display:block}.choice small{color:var(--muted);font-weight:400;margin-top:.12rem}.banks{display:flex;flex-direction:column;gap:.45rem;max-height:24rem;overflow:auto;margin-top:.8rem}.banks a{padding:.68rem .78rem;border:1px solid var(--line);border-radius:9px;background:#fff;color:inherit;text-decoration:none}.banks a:hover{border-color:var(--btn);background:var(--soft)}.banks .cc{color:var(--muted);font-size:.8rem;margin-left:.45rem}@media(max-width:580px){.row,.choices{grid-template-columns:1fr}}",
].join("\n");

export function languageFromRequest(request: Request): Lang {
  const url = new URL(request.url);
  const explicit = url.searchParams.get("lang");
  if (explicit === "sv" || explicit === "en") return explicit;
  const cookie = request.headers.get("Cookie")?.match(/(?:^|;\s*)banking_lang=(sv|en)(?:;|$)/)?.[1];
  if (cookie === "sv" || cookie === "en") return cookie;
  return /^sv(?:-|,|;|$)/i.test(request.headers.get("Accept-Language") ?? "") ? "sv" : "en";
}

export function esc(value: string): string {
  const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return value.replace(/[&<>"']/g, (character) => map[character]);
}

function languageUrl(currentUrl: string, lang: Lang): string {
  const url = new URL(currentUrl);
  url.searchParams.set("lang", lang);
  return `${url.pathname}${url.search}`;
}

export function pageResponse(opts: { title: string; body: string; lang: Lang; currentUrl: string; status?: number }): Response {
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const body = opts.body.replace(/<script(?=>)/g, `<script nonce="${nonce}"`);
  const html = `<!doctype html><html lang="${opts.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)}</title><style nonce="${nonce}">${CSS}</style></head><body><main><div class="topbar"><nav class="lang" aria-label="${opts.lang === "sv" ? "Språk" : "Language"}"><a href="${esc(languageUrl(opts.currentUrl, "sv"))}" lang="sv"${opts.lang === "sv" ? ' aria-current="page"' : ""}>Svenska</a><a href="${esc(languageUrl(opts.currentUrl, "en"))}" lang="en"${opts.lang === "en" ? ' aria-current="page"' : ""}>English</a></nav></div>${body}</main></body></html>`;
  return new Response(html, {
    status: opts.status ?? 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'`,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "X-Robots-Tag": "noindex",
      "Content-Language": opts.lang,
      "Set-Cookie": `banking_lang=${opts.lang}; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    },
  });
}

export function homePage(request: Request, configured: boolean): Response {
  const lang = languageFromRequest(request);
  const status = configured ? (lang === "sv" ? "Servern är konfigurerad" : "Server configured") : (lang === "sv" ? "Servern är inte konfigurerad" : "Server not configured");
  const body = `<h1>banking-mcp</h1><p class="lede">${lang === "sv" ? "Privat bankåtkomst med endast läsning. Inga skrivfunktioner mot banken och inga betalningar." : "Private, read-only bank access. No bank-side write functions and no payments."}</p><p><span class="badge">${status}</span></p><p>${lang === "sv" ? "Installation och konfiguration görs från GitHub-repot, inte på den här webbplatsen." : "Installation and configuration are performed from the GitHub repository, not on this website."}</p><p class="footer"><a href="/privacy?lang=${lang}">${lang === "sv" ? "Integritet" : "Privacy"}</a> · <a href="/terms?lang=${lang}">${lang === "sv" ? "Villkor" : "Terms"}</a></p>`;
  return pageResponse({ title: "banking-mcp", body, lang, currentUrl: request.url });
}

export function privacyPage(request: Request): Response {
  const lang = languageFromRequest(request);
  const body = lang === "sv"
    ? `<h1>Integritet</h1><p>banking-mcp är självhostad och avsedd för en enda operatör. Konto- och transaktionsdata lagras bara i installationens lokala SQLite/D1 eller i operatörens egen Cloudflare D1-databas.</p><p>Installationsskriptet sparar hemligheter i den Git-undantagna filen <code>.dev.vars</code> lokalt eller som krypterade Cloudflare Worker-hemligheter i molnet. Uppgifterna skickas inte till utvecklarna av banking-mcp.</p><p>Enable Banking, din bank och din valda driftleverantör behandlar uppgifter när du använder tjänsten. banking-mcp har inga skrivverktyg mot banken och kan inte flytta pengar eller initiera betalningar.</p><p class="footer"><a href="/?lang=sv">Tillbaka</a></p>`
    : `<h1>Privacy</h1><p>banking-mcp is self-hosted and intended for a single operator. Account and transaction data is stored only in the installation's local SQLite/D1 or in the operator's own Cloudflare D1 database.</p><p>The installer stores secrets in the Git-ignored <code>.dev.vars</code> file locally or as encrypted Cloudflare Worker secrets in the cloud. Data is not sent to the banking-mcp authors.</p><p>Enable Banking, your bank, and your chosen hosting provider process data when you use the service. banking-mcp has no bank-side write tools and cannot move money or initiate payments.</p><p class="footer"><a href="/?lang=en">Back</a></p>`;
  return pageResponse({ title: lang === "sv" ? "Integritet — banking-mcp" : "Privacy — banking-mcp", body, lang, currentUrl: request.url });
}

export function termsPage(request: Request): Response {
  const lang = languageFromRequest(request);
  const body = lang === "sv"
    ? `<h1>Villkor</h1><p>banking-mcp ger skrivskyddad åtkomst till kontoinformation. Den kan inte skapa, ändra eller radera bankdata, flytta pengar eller initiera betalningar.</p><p>Tjänsten är inte en bank och ger inte finansiell rådgivning. Du driver själv installationen och ansvarar för din Enable Banking-applikation, dina nycklar och vilka konton du länkar.</p><p class="footer"><a href="/?lang=sv">Tillbaka</a></p>`
    : `<h1>Terms</h1><p>banking-mcp provides read-only account information. It cannot create, change, or delete bank data, move money, or initiate payments.</p><p>The service is not a bank and does not provide financial advice. You operate the installation and are responsible for your Enable Banking application, keys, and linked accounts.</p><p class="footer"><a href="/?lang=en">Back</a></p>`;
  return pageResponse({ title: lang === "sv" ? "Villkor — banking-mcp" : "Terms — banking-mcp", body, lang, currentUrl: request.url });
}

/**
 * Served on /auth/start when the operator cookie is missing. The token lives in
 * the URL fragment (never sent to the server, never in Cloudflare's request
 * logs); this page exchanges it for the HttpOnly cookie over POST and reloads.
 */
export function authGatePage(request: Request): Response {
  const lang = languageFromRequest(request);
  const messages =
    lang === "sv"
      ? { verifying: "Verifierar länken…", missing: "Öppna banklänken som installationsskriptet visade, eller kör <code>npm run auth:link</code> på operatörsdatorn för att skriva ut en ny.", failed: "Länken kunde inte verifieras. Kör <code>npm run auth:link</code> på operatörsdatorn och öppna den nya länken." }
      : { verifying: "Verifying the link…", missing: "Open the bank link printed by the installer, or run <code>npm run auth:link</code> on the operator machine to print a new one.", failed: "The link could not be verified. Run <code>npm run auth:link</code> on the operator machine and open the fresh link." };
  const body = `<h1>${lang === "sv" ? "Anslut bank" : "Connect a bank"}</h1><p id="msg" role="status" aria-live="polite">${messages.verifying}</p><script>(function(){const msg=document.getElementById("msg"),hash=new URLSearchParams(location.hash.replace(/^#/,"")),k=hash.get("k");history.replaceState(null,"",location.pathname+location.search);if(!k){msg.innerHTML=${JSON.stringify(messages.missing)};return}fetch("/auth/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({k:k})}).then(r=>{if(!r.ok)throw new Error();location.replace(location.pathname+location.search)}).catch(()=>{msg.setAttribute("role","alert");msg.innerHTML=${JSON.stringify(messages.failed)}})})();</script>`;
  return pageResponse({ title: lang === "sv" ? "Anslut bank" : "Connect a bank", body, lang, currentUrl: request.url });
}

export function bankPickerPage(request: Request): Response {
  const lang = languageFromRequest(request);
  const body = `<h1>${lang === "sv" ? "Välj bank" : "Choose a bank"}</h1><p class="lede">${lang === "sv" ? "Välj Personal för privata konton eller Business för företagskonton. Sök sedan efter din bank." : "Choose Personal for privately owned accounts or Business for company accounts. Then search for your bank."}</p><fieldset><legend>${lang === "sv" ? "Kontotyp" : "Account type"}</legend><div class="choices"><label class="choice"><input type="radio" name="psu" value="personal" checked><span><strong>${lang === "sv" ? "Privat (Personal)" : "Personal"}</strong><small>${lang === "sv" ? "Privatägda konton." : "Privately owned accounts."}</small></span></label><label class="choice"><input type="radio" name="psu" value="business"><span><strong>${lang === "sv" ? "Företag (Business)" : "Business"}</strong><small>${lang === "sv" ? "Företagsägda konton." : "Company-owned accounts."}</small></span></label></div><p class="hint">${lang === "sv" ? "Anslut typerna i separata flöden om du behöver båda." : "Connect the types in separate flows if you need both."}</p></fieldset><div class="row"><div><label for="country">${lang === "sv" ? "Land" : "Country"}</label><select id="country"><option value="SE">${lang === "sv" ? "Sverige" : "Sweden"} (SE)</option></select></div><div><label for="q">${lang === "sv" ? "Sök bank" : "Search bank"}</label><input id="q" placeholder="SEB, Swedbank, Nordea…" autocomplete="off"></div></div><p class="hint" id="meta" role="status" aria-live="polite">${lang === "sv" ? "Laddar banker…" : "Loading banks…"}</p><div class="banks" id="list"></div><script>(function(){const lang=${JSON.stringify(lang)},countryEl=document.getElementById("country"),qEl=document.getElementById("q"),listEl=document.getElementById("list"),metaEl=document.getElementById("meta");let banks=[];function psu(){return(document.querySelector("input[name=psu]:checked")||{}).value||"personal"}function render(){const country=countryEl.value,q=(qEl.value||"").toLowerCase().trim(),type=psu(),rows=banks.filter(b=>(!country||b.country===country)&&(!q||b.name.toLowerCase().includes(q))&&(!b.psu_types||b.psu_types.includes(type))).sort((a,b)=>a.name.localeCompare(b.name));metaEl.textContent=lang==="sv"?rows.length+" banker":rows.length+" bank"+(rows.length===1?"":"s");listEl.replaceChildren();rows.slice(0,200).forEach(b=>{const a=document.createElement("a"),params=new URLSearchParams({bank:b.name,country:b.country,psu:type,lang});a.href="/auth/start?"+params.toString();a.append(document.createTextNode(b.name));const cc=document.createElement("span");cc.className="cc";cc.textContent=b.country;a.append(cc);listEl.append(a)})}function countries(codes){const preferred=["SE","NO","DK","FI","DE","GB","NL","FR","ES","IT"],sorted=Array.from(new Set(codes)).sort((a,b)=>{const ia=preferred.indexOf(a),ib=preferred.indexOf(b);if(ia!==-1||ib!==-1)return(ia===-1?99:ia)-(ib===-1?99:ib);return a.localeCompare(b)});countryEl.replaceChildren();const all=document.createElement("option");all.value="";all.textContent=lang==="sv"?"Alla länder":"All countries";countryEl.append(all);sorted.forEach(code=>{const option=document.createElement("option");option.value=code;option.textContent=code==="SE"?(lang==="sv"?"Sverige (SE)":"Sweden (SE)"):code;option.selected=code==="SE";countryEl.append(option)});if(!sorted.includes("SE"))countryEl.value=""}async function load(){try{const response=await fetch("/auth/banks?"+new URLSearchParams({lang}).toString());if(!response.ok)throw new Error();const data=await response.json();banks=data.banks||[];countries(data.countries?.length?data.countries:banks.map(b=>b.country));render()}catch{metaEl.setAttribute("role","alert");metaEl.textContent=lang==="sv"?"Bankerna kunde inte laddas. Kontrollera Enable Banking-uppgifterna.":"Could not load banks. Check the Enable Banking credentials."}}countryEl.addEventListener("change",render);qEl.addEventListener("input",render);document.querySelectorAll("input[name=psu]").forEach(el=>el.addEventListener("change",render));load()})();</script>`;
  return pageResponse({ title: lang === "sv" ? "Välj bank" : "Choose a bank", body, lang, currentUrl: request.url });
}
