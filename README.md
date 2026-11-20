# Nordic Stats Chat (DATAAPP)

A minimal web chat that answers questions with **live official statistics** from
**Statistics Sweden (SCB)** and **Statistics Norway (SSB)**, using Mistral's
`mistral-small-latest` through the official TypeScript SDK (`@mistralai/mistralai`).
The model calls the statistics APIs as tools: it searches tables, reads their metadata
to pick valid codes, then fetches the data.

```
src/server.ts     node:http server: serves the UI + POST /api/chat
src/chat.ts       Mistral chat with a tool-calling loop (SCB + SSB tools)
src/scb.ts        SCB PxWebApi v2 client  -> scb_search_tables, scb_get_table_metadata, scb_get_data
src/ssb.ts        SSB PxWebApi v0 client  -> ssb_search_tables, ssb_get_table_metadata, ssb_get_data
src/jsonstat.ts   JSON-stat2 -> readable rows (shared by both)
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

## Keeping the API key safe

- The key is read only on the server, from `.env` (`process.env.MISTRAL_API_KEY`).
- `.env` is in `.gitignore`. Only `.env.example`, which has no secrets, is committed.
- The browser only talks to `/api/chat`. The key is never sent to the client or written to the logs.
  Errors from Mistral come back as a generic `502` with the status code only.

## Data sources

| | Statistics Sweden (SCB) | Statistics Norway (SSB) |
|---|---|---|
| API | PxWebApi v2 | PxWebApi v0 (StatBank) |
| Base URL | `https://api.scb.se/OV0104/v2beta/api/v2` | `https://data.ssb.no/api/v0/{en,no}` |
| Docs | [scb.se open data API](https://www.scb.se/en/services/open-data-api/) | [ssb.no/api/pxwebapi](https://www.ssb.no/api/pxwebapi) |
| License | CC0 | CC BY 4.0, credit "Statistics Norway" |
| Limits | 30 calls / 10 s per IP, 150,000 cells per request | ~30 queries / min, 800,000 cells per request |
| Key | none | none |

Both base URLs can be overridden with `SCB_API_BASE` / `SSB_API_BASE` in `.env`.

How missing selections are handled:
- **SCB:** variables you leave out are filled from the table's `/defaultselection`, so a mandatory variable never causes a 400.
- **SSB:** variables you leave out that are marked *elimination* get summed by SSB. Mandatory ones default to the latest period (`top 1`) or to all values.

The PxTools [installation guide](https://www.pxtools.net/PxWebApi/documentation/installation/)
covers self-hosting PxWebApi on IIS. This app doesn't need that, because it calls the hosted APIs.
