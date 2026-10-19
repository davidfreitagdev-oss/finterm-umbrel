# FinTerm – audit požadavků na profesionální finanční terminál

> Cíl: z původního zadání (5 stránek v jednom `index.html`) udělat **kompletní self-hosted terminál** ve stylu Bloomberg/Refinitiv, který poběží 24/7 na Raspberry Pi 5 v Umbrel OS na vlastním portu.
> Datum auditu: 18. 10. 2026

---

## 1. Co má profesionální terminál (Bloomberg / Refinitiv Eikon / Koyfin)

| Oblast | Bloomberg funkce | Co z toho dává smysl self-hosted zdarma |
|---|---|---|
| Příkazová řádka | `AAPL US <Equity> GP <GO>` | ✅ Command line s autocompletem (`AAPL`, `CAL`, `HEAT`, `BTC`, `PORT`…) + klávesové zkratky |
| Kotace | MOST, WEI (World Equity Indices), WCRS | ✅ Watchlisty akcie/indexy/komodity/FX/sazby, ticker tape, top movers |
| Graf | GP, GIP | ✅ TradingView Advanced Chart + nativní lehký graf (pro RPi/kiosk) |
| Popis instrumentu | DES, FA | ✅ Detail instrumentu (52W rozpětí, objem, mcap, MA50/200) + TV fundamenty |
| Ekonomický kalendář | ECO, ECST | ✅ Nadcházející + historie, forecast vs. actual, filtry dopad/země |
| Centrální banky | WIRP, CBRT | ✅ Termíny zasedání FED/ECB/ČNB/BoE/BoJ, aktuální sazby, odpočet |
| Makro data | ECST, ECFC | ✅ Makro dashboard (FRED: CPI, PCE, NFP, nezaměstnanost, HDP, M2, spready; CZ/EZ HICP) |
| Zprávy | TOP, NI, FIRST | ✅ Agregátor 40+ RSS (makro/geopolitika, trhy, krypto, ČR), breaking feed, klíčová slova |
| Heatmapy | IMAP, WCRS | ✅ Akcie (S&P/Nasdaq/DAX), krypto treemap, síla měn, sektory |
| Analytika | CORR, GC (yield curve) | ✅ Korelační matice, výnosová křivka, sektorová výkonnost, screener |
| Sentiment | – | ✅ Fear & Greed (akcie CNN + krypto), VIX, BTC dominance |
| Krypto / on-chain | – | ✅ Binance WebSocket (real-time), CoinGecko top 100, mempool (poplatky, bloky, halving, difficulty) |
| Portfolio | PORT, PRTU | ✅ Pozice, P&L v CZK/USD/EUR, alokace, import/export |
| Alerty | ALRT | ✅ Cenové alerty vyhodnocované **na serveru 24/7** + push (ntfy / Telegram / webhook) |
| Poznámky | NOTE | ✅ Obchodní deník se statistikami (win-rate, P&L) |
| Nástroje | – | ✅ Position sizing, R:R, převodník měn, složené úročení, DCA backtest, pivoty/Fibo |
| Zvuk/notifikace | – | ✅ Desktop notifikace + zvuk při breaking news / alertu |
| Multi-monitor / kiosk | – | ✅ 4K/1080p layout, fullscreen, „lite mode“ pro Chromium kiosk přímo na Pi |

## 2. Mezery v původním zadání

1. **Jeden statický `index.html` nestačí.** Prohlížeč nemůže kvůli CORS číst Yahoo Finance, RSS, ForexFactory, FRED ani ČNB. → Je potřeba **malý backend (proxy + cache)** běžící na Pi. Řešení: `server.js` v Node.js **bez jediné npm závislosti**, front-end zůstává jeden soubor `index.html`.
2. **Data se nikam neukládala** (portfolio, poznámky, watchlist). → Persistentní úložiště na Umbrel volume (`/data/state.json`), sdílené mezi všemi zařízeními (PC, iPad, kiosk).
3. **Alerty bez serveru nefungují, když je prohlížeč zavřený.** → Server-side alert engine (každých 60 s) + push notifikace.
4. **„Real-time“ je třeba říct poctivě:** krypto přes Binance WebSocket je skutečně real-time; akcie/indexy/komodity z Yahoo mají zpoždění dle burzy (US ~real-time/15 min, futures 10–30 min). TradingView widgety mají vlastní (také zpožděná) data. Skutečný real-time feed burz je placený.
5. **Ekonomický kalendář zdarma nemá „Actual“ hodnoty v API.** ForexFactory JSON obsahuje jen forecast/previous a jen aktuální týden. → Řešení ve třech vrstvách:
   - server si každý týden **archivuje** události → vzniká vlastní historie,
   - „Actual“ se doplní z hodnoty *previous* následujícího vydání téhož ukazatele,
   - skutečná historie klíčových US ukazatelů z **FRED** (CPI, NFP, nezaměstnanost, HDP, PCE…) + TradingView kalendář jako doplněk (má actual i pro CZ).
