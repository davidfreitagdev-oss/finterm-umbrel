# FinTerm – self-hosted finanční terminál pro Umbrel / Raspberry Pi 5

Bloomberg-style terminál v prohlížeči: trhy, ekonomický kalendář, zprávy (Česko · USA · Svět), heatmapy a analytika, krypto & on-chain, portfolio s alerty 24/7. Běží jako aplikace v **Umbrel OS** na vlastním portu **8420**. Žádné API klíče.

```
http://umbrel.local:8420
```

## Co obsahuje

| Stránka (klávesa) | Obsah |
|---|---|
| **1 · Trh** | TradingView graf s vyhledáváním libovolného aktiva, 2×2 multi-chart, lehký nativní graf, watchlisty *Akcie & Indexy / Komodity / Krypto / Sazby & Měny* (FED, ECB, ČNB, US2Y–US30Y, EUR/CZK, USD/CZK…), market pulse (Fear & Greed akcie + krypto, VIX, DXY, spread 10Y–2Y, zlato/stříbro), top movers, světové burzy, důležité zprávy |
| **2 · Akcie (FA)** | Analýza libovolné akcie: **férová cena** z více modelů (2fázový DCF, Grahamův vzorec, Peter Lynch, dividendový model, P/B–ROE pro banky, srovnání s konkurencí, cílové ceny analytiků; Grahamovo číslo a EPV jako konzervativní spodní hranice), football field, **reverzní DCF** (jaký růst je v ceně), interaktivní předpoklady (růst, diskont = bezriziková sazba dané měny + β × prémie, bezpečnostní marže), skóre 0–100 (valuace, kvalita, růst, zdraví, dividenda, momentum), 50+ ukazatelů (P/E, PEG, EV/EBITDA, FCF výnos, marže, ROE, ROIC, zadlužení, výplatní poměr…), **Piotroski F-score**, **Altman Z-score**, výkazy za 4 roky + TTM, technická analýza (RSI, MACD, SMA, Bollinger), riziko (volatilita, max. propad, Sharpe), konkurence. Funguje pro akcie z USA, Evropy, Prahy, Asie i Latinské Ameriky a pro ADR: měna výkazů se pozná podle položek, volné cash flow pro akcionáře se u výkazů podle IFRS počítá po úrocích a leasingu, EPS a dividendy z Yahoo se kontrolují proti výkazům a skutečným výplatám, odhad růstu ukazuje, z čeho vznikl |
| **3 · Kalendář** | Nadcházející události s odpočtem, historie *forecast vs. actual* s překvapením, filtry dopadu (1–3 býci) a zemí (USD, EUR, CZK, GBP, JPY, CNY…), centrální banky (sazby + termíny + historie), makro dashboard (FRED + ČNB, 32 ukazatelů), TradingView kalendář |
| **4 · Zprávy** | 65 RSS zdrojů: **Česko** (ČT24, iRozhlas, Seznam Zprávy, HN, E15, iDNES, Aktuálně, Kurzy.cz, Peníze.cz…), **USA** (CNBC, NYT, Fed, SEC, MarketWatch, Axios…), **Svět** (BBC, FT, Bloomberg, Al Jazeera, DW, Guardian…). Pohledy *Témata* / *Regiony* / *LIVE feed*, breaking ticker, štítky (FED, INFLACE, VÁLKA, SANKCE…), skóre důležitosti, překlad do češtiny jedním klikem |
| **5 · Analýza** | Heatmapa akcií (S&P 500, Nasdaq 100, Dow…), krypto treemap + dominance, síla měn vč. CZK/PLN/HUF, sektory & trhy (1D–1R), korelační matice, výnosová křivka + spready, screener |
| **6 · Krypto** | Real-time ceny (Binance WebSocket), top 100, **vlastní Bitcoin uzel** (synchronizace, peery, mempool, odhady poplatků přímo z bitcoind), Bitcoin síť z **vlastního mempoolu** na Umbrelu (jinak mempool.space), halving, sats/CZK, sentiment |
| **7 · Portfolio** | Portfolio ve stylu **Ghostfolia**: přímá synchronizace s vaším Ghostfoliem přes API (Security Token, automaticky každých 30 min) nebo import exportu, ruční transakce. Hodnota a výkonnost v čase (TWR, ROAI, XIRR) v CZK/USD/EUR, srovnání s indexem i „stejné vklady do S&P 500“, alokace podle pozic, tříd, sektorů (vč. rozpadu ETF), zemí, měn a účtů, **X-ray** kontrola rizik (koncentrace, krypto, měnové riziko, transakce s cenou mimo trh…), dividendy, ohodnocení akcií v portfoliu férovou cenou a skóre. Dále watchlist, **cenové alerty 24/7** s push (ntfy / Telegram / webhook), obchodní deník, rozcestník Umbrel aplikací |
| **8 · Nástroje** | Velikost pozice, R:R & Kelly, převodník měn, pivoty & Fibonacci, složené úročení, DCA backtest, hypotéka |

