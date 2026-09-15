# Logistics Data Forge

AI-powered repair-invoice extraction for commercial trucking fleets, running on the
**Anthropic Claude API**. Drop in a stack of repair invoice PDFs, and the app verifies
each one is a heavy-duty truck repair (not a trailer or a fuel receipt), pulls the
invoice number, date, unit number, cost and a dispatch-shorthand note, and exports a
formatted Excel workbook.

## What it does

- **Truck-only verification** — recognizes Freightliner, Peterbilt, Volvo, Kenworth,
  International, Mack, Hino and Western Star. Trailer repairs (Wabash, Great Dane,
  Utility, `T`-prefixed units) are excluded, including the trailer portion of a mixed invoice.
- **Native PDF reading** — the PDF goes to Claude as a document, so scanned layouts and
  multi-column invoices survive intact; no lossy text pre-extraction.
- **Non-repair pre-screening** — pure diesel receipts and `SO-` sales orders are skipped
  locally before any API call is made, so they cost nothing.
- **Note normalization** — service lines are compressed into fleet shorthand
  (`PM SERVICE`, `NOX SENSOR`, `INSID BUMPER`, `STEER & DRIVE TIRE REPLACE`, `L1 BRACKET`),
  with routine PM components (filters, lube, engine oil) folded into `PM SERVICE`.
- **Offline fallback** — if the API is unreachable or the key is rejected, a rule-based
  parser still produces rows from the PDF text rather than failing the batch.
- **Excel export** — one sheet per batch, a titled block per source PDF, spacer rows
  between blocks, and preset column widths.
- **Optional Google Drive import** — browse and pull invoice PDFs straight from Drive.

## Requirements

- Node.js 20 or newer
- An Anthropic API key — <https://console.anthropic.com/settings/keys>

## Setup

```bash
npm install
cp .env.example .env     # then paste your key into ANTHROPIC_API_KEY
npm run dev              # http://localhost:3000
```

For production:

```bash
npm run build
npm start
```

## Configuration

Everything is read from `.env` (never hardcoded, never committed):

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `ANTHROPIC_API_KEY` | yes | — | Your key from the Anthropic Console. |
| `ANTHROPIC_MODEL` | no | `claude-opus-5` | `claude-sonnet-5` is cheaper and faster; `claude-haiku-4-5` cheapest. |
| `ANTHROPIC_EFFORT` | no | `medium` | Reasoning depth: `low`, `medium`, `high`, `xhigh`, `max`. Raise it for messy scans. |
| `ANTHROPIC_WORKSPACE_ID` | only for org-level keys | — | A key created inside a workspace carries its scope already. An org-level key must name a workspace on every request, or the API returns "not scoped to a workspace". |
| `ANTHROPIC_BASE_URL` | no | — | Only for a proxy or gateway. |
| `PORT` | no | `3000` | |
| `VITE_FIREBASE_*` | no | — | Enables the Google Drive tab. Left blank, the tab explains it is switched off and local upload works regardless. |

The server reads these per request, so changing `.env` takes effect without a restart in dev.

## How extraction works

1. **Pre-screen** (local, free) — `pdf-parse` pulls the text and checks for fuel-only
   receipts and non-repair sales orders. Matches return immediately without calling the API.
2. **Claude** — the PDF is sent as a base64 `document` block with a JSON-schema
   `output_config`, so the response is schema-valid JSON rather than prose to be regexed.
   If the primary model is overloaded or rate limited, the request retries on
   `claude-sonnet-5` then `claude-haiku-4-5`. Authentication failures and depleted credit
   stop the queue immediately instead of burning three calls on the same error.
3. **Fallback** — if every model fails, the rule-based extractor parses the PDF text directly.
4. **Normalization** — notes are cleaned and `RESPONSIBLE`, `NAME` and `WO#` are forced
   to null on every row, as the company workbook format requires.

## Excel output

Columns: `#`, `INVOICE#`, `DATE`, `UNIT`, `RESPONSIBLE`, `NAME`, `COST`, `NOTE`, `WO#`.
Column A is left blank as a margin, each source PDF gets a title row above its own header
block, and two blank rows separate blocks. The filename comes from the Active Batch field
in the header.

## API

| Route | Purpose |
| --- | --- |
| `POST /api/extract` | Body `{ base64 }` — one PDF. Returns `{ isTruckInvoice, detectedBrand, reasons, items[] }`. |
| `GET /api/config` | Which model is wired up and whether a key is present. Drives the footer status. |

## Tech stack

React 19 · Vite 6 · Tailwind CSS v4 · Express · TypeScript · `@anthropic-ai/sdk` · SheetJS · Firebase Auth (optional)