6. **ForexFactory nepokrývá CZK.** → Termíny bankovní rady ČNB jsou v aplikaci, repo sazba ČNB se stahuje přímo z cnb.cz, CZ inflace (HICP) a nezaměstnanost z FRED/Eurostatu, TradingView kalendář s filtrem `cz`.
7. **Sazby FED/ČNB/ECB nejsou „kotace“** – je potřeba zdroj: FRED (`DFEDTARU/DFEDTARL`, `ECBDFR`), ČNB (`vyvoj_repo_historie.txt`).
8. **Výkon RPi 5:** Pi jen servíruje data; renderování dělá prohlížeč klienta. Pokud běží kiosk přímo na Pi, je nutný lazy-loading widgetů, pozastavení pollingu na skrytých stránkách, žádné těžké efekty → „Lite mode“.
9. **Bezpečnost:** Umbrel `app_proxy` vynucuje přihlášení do Umbrelu. Proxy pro vlastní RSS má ochranu proti SSRF (blokuje privátní IP), limity velikosti, timeouty.
10. **Odolnost:** cache se „stale-on-error“ (při výpadku zdroje se zobrazí poslední platná data s příznakem), deduplikace souběžných požadavků, rate-limit friendly batchování (Yahoo až 50 symbolů/požadavek).

## 3. Ověřené datové zdroje (otestováno 18. 10. 2026, vše bez API klíče)

| Data | Zdroj | Stav | Poznámka |
|---|---|---|---|
| Akcie, indexy, komodity, FX, výnosy | Yahoo Finance v7 quote (cookie + crumb), v8 chart, v7 spark | ✅ | `^GSPC ^NDX ^GDAXI CEZ.PR GC=F CL=F BZ=F NG=F TTF=F HG=F ZW=F EURCZK=X CZK=X ^TNX 2YY=F DX-Y.NYB ^VIX` |
| Vyhledávání symbolů | Yahoo search | ✅ | autocomplete v command line |
| Krypto real-time | Binance WebSocket | ✅ | přímo z prohlížeče |
| Krypto trh, dominance | CoinGecko `/coins/markets`, `/global` | ✅ | cache 2–5 min (rate limit) |
| Fear & Greed | alternative.me (krypto), CNN (akcie) | ✅ | |
| Bitcoin síť | mempool.space API (nebo lokální Umbrel mempool) | ✅ | poplatky, výška, difficulty, hashrate |
| Ekonomický kalendář | ForexFactory `ff_calendar_thisweek.json` | ✅ | jen aktuální týden → archivace |
| Makro řady | FRED `fredgraph.csv` (bez klíče) | ✅ | CPI, PCE, NFP, UNRATE, HDP, M2, spready, výnosová křivka, ECB sazba, CZ/EZ HICP |
| ČNB | denní kurzy `denni_kurz.txt`, repo `vyvoj_repo_historie.txt` | ✅ | |
| Zprávy | 65 RSS ve třech regionech – **Česko** (ČT24, iRozhlas, Seznam Zprávy, iDNES, Aktuálně, HN, Deník N, Lidovky, E15, Kurzy.cz, Peníze.cz, Roklen24, Forbes CZ, CzechCrunch…), **USA** (CNBC, NYT, Fed, SEC, MarketWatch, Seeking Alpha, Fox Business, CBS, The Hill, Axios, NPR…), **Svět** (BBC, FT, Bloomberg, Al Jazeera, Guardian, DW, France 24, Euronews, Sky News, Politico EU, ECB, CoinDesk, The Block…) | ✅ | WSJ/MarketWatch pulse feedy jsou mrtvé (2025), Yahoo RSS 404, AP 403 |
| Grafy, heatmapy, screener | TradingView widgety | ✅ | embed skripty z s3.tradingview.com |