**Příkazová řádka** (`/` nebo začněte psát): `AAPL` (akcie → rovnou analýza a férová cena), `CEZ.PR`, `KO FA`, `CEZ DES`, `BTC GP`, `NVDA ALRT`, `CAL`, `CB`, `MACRO`, `NEWS`, `NCZ`, `HEAT`, `FX`, `CORR`, `YC`, `PORT`, `HELP`…

**Hledání instrumentů:** příkazová řádka, stránka Akcie, alerty, transakce, watchlist i nástroje přijmou holý ticker (`G1A`, `7203`, `SAP`), název firmy (`Siemens`, `Toyota`, `Komerční`) i symbol s příponou burzy (`G1A.DE`, `7203.T`). FinTerm vybere domácí kotaci firmy. Když stejný ticker patří různým firmám (`ALV` = Allianz i Autoliv), nabídne výběr s burzou a měnou; ovládá se šipkami a Enterem.

Audit požadavků a architektura: [AUDIT.md](AUDIT.md).

## Struktura

```
umbrel-app-store.yml           ← manifest komunitního Umbrel App Store
finterm-terminal/              ← Umbrel aplikace (id: finterm-terminal)
  umbrel-app.yml
  docker-compose.yml           ← node:22-alpine + app_proxy (přihlášení Umbrelem)
  hooks/pre-start              ← při aktualizaci nasadí nový kód z app/
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
4. Otevřete obchod **FinTerm** → **Install** (vyžaduje aplikaci **Bitcoin Node**). Aplikace poběží na `http://umbrel.local:8420` a je chráněná přihlášením do Umbrelu.

Aktualizace: změny pushněte na GitHub (se zvýšenou `version` v `umbrel-app.yml`) a v Umbrelu klikněte na *Update*. Data v `finterm-terminal/data` zůstávají.

> umbrelOS při aktualizaci kopíruje jen `umbrel-app.yml`, `docker-compose.yml`, `exports.sh`, `*.template` a `hooks/`, ne složku `app/`. Kód proto při každém startu dorovná `hooks/pre-start` z kopie obchodu, ale jen pokud verze v obchodě odpovídá nainstalované verzi. Běžný restart tedy nikdy nenasadí aktualizaci, kterou jste ještě nepotvrdili.

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

## Propojení s Ghostfoliem, Bitcoin uzlem a mempoolem

- **Ghostfolio** – Portfolio → Transakce & zdroje (nebo Nastavení → Propojení): zadejte adresu Ghostfolia a **Security Token** (Ghostfolio → Settings). Na Umbrelu je Ghostfolio za přihlášením Umbrelu, proto FinTerm automaticky použije interní adresu `ghostfolio_server_1:3334`. Synchronizace běží každých 30 minut; token se nikdy neposílá zpět do prohlížeče.
- **Bitcoin uzel** – FinTerm má v `umbrel-app.yml` závislost na aplikaci Bitcoin Node, takže mu umbrelOS předá RPC údaje (`10.21.21.8:8332`). Bez závislosti je umbrelOS aplikaci nepředá. FinTerm volá jen čtecí metody. Bez uzlu: odeberte závislost `bitcoin` a údaje zadejte ručně v Nastavení → Propojení.
- **Mempool** – lokální Umbrel mempool (`10.21.21.26:3006`) se najde automaticky, jinak se použije mempool.space.

