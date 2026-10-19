# FinTerm – self-hosted finanční terminál pro Umbrel / Raspberry Pi 5

Bloomberg-style terminál v prohlížeči: trhy, ekonomický kalendář, zprávy (Česko · USA · Svět), heatmapy a analytika, krypto & on-chain, portfolio s alerty 24/7. Běží jako aplikace v **Umbrel OS** na vlastním portu **8420**. Žádné API klíče.

```
http://umbrel.local:8420
```

## Co obsahuje

| Stránka (klávesa) | Obsah |
|---|---|
| **1 · Trh** | TradingView graf s vyhledáváním libovolného aktiva, 2×2 multi-chart, lehký nativní graf, watchlisty *Akcie & Indexy / Komodity / Krypto / Sazby & Měny* (FED, ECB, ČNB, US2Y–US30Y, EUR/CZK, USD/CZK…), market pulse (Fear & Greed akcie + krypto, VIX, DXY, spread 10Y–2Y, zlato/stříbro), top movers, světové burzy, důležité zprávy |
| **2 · Akcie (FA)** | Analýza libovolné akcie: **férová cena** z více modelů (2fázový DCF, Grahamův vzorec, Peter Lynch, dividendový model, P/B–ROE pro banky, srovnání s konkurencí, cílové ceny analytiků; Grahamovo číslo a EPV jako konzervativní spodní hranice), football field, **reverzní DCF** (jaký růst je v ceně), interaktivní předpoklady (růst, diskont = bezriziková sazba dané měny + β × prémie, bezpečnostní marže), skóre 0–100 (valuace, kvalita, růst, zdraví, dividenda, momentum), 50+ ukazatelů (P/E, PEG, EV/EBITDA, FCF výnos, marže, ROE, ROIC, zadlužení, výplatní poměr…), **Piotroski F-score**, **Altman Z-score**, výkazy za 4 roky + TTM, technická analýza (RSI, MACD, SMA, Bollinger), riziko (volatilita, max. propad, Sharpe), konkurence. Funguje pro US, evropské i pražské akcie a ADR (přepočet měny výkazů) |
| **3 · Kalendář** | Nadcházející události s odpočtem, historie *forecast vs. actual* s překvapením, filtry dopadu (1–3 býci) a zemí (USD, EUR, CZK, GBP, JPY, CNY…), centrální banky (sazby + termíny + historie), makro dashboard (FRED + ČNB, 32 ukazatelů), TradingView kalendář |
| **4 · Zprávy** | 65 RSS zdrojů: **Česko** (ČT24, iRozhlas, Seznam Zprávy, HN, E15, iDNES, Aktuálně, Kurzy.cz, Peníze.cz…), **USA** (CNBC, NYT, Fed, SEC, MarketWatch, Axios…), **Svět** (BBC, FT, Bloomberg, Al Jazeera, DW, Guardian…). Pohledy *Témata* / *Regiony* / *LIVE feed*, breaking ticker, štítky (FED, INFLACE, VÁLKA, SANKCE…), skóre důležitosti, překlad do češtiny jedním klikem |
| **5 · Analýza** | Heatmapa akcií (S&P 500, Nasdaq 100, Dow…), krypto treemap + dominance, síla měn vč. CZK/PLN/HUF, sektory & trhy (1D–1R), korelační matice, výnosová křivka + spready, screener |
| **6 · Krypto** | Real-time ceny (Binance WebSocket), top 100, Bitcoin síť (poplatky, mempool, hashrate, obtížnost, halving, sats/CZK), sentiment |
| **7 · Portfolio** | Pozice v CZK/EUR/USD s živými kurzy, alokace, vývoj hodnoty, import/export CSV, watchlist, **cenové alerty vyhodnocované serverem 24/7** s push (ntfy / Telegram / webhook), obchodní deník se statistikami, rozcestník Umbrel aplikací (Ghostfolio, Mempool, BTCPay…) |
| **8 · Nástroje** | Velikost pozice, R:R & Kelly, převodník měn, pivoty & Fibonacci, složené úročení, DCA backtest, hypotéka |

**Příkazová řádka** (`/` nebo začněte psát): `AAPL` (akcie → rovnou analýza a férová cena), `CEZ.PR`, `KO FA`, `CEZ DES`, `BTC GP`, `NVDA ALRT`, `CAL`, `CB`, `MACRO`, `NEWS`, `NCZ`, `HEAT`, `FX`, `CORR`, `YC`, `PORT`, `HELP`…

Audit požadavků a architektura: [AUDIT.md](AUDIT.md).

## Struktura

```
umbrel-app-store.yml           ← manifest komunitního Umbrel App Store
finterm-terminal/              ← Umbrel aplikace (id: finterm-terminal)
  umbrel-app.yml
  docker-compose.yml           ← node:22-alpine + app_proxy (přihlášení Umbrelem)
  data/                        ← persistentní data (state.json, archiv kalendáře)
  app/
    server.js                  ← backend, Node.js, 0 závislostí
    public/index.html          ← celý front-end v jednom souboru
    Dockerfile                 ← volitelné vlastní image
docker-compose.standalone.yml  ← provoz bez Umbrel App Store
configure-store.ps1            ← doplní GitHub adresu do manifestu
```

