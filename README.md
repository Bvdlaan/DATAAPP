# Nordic Stats Chat (DATAAPP)

A minimal web chat that answers questions with **live official statistics** from
**Statistics Sweden (SCB)**, **Statistics Norway (SSB)**, **Eurostat** and **Nomis** (UK, ONS), using Mistral's
`mistral-small-latest` through the official TypeScript SDK (`@mistralai/mistralai`).
The model calls the statistics APIs as tools: it searches tables, reads their metadata
to pick valid codes, then fetches the data.

```
src/server.ts     node:http server: serves the UI, POST /api/chat, GET /api/headline
src/chat.ts       Mistral chat with a tool-calling loop (SCB + SSB + Eurostat + Nomis tools)
src/scb.ts        SCB PxWebApi v2 client  -> scb_search_tables, scb_get_table_metadata, scb_get_data
src/ssb.ts        SSB PxWebApi v0 client  -> ssb_search_tables, ssb_get_table_metadata, ssb_get_data
src/eurostat.ts   Eurostat API client     -> eurostat_search_datasets, eurostat_get_dataset_metadata, eurostat_get_data
src/nomis.ts      Nomis API v01 client    -> nomis_search_datasets, nomis_get_dataset_metadata, nomis_get_data
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

## Keeping the API key safe

- The key is read only on the server, from `.env` (`process.env.MISTRAL_API_KEY`).
- `.env` is in `.gitignore`. Only `.env.example`, which has no secrets, is committed.
- The browser only talks to `/api/chat`. The key is never sent to the client or written to the logs.
  Errors from Mistral come back as a generic `502` with the status code only.

## Data sources

| | Statistics Sweden (SCB) | Statistics Norway (SSB) | Eurostat | Nomis (UK, ONS) |
|---|---|---|---|---|
| API | PxWebApi v2 | PxWebApi v0 (StatBank) | Statistics API (JSON-stat 2.0) + catalogue + SDMX 2.1 structure | Nomis API v01 (JSON-stat) |
| Base URL | `https://api.scb.se/OV0104/v2beta/api/v2` | `https://data.ssb.no/api/v0/{en,no}` | `https://ec.europa.eu/eurostat/api/dissemination` | `https://www.nomisweb.co.uk/api/v01` |
| Docs | [scb.se open data API](https://www.scb.se/en/services/open-data-api/) | [ssb.no/api/pxwebapi](https://www.ssb.no/api/pxwebapi) | [Getting started](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-getting-started), [detailed guidelines](https://ec.europa.eu/eurostat/web/user-guides/data-browser/api-data-access/api-detailed-guidelines) | [nomisweb.co.uk/api/v01/help](https://www.nomisweb.co.uk/api/v01/help) |
| License | CC0 | CC BY 4.0, credit "Statistics Norway" | Free reuse, credit "Source: Eurostat" | Crown Copyright, Open Government Licence; credit "Source: ONS, via Nomis" |
| Limits | 30 calls / 10 s per IP, 150,000 cells per request | ~30 queries / min, 800,000 cells per request | Very large queries are processed asynchronously, so keep filters tight | 25,000 cells per request (more with optional `NOMIS_UID`) |
| Key | none | none | none | none (optional `NOMIS_UID`) |

Base URLs can be overridden with `SCB_API_BASE` / `SSB_API_BASE` / `EUROSTAT_API_BASE` / `NOMIS_API_BASE` in `.env`.

Which source the model uses: SCB for Sweden only, SSB for Norway only, Nomis for the UK (Eurostat has no current UK data),
and Eurostat for other European countries, the EU or euro area, and cross-country comparisons, because Eurostat's figures are harmonised.

How missing selections are handled:
- **SCB:** variables you leave out are filled from the table's `/defaultselection`, so a mandatory variable never causes a 400.
- **SSB:** variables you leave out that are marked *elimination* get summed by SSB. Mandatory ones default to the latest period (`top 1`) or to all values.
- **Eurostat:** time defaults to the latest period. If that period has no values for the selection yet (countries
  publish at different times), the app looks back 6 periods instead. Search runs on the catalogue
  (table of contents), which is downloaded once and kept for 24 hours. Dataset structures are also kept for 24 hours.
- **Nomis:** geography defaults to the UK (`K02000001`), time to `latest`, and other dimensions left out use Nomis's
  `default` code (usually the total). GSS codes such as `E08000003` (Manchester) work. A geography search lists
  councils and regions before small statistical areas. The dataset list (about 1,600 datasets) starts downloading when the
  server starts and is kept for 24 hours.

The PxTools [installation guide](https://www.pxtools.net/PxWebApi/documentation/installation/)
covers self-hosting PxWebApi on IIS. This app doesn't need that, because it calls the hosted APIs.