## Velikost zobrazení

Tlačítko **Aa** v horní liště přepíná velikost (kompaktní → extra velká), totéž v Nastavení nebo parametrem `?ui=1.25` pro kiosk/TV.

## Notifikace (alerty 24/7)

Nastavení → **Notifikace**:

- **ntfy** – nejjednodušší: nainstalujte aplikaci ntfy do telefonu, odebírejte téma (např. `finterm-xyz123`) a do FinTermu zadejte `https://ntfy.sh/finterm-xyz123` (nebo vlastní ntfy server).
- **Telegram** – bot token od @BotFather + vaše chat ID.
- **Webhook** – JSON POST (Home Assistant, n8n…).

Volitelně posílá i breaking news (max. 6 za hodinu, nastavitelný práh důležitosti).

Notifikace alertu uvádí i název instrumentu a burzu. Když změníte server ntfy, Bitcoin RPC nebo Ghostfolia (jiný host, port nebo schéma) a nezadáte nový token či heslo, FinTerm uložené tajné údaje zahodí, aby se neodeslaly na novou adresu. Změna tématu ntfy na stejném serveru je ponechá.

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
- **Banky, pojišťovny, hypoteční společnosti a obchodníci s cennými papíry** (odvětví Yahoo Banks, Insurance, Mortgage Finance a Capital Markets): dluh / vlastní kapitál, EV, EV/EBITDA, FCF výnos, čistý dluh / EBITDA, hrubá a EBITDA marže a Altman Z se nepočítají („nepoužije se u bank“), skóre Zdraví se vynechá a celkové skóre se přepočte bez něj. Férová cena vychází z modelů P/B–ROE, dividendového modelu, Grahama, Lynche a konkurence; Piotroski ukazuje splněná kritéria z použitelných. Karetní a platební společnosti, správci aktiv, burzy a poskytovatelé dat (Credit Services, Asset Management, Financial Data & Stock Exchanges, Insurance Brokers) se počítají jako běžné firmy.
- **Volné cash flow bez investic (capex):** když Yahoo kapitálové výdaje neuvádí a FCF se pak rovná provoznímu cash flow (např. ČEZ), použije FinTerm odhad volného CF z Yahoo (označený „odhad Yahoo“). Když chybí i ten, je FCF neznámé a DCF ani reverzní DCF se nepočítají.
- **Zastaralý kurz:** poslední platný kurz každého měnového páru se ukládá do `fx-last.json` v datovém adresáři. Když jsou ČNB i Yahoo nedostupné (např. start Raspberry Pi před sítí), použije se tento kurz a portfolio i valuace ukážou, z jakého je data. Bez uloženého kurzu se dotčené pozice do hodnoty portfolia nezapočtou a valuace akcie se nezobrazí; nic se nepřepočítává 1 : 1. Výsledky se zastaralým kurzem se drží v cache jen krátce.
- Bezriziková sazba se bere z FRED pro USD, EUR, CZK, GBP, JPY, CHF, PLN, DKK, SEK, NOK, HUF, ZAR, ILS, INR, AUD, CAD, NZD, KRW, MXN, CLP a COP (místní řada jen do stáří 6 měsíců). Ostatní měny (TRY, CNY, TWD, BRL; HKD kvůli pevnému kurzu k USD) používají označenou náhradu US 10Y. Riziková přirážka země se přičítá jen k této náhradě – výnos vlastních státních dluhopisů (CZK, PLN, ZAR…) riziko země už obsahuje. Diskont je nejméně bezriziková sazba + 4 p.b. a zároveň terminální růst + 3 p.b. (i pro dividendový model a P/B–ROE). Terminální růst je nejvýš inflační cíl centrální banky dané měny + 0,5 p.b. a nejvýš bezriziková sazba. Grahamův vzorec počítá s výnosem bezriziková sazba + rozpětí amerických dluhopisů AAA, nejméně ale 4,4 % (nízké sazby tak hodnotu nezvednou nad Grahamův původní vzorec). Akcie kotované v pencích nebo centech (GBp, ZAc, ILA) se oceňují v hlavní měně, ceny na akcii se ukazují v jednotce kotace.
- **Volné cash flow pro akcionáře:** DCF diskontuje FCF nákladem vlastního kapitálu, proto se u firem se sídlem mimo USA (výkazy podle IFRS) od FCF odečítají placené úroky vykázané ve financování a splátky leasingu. Yahoo splátky leasingu samostatně neuvádí, nahrazují je krátkodobé leasingové závazky. U amerických firem jsou úroky i operativní leasing už v provozním CF. Zahraniční firmy s výkazy podle US GAAP (např. Shopify, Alibaba) tím mají FCF mírně podhodnocené.
- **Odhad růstu** je medián tří složek: růst EPS podle analytiků (aspoň 3 analytici; když se letošní a příští rok liší znaménkem nebo o víc než 15 p.b., bere se jen příští rok), růst tržeb podle analytiků a historický růst EPS. Výkyvy cyklických firem, skoky po změně účetních standardů a roční tempa nad ±50 % se vynechávají. Předpoklady ukazují, které složky se použily a proč. Jednorázový skok zisku v letošním roce (např. ČEZ 2026) model nezapočte jako úroveň, výsledek je spíš konzervativní.
- **Kontroly dat Yahoo:** EPS z Yahoo se porovná se ziskem z výkazů (při rozdílu nad 25 % se použijí výkazy, pokud EPS z Yahoo neodpovídá normalizovanému zisku), dividenda se porovná se skutečnými výplatami za 12 měsíců (při rozdílu nad 1,5× oběma směry se použijí výplaty) a měna výkazů se určí podle jednotlivých položek. Když je normalizovaný zisk záporný, modely ze zisku se do férové ceny nepočítají.
- **Hledání instrumentů** používá vyhledávání Yahoo a hromadnou kotaci s příponami hlavních burz. Kotace bez obchodu za posledních 30 dní se nenabízejí. Při výpadku Yahoo FinTerm ohlásí chybu, nikdy nehádá. Index PX Yahoo nemá, je dostupný jen jako graf TradingView (`PSECZ:PX`).