## Instalace na Umbrel (doporučeno – komunitní App Store)

1. Vytvořte na GitHubu **veřejný** repozitář (např. `finterm-umbrel`) a nahrajte do něj obsah této složky.
2. Doplňte adresu repozitáře do manifestu (ikona, odkazy):
   ```powershell
   .\configure-store.ps1 -User vas-github-ucet -Repo finterm-umbrel
   ```
   (případně ručně nahraďte `GITHUB_USER` a `GITHUB_REPO` v `finterm-terminal/umbrel-app.yml`)
3. V Umbrelu: **App Store → ⋯ (vpravo nahoře) → Community App Stores** → vložte URL repozitáře → **Add**.
4. Otevřete obchod **FinTerm** → **Install**. Aplikace poběží na `http://umbrel.local:8420` a je chráněná přihlášením do Umbrelu.

Aktualizace: změny pushněte na GitHub a v Umbrelu klikněte na *Update*. Data v `finterm-terminal/data` zůstávají.

> Umbrel při instalaci zkopíruje složku aplikace do `~/umbrel/app-data/finterm-terminal/` a kód z `app/` připojí read-only do oficiálního image `node:22-alpine` (multi-arch, arm64 pro RPi 5). Není potřeba buildovat vlastní Docker image.

## Alternativa: přes SSH bez App Store (Umbrel nebo jakýkoli Pi s Dockerem)

```bash
ssh umbrel@umbrel.local
git clone https://github.com/vas-github-ucet/finterm-umbrel.git ~/finterm && cd ~/finterm
docker compose -f docker-compose.standalone.yml up -d
```

Aplikace pak není za přihlášením Umbrelu – odkomentujte `BASIC_AUTH` v `docker-compose.standalone.yml`.

## Lokální spuštění (vývoj, Windows/macOS/Linux)

Stačí Node.js 18+:

```bash
node finterm-terminal/app/server.js
```

Pak otevřete `http://localhost:8420`. Data se ukládají do `finterm-terminal/data/`.

## Kiosk na Raspberry Pi (monitor přímo na Pi)

```bash
chromium-browser --kiosk --noerrdialogs --disable-infobars "http://umbrel.local:8420/?lite=1&rotate=60#market"
```

- `lite=1` – úsporný režim (bez animací, TradingView widgety se načtou až na kliknutí, delší intervaly)
- `rotate=60` – po 30 s nečinnosti střídá stránky každých 60 s (nastavení → Obecné)
- 4K monitory: písmo se automaticky zvětšuje (2560 px a 3400 px+)

Výkon: renderování probíhá v prohlížeči klienta, Pi jen servíruje data (server ~60–90 MB RAM). Skryté stránky nepollují, karta prohlížeče na pozadí se pozastaví.

## Notifikace (alerty 24/7)

Nastavení → **Notifikace**:

- **ntfy** – nejjednodušší: nainstalujte aplikaci ntfy do telefonu, odebírejte téma (např. `finterm-xyz123`) a do FinTermu zadejte `https://ntfy.sh/finterm-xyz123` (nebo vlastní ntfy server).
- **Telegram** – bot token od @BotFather + vaše chat ID.
- **Webhook** – JSON POST (Home Assistant, n8n…).

Volitelně posílá i breaking news (max. 6 za hodinu, nastavitelný práh důležitosti).

## Proměnné prostředí

| Proměnná | Výchozí | Popis |
|---|---|---|
| `PORT` | `8420` | port serveru |
| `DATA_DIR` | `finterm-terminal/data` | kam se ukládá `state.json` a archiv kalendáře |
| `BASIC_AUTH` | – | `uzivatel:heslo` – HTTP Basic auth (jen mimo Umbrel) |
| `MEMPOOL_URL` | `https://mempool.space` | výchozí mempool API (lze změnit i v Nastavení) |
| `ALLOW_PRIVATE_FEEDS` | – | `1` povolí vlastní RSS z lokální sítě (jinak blokováno kvůli SSRF) |
| `TZ` | – | časové pásmo kontejneru |

## Datové zdroje a omezení

Yahoo Finance (kotace, grafy, vyhledávání), Binance WebSocket, CoinGecko, alternative.me, CNN Fear & Greed, ForexFactory, FRED, ČNB, mempool.space, RSS, TradingView widgety.

- Krypto přes WebSocket je real-time; akcie/indexy/futures z Yahoo mají zpoždění dle burzy (licence). Pro burzovní real-time je potřeba placený feed.
- ForexFactory poskytuje jen aktuální týden – server ho každou hodinu archivuje, historie se plní od prvního spuštění. Actual označené `*` je odvozené z „previous“ následujícího vydání.
- Termíny zasedání centrálních bank jsou uložené v `server.js` (`CB_MEETINGS`) pro 2026–2027; BoJ je orientační – jednou ročně doplňte.
- Indikátor otevření burz nezohledňuje svátky.

## Záloha

Nastavení → **Data & systém** → Export JSON. Na serveru: `finterm-terminal/data/state.json` (+ automatická záloha `state.json.bak` každých 12 h).