## 4. Architektura

```
┌──────────── prohlížeč (PC / iPad / kiosk na Pi) ────────────┐
│ index.html (1 soubor, vanilla JS, SPA, 7 modulů)             │
│  ├─ TradingView widgety (lazy)                               │
│  ├─ Binance WebSocket (krypto real-time)                     │
│  └─ fetch /api/*  ───────────────┐                           │
└──────────────────────────────────┼───────────────────────────┘
                                   ▼
┌──────── Umbrel app_proxy (auth) :8420 ────────┐
│  finterm-terminal_web_1  (node:22-alpine)      │
│  server.js – 0 závislostí                       │
│   ├─ /api/quotes  chart  spark  search (Yahoo)  │
│   ├─ /api/news   (RSS agregátor + tagging)      │
│   ├─ /api/calendar (FF + archiv + CB schůze)    │
│   ├─ /api/macro  fred  (FRED, ČNB)              │
│   ├─ /api/crypto  fng  mempool                  │
│   ├─ /api/state/* (persistentní úložiště)       │
│   └─ alert engine → ntfy / Telegram / webhook   │
│  /data  ← ${APP_DATA_DIR}/data (volume)         │
└────────────────────────────────────────────────┘
```

## 5. Moduly aplikace (výsledek auditu)

1. **TRH** – hlavní graf (TradingView, vyhledávání libovolného aktiva, 1 / 2×2 multi-chart), watchlisty (Akcie & Indexy, Komodity, Krypto, Sazby & Měny), market pulse (F&G, VIX, DXY, spread 10Y-2Y, BTC.D), obchodní seance burz, top movers, poslední zprávy.
2. **KALENDÁŘ** – nadcházející události s odpočtem, historie forecast vs. actual (vč. překvapení), filtry dopadu (3 býci) a zemí (USD, EUR, CZK, GBP, JPY, CNY + další), centrální banky (sazby + termíny), makro dashboard, TradingView kalendář.
3. **ZPRÁVY** – pohled *Témata* (TOP 24 h | Makro & Geopolitika | Trhy & Earnings | Krypto & Regulace), pohled *Regiony* (Česko | USA | Svět), *LIVE feed*, filtr regionu, breaking ticker, štítky a skóre důležitosti, jen důležité, zvukové upozornění, označení nových, překlad do češtiny.
4. **ANALÝZA** – heatmapa akcií (S&P 500 / Nasdaq 100 / DAX / Dow…), krypto treemap + dominance, síla měn (vč. CZK), cross rates, sektory (1D–1Y), korelační matice, výnosová křivka, screener.
5. **KRYPTO** *(nové)* – real-time ceny (WebSocket), top 100, globální metriky, Bitcoin síť (mempool, poplatky, halving, difficulty), sats/CZK.
6. **PORTFOLIO** – pozice a P&L v základní měně, alokace, watchlist, server-side alerty, obchodní deník, rozcestník Umbrel aplikací se stavem online/offline.
7. **NÁSTROJE** *(nové)* – position size, R:R, převodník měn, složené úročení, DCA backtest, pivoty a Fibonacci.
+ **Nastavení** – základní měna, intervaly, lite mode, zdroje zpráv (+ vlastní RSS), notifikace, Umbrel host, záloha/obnova dat.

## 6. Omezení, která zůstávají (poctivě)

- Data akcií nejsou burzovní real-time (licence). Pro skutečný real-time je nutný placený feed (Polygon, IEX, Finnhub…) – architektura umožňuje snadno přidat poskytovatele.
- Yahoo Finance je neoficiální API – může se změnit. Server má fallbacky (v7 quote → v8 chart) a stale cache.
- ForexFactory archiv roste až od prvního spuštění. Starší historii pokrývá FRED a TradingView kalendář.
- Svátky burz nejsou v indikátoru seancí zohledněny (jen víkendy a obchodní hodiny).

## 7. Roadmapa (další možné kroky)

- Volitelné placené feedy (Finnhub/Polygon klíč v nastavení) pro real-time US akcie a earnings kalendář.
- Lokální LLM (Umbrel Ollama) – shrnutí zpráv a ranní briefing.
- Napojení na Ghostfolio API (import portfolia) a lokální Bitcoin node (Electrs/Fulcrum) místo mempool.space.
- Vícejazyčný překlad titulků zpráv přes LibreTranslate (také dostupný na Umbrelu).