## PIN portfolia

Stránka **Portfolio** (klávesa `7`) se otevře jen po zadání PINu (4–8 číslic). PIN nastavíte při prvním otevření stránky, potom zůstane portfolio odemčené 20 minut od zadání; aktivita okno neprodlužuje. Délku odemčení (5–120 min) a PIN změníte v Nastavení → **Data & systém** → PIN portfolia, vždy po zadání aktuálního PINu. Tlačítko **Zamknout** vedle záložek stránky zamkne portfolio okamžitě.

- Zámek vynucuje server: bez platného odemčení nedostane prohlížeč portfolio, deník ani poznámky. Portfolio a deník se navíc neukládají do `localStorage` prohlížeče a po zamčení se vymažou z paměti stránky. Watchlist, alerty a nastavení zámek nechrání, používají je i ostatní stránky.
- Serverové úlohy (synchronizace Ghostfolia, vyhodnocování alertů) běží dál i při zamčeném portfoliu.
- Po pěti chybných pokusech za sebou se zadávání na 30 s zablokuje, každá další chyba dobu zdvojnásobí (nejvýše 15 min).
- Export zálohy i její import v Nastavení vyžadují odemčené portfolio, údaje Ghostfolia (Nastavení → Propojení) lze měnit jen po odemčení.
- PIN je uložený jen jako hash (scrypt) v `pin.json` v datovém adresáři, restart serveru portfolio zamkne.

**Zapomenutý PIN:** smažte soubor `~/umbrel/app-data/finterm-terminal/data/pin.json` a restartujte FinTerm. Data portfolia zůstanou zachována a při příštím otevření stránky nastavíte nový PIN. Poškozený `pin.json` portfolio nechá zamčené a řeší se stejně.

**Data na disku nejsou šifrovaná.** PIN chrání přístup přes aplikaci, ne soubory: kdo má přístup k Umbrelu (SSH, záloha `app-data`), přečte `state.json` i bez PINu.

## Záloha

Nastavení → **Data & systém** → Export JSON. Na serveru: `finterm-terminal/data/state.json` (+ automatická záloha `state.json.bak` každých 12 h).
