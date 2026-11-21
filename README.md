# Stats Genius (DATAAPP)

A minimal web chat that answers questions with **live official statistics** from
**Statistics Sweden (SCB)**, **Statistics Norway (SSB)**, **Eurostat**, the UK's **Nomis** and **ONS** APIs, Germany's **Destatis** (GENESIS-Online), and the central banks of Sweden (**Sveriges Riksbank**) and Norway (**Norges Bank**), and the **European Central Bank**, using Mistral's
`mistral-small-latest` through the official TypeScript SDK (`@mistralai/mistralai`).
The model calls the statistics APIs as tools: it searches tables, reads their metadata
to pick valid codes, then fetches the data.

```
src/server.ts     node:http server: serves the UI, POST /api/chat, GET /api/headline
src/chat.ts       Mistral chat with a tool-calling loop (SCB + SSB + Eurostat + Nomis + ONS + Destatis + Riksbank + Norges Bank + ECB tools)
src/scb.ts        SCB PxWebApi v2 client  -> scb_search_tables, scb_get_table_metadata, scb_get_data
src/ssb.ts        SSB PxWebApi v0 client  -> ssb_search_tables, ssb_get_table_metadata, ssb_get_data
src/eurostat.ts   Eurostat API client     -> eurostat_search_datasets, eurostat_get_dataset_metadata, eurostat_get_data
src/nomis.ts      Nomis API v01 client    -> nomis_search_datasets, nomis_get_dataset_metadata, nomis_get_data
src/ons.ts        ONS beta API client     -> ons_search_timeseries, ons_get_timeseries, ons_search_datasets, ons_get_dataset_metadata, ons_get_data
src/genesis.ts    Destatis GENESIS client -> destatis_search_tables, destatis_get_table_metadata, destatis_get_data
src/riksbank.ts   Riksbank SWEA + SWESTR + Monetary Policy Data -> riksbank_search_series, riksbank_get_rates, riksbank_get_forecast
src/norgesbank.ts Norges Bank SDMX REST client -> norgesbank_get_structure, norgesbank_get_data
src/ecb.ts        ECB Data Portal SDMX REST client -> ecb_find_series, ecb_get_data
src/sdmx.ts       SDMX-JSON -> readable series (shared by Norges Bank and ECB)
src/jsonstat.ts   JSON-stat2 -> readable rows (shared by all sources)
public/index.html Dependency-free chat UI
```

## Run locally

Requires Node.js 20.6 or newer.

```bash
npm install
cp .env.example .env      # Windows PowerShell: Copy-Item .env.example .env
# edit .env and set MISTRAL_API_KEY=...
npm run dev               # open http://localhost:3000
```

- `npm start` runs it without watch mode.
- `npm run typecheck` runs `tsc --noEmit`.

Example questions:
- "What was the population of Sweden in the latest month, by sex?"
- "Compare the latest population of Norway and Sweden."
- "What is the latest unemployment rate in Sweden, Norway and the EU?"
- "How many people claim unemployment benefits in Manchester and London, compared with a year ago?"
- "What is the Riksbank's policy rate, and what does the Riksbank expect for CPIF inflation next year?"
- "Compare the policy rates and 10-year government bond yields of Sweden and Norway."
- "What is the ECB deposit rate, and what do professional forecasters expect for euro area inflation in 2027?"

## Keeping the API key safe

- The key is read only on the server, from `.env` (`process.env.MISTRAL_API_KEY`).
- `.env` is in `.gitignore`. Only `.env.example`, which has no secrets, is committed.
- The browser only talks to `/api/chat`. The key is never sent to the client or written to the logs.
  Errors from Mistral come back as a generic `502` with the status code only.

## Usage limits and hosting (iOS / Android app backend)

The app is meant to become an iOS/Android app. The mobile app talks to this server, which holds the API keys,
so the server must be protected once it's on the internet:

- **Network:** by default the server listens only on `127.0.0.1`, this computer. Set `HOST=0.0.0.0` when hosting it.
  Behind a hosting proxy or load balancer, also set `TRUST_PROXY=1` so users are identified by `X-Forwarded-For`.
- **Limits on `POST /api/chat`:** `CHAT_LIMIT_PER_MINUTE` (default 6) and `CHAT_LIMIT_PER_DAY` (60) per user, plus
  `CHAT_LIMIT_GLOBAL_DAY` (2000) across all users as a hard cap on the Mistral bill. Over the limit, the server answers
  `429` with `Retry-After` and a readable message. The counters are kept in memory, which is fine for one server.
  With several servers, move them to a shared store such as Redis.
