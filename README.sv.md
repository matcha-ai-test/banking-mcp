# banking-mcp

**Svenska** · [English](README.md)

Privat bankåtkomst med endast läsning för [Claude](https://claude.ai) och [Codex](https://openai.com/codex/), via [Enable Banking](https://enablebanking.com). Servern läser saldon och transaktionshistorik från konton som du godkänner. **Den saknar helt skrivfunktioner mot banken:** den kan inte skapa, ändra eller radera bankdata, flytta pengar eller initiera betalningar. Den skriver bara till sin egen privata cache.

## Installera med en AI-agent

Ge repots adress till Codex, Claude Code eller en annan kodagent och skriv:

```text
Installera detta repo som en MCP-server. Följ AGENTS.md. Fråga mig om jag
vill köra i Moln, Lokalt eller Båda innan du ändrar något. Be aldrig om mina
bankinloggningsuppgifter och stanna när du behöver mitt Enable Banking
Application ID och den lokala sökvägen till den nedladdade .pem-nyckeln.
```

Agentens exakta arbetsgång finns i [AGENTS.md](AGENTS.md). Det finns medvetet **ingen webbaserad installationssida**. Installation, hemligheter, publicering och kontroll hanteras från det klonade repot.

## Installera manuellt

Krav: Node.js 22+ och npm.

```bash
git clone https://github.com/matcha-ai-test/banking-mcp.git
cd banking-mcp
npm ci
npm run install:mcp
```

Installationsskriptet frågar först:

| Läge | Använd för |
|---|---|
| **Moln** | Claude.ai och andra fjärranslutna MCP-klienter, telefon eller flera enheter. Rekommenderas. |
| **Lokalt** | Claude Code eller Codex på en dator. |
| **Båda** | Lokala klienter och molnklienter som delar molndatabasen. |

Du kan också välja direkt:

```bash
npm run install:mcp -- --cloud
npm run install:mcp -- --local
npm run install:mcp -- --both
npm run install:mcp -- --lang=sv
```

Installationen sparar MCP-adress, anslutningslösenord och banklänk i Git-undantagna `.mcp-credentials` med rättighet `0600`; för dessa klientvärden visar terminalen endast filsökvägen, och `npm run auth:link` skriver vid behov ut en ny operatörslänk lokalt.

Molninstallationen lämnar den spårade mallen `wrangler.jsonc` orörd och skriver upptäckta publiceringsvärden till Git-undantagna `wrangler.local.jsonc`; `npm run dev` och `npm run deploy` väljer automatiskt den lokala konfigurationen när den finns.

För en icke-interaktiv agent som återupptar efter registreringen hos Enable Banking:

```bash
npm run install:mcp -- --cloud --yes --app-id=<id> --key-file="/sökväg/till/nyckel.pem"
```

## Installation i molnet

1. Installationsskriptet öppnar Cloudflare-inloggningen vid behov och publicerar först en okonfigurerad Worker för att få den slutliga adressen.
2. Terminalen visar exakt Redirect URL, Privacy URL och Terms URL som Enable Banking behöver.
3. Skapa appen på [Enable Banking API applications](https://enablebanking.com/cp/applications):
   - Välj **Production** för riktiga konton; Sandbox innehåller bara testdata.
   - Välj **Generate in the browser** och exportera den privata nyckeln.
   - För privat och begränsad användning aktiverar du appen genom att länka dina egna konton.
4. Återvänd med endast ditt Application ID och den lokala sökvägen till den nedladdade `.pem`-filen. Skriptet sparar dem som krypterade Cloudflare Worker-hemligheter och publicerar den färdiga servern.
5. Öppna `.mcp-credentials` lokalt och använd banklänken där. Välj **Personal** för privatägda konton eller **Business** för företagskonton och godkänn sedan hos banken.
6. Anslut din MCP-klient med `MCP_URL` och `CONNECTION_PASSWORD` ur `.mcp-credentials`. Se [Ansluta en klient](#ansluta-en-klient).

`.pem`-filen är Enable Banking-appens privata RSA-nyckel och används för att signera API-anrop. Den är inte en bankinloggningsuppgift. Håll den hemlig och lägg den aldrig i Git. Den börjar normalt med `-----BEGIN PRIVATE KEY-----`. Om den börjar med `-----BEGIN RSA PRIVATE KEY-----`, konvertera en kopia till PKCS#8:

```bash
openssl pkcs8 -topk8 -nocrypt -in din-nyckel.pem -out nyckel-pkcs8.pem
```

Att länka konton i Enable Banking begränsar vilka konton appen får nå. Den senare bankauktoriseringen är ett separat steg som skapar en aktiv API-session.

## Lokalt läge

Efter installationen håller du servern igång med:

```bash
npm start
```

MCP-adressen är `http://127.0.0.1:8787/mcp`. Molnklienter kan inte nå en lokal adress.

## Ansluta en klient

Hämta `MCP_URL` och `CONNECTION_PASSWORD` ur `.mcp-credentials`. Committa aldrig värdena och klistra inte in dem i delade filer.

### Claude (fjärranslutning)

Lägg till `/mcp`-adressen som en custom connector. Servern kör sitt eget OAuth-flöde och öppnar en godkännandesida; ange `CONNECTION_PASSWORD` där.

### Codex CLI

Håll lösenordet i en miljövariabel i stället för i `~/.codex/config.toml`. Att läsa in det interaktivt håller det borta från skalhistoriken:

```bash
read -s BANKING_MCP_TOKEN
export BANKING_MCP_TOKEN
```

Registrera sedan servern:

```bash
codex mcp add banking --url "<MCP_URL>" --bearer-token-env-var BANKING_MCP_TOKEN
```

Variabeln måste finnas när Codex startar. Kontrollera med `codex mcp get banking --json` och be sedan Codex anropa `list_accounts`: ett lyckat verktygsanrop är det riktiga beviset, konfigurationskollen visar bara vad som sparats.

### Codex Cloud

Inte dokumenterat än. CLI-konfigurationen ovan konfigurerar inte en molnuppgift, så kopiera den inte till en molnmiljö innan du kontrollerat aktuell officiell Codex-dokumentation för MCP och hemligheter där.

## Verktyg

| Verktyg | Funktion |
|---|---|
| `list_accounts` | Cachade konton, maskerade IBAN, senaste cachade saldon och senaste synktid |
| `get_balances` | Cachade saldon, valfritt filtrerade på kontonamn, maskerat IBAN eller bank |
| `get_transactions` | Upp till 500 cachade transaktioner, väntande ingår som standard, med filter på konto, datum och fritext |
| `refresh_now` | Direktuppdatering från banken, max 3 per session och UTC-dygn, delat mellan alla anslutna klienter |
| `get_auth_status` | Cachad sessionsmetadata plus resultatet av senaste verifierade bankanrop. Anropar inte banken och returnerar ingen token eller hemlig länk |
| `export_statements` | Bulk-JSON-export av cachade bokförda transaktioner sedan ett datum, standard `2025-01-01`, med löpande saldo per rad |

Banklistan hämtas live från Enable Banking. Deras dokumentation beskriver landsspecifikt Open Banking-stöd inom [EU/EES](https://enablebanking.com/docs/markets); tillgängliga länder, banker och stöd för Personal/Business kan ändras.

## Exempeluppgifter

- ”Lista mina anslutna konton och totalt saldo per valuta. Håll IBAN maskerade.”
- ”Uppdatera en gång om det är tillåtet och sammanfatta de senaste sju dagarna och de största utgifterna.”
- ”Jämför den här månadens utgifter med förra månaden och markera osäkra kategorier.”
- ”Hitta troliga abonnemang och återkommande kostnader från de senaste tre månaderna.”
- ”Kontrollera vilken banksession som löper ut först och säg hur operatören förnyar den.”

## Säkerhet

- Inga skrivverktyg, överföringar eller betalningar mot banken finns i servern.
- `/mcp` kräver det genererade anslutningslösenordet.
- En Restricted Enable Banking-app kan bara nå konton som har länkats till den.
- Lokala hemligheter sparas i Git-undantagna `.dev.vars`; molnhemligheter laddas upp som krypterade Cloudflare Worker-hemligheter.
- `.dev.vars`, `.mcp-credentials`, `wrangler.local.jsonc`, `.pem` och `.key` är undantagna från Git.
- Hela råsvaret för transaktioner sparas inte; endast fält som verktygen använder cachas.
- Bankgodkännandet sker hos banken. Servern ber aldrig om eller lagrar dina bankinloggningsuppgifter.

## Officiella guider

- [Enable Banking: registrera applikation](https://enablebanking.com/docs/api/control-panel/)
- [Enable Banking: Restricted access och länkade konton](https://enablebanking.com/docs/api/linked-accounts)
- [Enable Banking: API-snabbstart](https://enablebanking.com/docs/api/quick-start/)
- [Cloudflare Workers: Wrangler](https://developers.cloudflare.com/workers/wrangler/)

## Upphov

Skapad och underhållen av banking-mcp-projektets bidragsgivare.

## Licens

MIT.