- **Retries:** temporary Mistral errors (429 and 5xx, connection drops) are retried with exponential backoff for up to
  about 20 seconds. If it still fails, the user sees "The AI service is busy right now" instead of an error code.

**Reporting answers (Google Play's rule for AI-generated content):** every answer has a "Report a problem" link.
Users choose a reason (wrong number or period, wrong source, inappropriate, other) and can add a comment. Reports are saved
to `data/reports.jsonl` (gitignored), with the question, the answer and the tools used, and without any IP address. Each user
can send at most 20 reports per day. The page shows the disclaimer: "We only use official databases for the answers and data we
report, but the answers are generated by AI and may contain mistakes. Check the source." The model is told to state only
numbers from the fetched data, never from its own knowledge.

Still to do before going to the stores: host the server (with HTTPS), point the app at its URL, wrap the UI with
Capacitor (or a similar tool) for iOS and Android, and set `RIKSBANK_API_KEY` (see below). Questions are sent to Mistral (EU).

## Data sources

| | Statistics Sweden (SCB) | Statistics Norway (SSB) | Eurostat | Nomis (UK, ONS) |
|---|---|---|---|---|
| API | PxWebApi v2 | PxWebApi v0 (StatBank) | Statistics API (JSON-stat 2.0) + catalogue + SDMX 2.1 structure | Nomis API v01 (JSON-stat) |
| Base URL | `https://api.scb.se/OV0104/v2beta/api/v2` | `https://data.ssb.no/api/v0/{en,no}` | `https://ec.europa.eu/eurostat/api/dissemination` | `https://www.nomisweb.co.uk/api/v01` |
| Docs | [scb.se open data API](https://www.scb.se/en/services/open-data-api/) | [ssb.no/api/pxwebapi](https://www.ssb.no/api/pxwebapi) | [Getting started](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started), [detailed guidelines](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines) | [nomisweb.co.uk/api/v01/help](https://www.nomisweb.co.uk/api/v01/help) |
| License | CC0 | CC BY 4.0, credit "Statistics Norway" | Free reuse, credit "Source: Eurostat" | Crown Copyright, Open Government Licence; credit "Source: ONS, via Nomis" |
| Limits | 30 calls / 10 s per IP, 150,000 cells per request | ~30 queries / min, 800,000 cells per request | Very large queries are processed asynchronously, so keep filters tight | 25,000 cells per request (more with optional `NOMIS_UID`) |
| Key | none | none | none | none (optional `NOMIS_UID`) |

Base URLs can be overridden with `SCB_API_BASE` / `SSB_API_BASE` / `EUROSTAT_API_BASE` / `NOMIS_API_BASE` / `ONS_API_BASE` in `.env`.

Which source the model uses: SCB for Sweden only, SSB for Norway only, Nomis for UK jobs, population and Census, ONS for UK prices, GDP
and other economic data (Eurostat has no current UK data),
and Eurostat for other European countries, the EU or euro area, and cross-country comparisons, because Eurostat's figures are harmonised.

How missing selections are handled:
- **SCB:** variables you leave out are filled from the table's `/defaultselection`, so a mandatory variable never causes a 400.
- **SSB:** variables you leave out that are marked *elimination* get summed by SSB. Mandatory ones default to the latest period (`top 1`) or to all values.
- **Eurostat:** time defaults to the latest period. If that period has no values for the selection yet (countries
  publish at different times), the app looks back 6 periods instead. Search runs on the catalogue
  (table of contents), which is downloaded once and kept for 24 hours. Dataset structures are also kept for 24 hours.
  Eurostat freezes replaced datasets: their titles end in a closed range such as `(1997-2025)`, or their data stops early.
  Search ranks those last and marks them "Not updated any more". In 2026 inflation (HICP) moved to ECOICOP 2:
  use `prc_hicp_minr` (`unit=RCH_A`, `coicop18=TOTAL`), because `prc_hicp_manr` and `prc_hicp_aind` stop at 2025.
- **Nomis:** geography defaults to the UK (`K02000001`), time to `latest`, and other dimensions left out use Nomis's
  `default` code (usually the total). GSS codes such as `E08000003` (Manchester) work. A geography search lists
  councils and regions before small statistical areas. The dataset list (about 1,600 datasets) starts downloading when the
  server starts and is kept for 24 hours.

### UK Office for National Statistics (ONS) API

- Base URL `https://api.beta.ons.gov.uk/v1`, open, no key. Crown Copyright, Open Government Licence ("Source: Office for National Statistics").
- About 340 datasets, for example `cpih01` (CPIH), `gdp-to-four-decimal-places` (monthly GDP), `retail-sales-index`, `weekly-deaths-region`.
- **Freshness varies a lot by dataset.** In November 2026, monthly GDP ran to June 2026, CPIH and retail sales stopped at
  January 2026, and some datasets haven't been updated since 2022–2024. Every answer states the dataset's release date.
- The API takes one code per dimension and allows `*` on one dimension. The app makes time the wildcard and returns
  the latest 13 periods, so a year-on-year change can be worked out. Dimensions left out default to the UK or total.
  Several codes for one dimension are sent as separate requests (12 at most).
- CPIH comes as an index. The model works out the annual inflation rate itself and says that it did.
- **Headline time series (CDIDs) are current.** Tools `ons_search_timeseries` and `ons_get_timeseries` use the search API
  (`/v1/search?content_type=timeseries`) and the series data on `www.ons.gov.uk/{uri}/data`. Examples: `L55O` (CPIH annual
  rate, October 2026 = 3.7%, released 18 November 2026), `D7G7` (CPI annual rate), `MGSX` (unemployment rate), `IHYQ` (GDP growth).
  The model uses these first for UK headline figures.
- Rate limits (from [developer.ons.gov.uk/bots](https://developer.ons.gov.uk/bots/)): 120 requests per 10 s and 200 per minute.
  The app sends a generic User-Agent, as ONS asks.

### Germany: Destatis GENESIS-Online (needs a free API token)

1. Register for free at [GENESIS-Online](https://www-genesis.destatis.de), log in, and copy your token from
   **Webservice-Schnittstelle (API)**.
2. Add it to `.env` (never commit it): `DESTATIS_API_TOKEN=your-token`
3. Restart `npm run dev`.

Without a token the Destatis tools are switched off, and German questions are answered from Eurostat.

- REST/JSON API at `https://genesis.destatis.de/genesisWS/rest/2020/`. POST only (GET was switched off on 30 June 2025).
  The token goes in the `username` header with an empty `password`, so it never appears in URLs or logs.
  Parameters follow the OpenAPI spec (`/genesisWS/rest/2020/GOJsonApi.json`, shown in the
  [Swagger UI](https://genesis.destatis.de/genesisWS/swagger-ui/index.html)).
- Tools: `find/find` to search, `metadata/table` and `catalogue/values2variable` for structure and codes, and
  `data/tablefile` for data. ZIP responses are unpacked in memory.
- Data comes as `datencsv` (the table layout), not the flat `ffcsv`. In `ffcsv` the measure names are cut short: in table
  61111-0002, "change on previous month" and "change on previous year's month" are both labelled just "in".
  `datencsv` keeps full measure names, units and the table's footnotes. Each result also includes `latest`: the newest value
  and period for each series.
- Table metadata has an "Updated" date, but it's when the table's structure last changed, not a data release date.
- A token can only read, so the queue (`job=true`) isn't available. Requests are limited to 40,000 values, which is
  plenty for chat answers. The app fetches the last 2 years and keeps the newest 13 periods that have values.
- © Statistisches Bundesamt (Destatis). Reuse allowed with source: "Source: Destatis, GENESIS-Online".

### Sweden: Sveriges Riksbank (no key needed; a free key is recommended for hosting)

Three open APIs from the [Riksbank API portal](https://developer.api.riksbank.se), base `https://api.riksbank.se`:

- **SWEA** (`/swea/v1`): interest rates and exchange rates, 117 series: policy, deposit and lending rate (`SECBREPOEFF`...),
  Swedish treasury bills and government/mortgage bond yields, international market rates and bond yields, SEK exchange
  rates (`SEKEURPMI`, `SEKUSDPMI`, ..., all in SEK per 1 unit) and the KIX index. Daily values via
  `/Observations/{id}/{from}/{to}`, latest via `/Observations/Latest/{id}`, and W/M/Q/Y averages via
  `/ObservationAggregates/{id}/{period}/{from}/{to}`. The exchange rates are indicative and for information only.
- **SWESTR** (`/swestr/v1`, portal id `tora-api`): the overnight reference rate `SWESTR`, compounded averages
  `SWESTRAVG1W` to `SWESTRAVG6M`, and `SWESTRINDEX`.
- **Monetary Policy Data** (`/monetary_policy_data/v1`): the 24 series behind the Monetary Policy Report (GDP, CPIF, CPI,
  unemployment, policy rate path, wages, KIX), per policy round (`2026:3` ...). Each round has a forecast cut-off date:
  values up to it were known then, values after it are the Riksbank's forecast. The tool returns both, separately.

Without a key the Riksbank allows about **5 requests per minute per IP address**, shared across these APIs. The app caches
results (series lists 12 hours, data 10 minutes) and waits and retries once on a short `429`. On a hosted server all users
share one IP, so get a free subscription key on the portal and set `RIKSBANK_API_KEY` in `.env`. It is sent as the
`Ocp-Apim-Subscription-Key` header. Credit: "Source: Sveriges Riksbank".

### Norway: Norges Bank (no key)

Norges Bank's open data is an SDMX REST API at `https://data.norges-bank.no/api` (the
[query builder](https://query.norges-bank.no/en) builds URLs; the
[SDMX REST cheat sheet](https://github.com/sdmx-twg/sdmx-rest/blob/master/doc/rest_cheat_sheet.pdf) explains the syntax).
Data: `GET /data/{dataset}/{key}?format=sdmx-json&locale=en` plus `startPeriod`, `endPeriod` or `lastNObservations`.
The key is the dimension codes in the dataset's order joined by `.`, with `+` for several codes and an empty position for all.

| Dataset | Key order | Example |
|---|---|---|
| `IR` policy rate | FREQ.INSTRUMENT_TYPE.TENOR.UNIT_MEASURE | `B.KPRA.SD.R` (policy rate; `RR` reserve rate, `OL` overnight lending rate) |
| `SHORT_RATES` | FREQ.INSTRUMENT_TYPE.TENOR.UNIT_MEASURE | `B.NOWA.ON.R` (NOWA) |
| `EXR` exchange rates | FREQ.BASE_CUR.QUOTE_CUR.TENOR | `B.EUR+USD.NOK.SP`; `M` = monthly average |
| `GOVT_GENERIC_RATES` | FREQ.TENOR.INSTRUMENT_TYPE | `B.10Y.GBON` (10-year bond), `B.3M.TBIL` (treasury bill) |
| `GOVT_ZEROCOUPON` | FREQ.TENOR | `B.10Y` |

The tools also offer `GOVT_KEYFIGURES`, `FINANCIAL_INDICATORS` and `REGNET`. Large transaction-level datasets
(`MONEY_MARKET`, `GOVT_IRS`, `CBC_*`) are left out. Some exchange rates are quoted per 100 units (e.g. SEK, DKK, JPY:
attribute `UNIT_MULT` = Hundreds); the tool returns this as `unit`, e.g. "NOK per 100 SEK". Credit: "Source: Norges Bank".

### Euro area: European Central Bank (no key)

The [ECB Data Portal](https://data.ecb.europa.eu) API is SDMX REST 2.1 at `https://data-api.ecb.europa.eu/service/`
([overview](https://data.ecb.europa.eu/help/api/overview)). Data: `GET /data/{dataset}/{key}?format=jsondata` plus
`startPeriod`, `endPeriod` or `lastNObservations`. The key syntax is the same as Norges Bank's (`.`, `+`, empty = all).
Structure queries (`/dataflow`, `/datastructure`) only return XML, so `src/ecb.ts` lists the main datasets with their key
order, and `ecb_find_series` shows the key order and codes for any wildcard key (with each series' latest value).

| Dataset | Example key | What |
|---|---|---|
| `FM` | `B.U2.EUR.4F.KR.DFR.LEV` | Deposit facility rate (`MRR_FR` main refinancing, `MLFR` marginal lending), dated on the day of change |
| `EST` | `B.EU000A2X2A25.WT` | €STR |
| `EXR` | `D.USD+GBP.EUR.SP00.A` | Euro reference rates, units of foreign currency per EUR; `M` = monthly average |
| `HICP` | `M.U2.N.000000.4D0.ANR` | Inflation, euro area (`U2`) or a country (`DE`, `FR`...) |
| `YC` | `B.U2.EUR.4F.G_N_A.SV_C_YM.SR_10Y` | AAA euro area government yield curve, 10-year spot rate |
| `IRS` | `M.DE+FR+IT.L.L40.CI.0000.EUR.N.Z` | 10-year government bond yields per EU country |
| `BSI` | `M.U2.Y.V.M30.X.I.U2.2300.Z01.A` | M3 annual growth |
| `MIR` | `M.U2.B.A2C.AM.R.A.2250.EUR.N` | Cost of borrowing for house purchase |
| `SPF` | `Q.U2.HICP.POINT.2027.Q.AVG` | Survey of Professional Forecasters, average HICP forecast for 2027 |

Note: the old `ICP` dataset stops at December 2025. Current HICP figures are in `HICP`, with data provider `4D0`.
Responses over 6 MB are refused, so very broad keys ask the model to narrow them. Credit: "Source: ECB Data Portal".

The PxTools [installation guide](https://www.pxtools.net/PxWebApi/documentation/installation/)
covers self-hosting PxWebApi on IIS. This app doesn't need that, because it calls the hosted APIs.
