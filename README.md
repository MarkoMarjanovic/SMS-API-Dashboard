# Telesign Usage Dashboard

A self-hosted dashboard for **any Telesign customer** to track spend and usage across Telesign products (SMS, SMS Verify, Voice Verify, Voice, Phone ID, Intelligence, WhatsApp), see which countries the money goes to, and run SMS campaigns with consent, opt-out handling and spending controls.

Everything (data, credentials, code) stays in accounts you own: the code in your repo, the data in your Postgres database (Neon in production, or embedded PGlite locally).

## Features

| Area | What you get |
|---|---|
| **Overview** | Spend, transactions, delivery rate and cost per SMS with period-over-period change; daily/weekly spend by product; month-to-date budget with month-end forecast; fixed fees; top countries; world map |
| **Countries** | Choropleth map and sortable table (spend, share, volume, segments, delivery, Verify conversion, blocked). Drill-down per country with per-product trend, delivery outcomes, your rate, plus one-click cap or block |
| **Message log** | Every request (sent, imported or blocked) with status code, plain-English explanation and fix advice, cost and its source; filters; CSV export; quick send (SMS, Verify, Phone ID) |
| **Verify & fraud** | Verification conversion per country (24h / 7d / period), spend on codes never entered, and SMS-pumping risk flags with a one-click country block |
| **Campaigns** | Personalised templates (`{first_name}`, `{field\|fallback}`, any imported column), live segment/encoding counter, audience by tag/country, automatic exclusion of opted-out or non-consented contacts, cost and budget preview, test sends, scheduling, rate limiting, quiet hours, pause/resume/cancel, per-campaign delivery, cost, replies and opt-outs |
| **Contacts & consent** | CSV import with column mapping, consent status/source/date, tags, custom fields; consent-record export; suppression list |
| **Inbox** | Two-way conversations; STOP/START keywords update the suppression list automatically; replies are costed like any send |
| **Spending controls** | Monthly and daily budgets with optional hard stop, per-country monthly caps, allow-list / block-list of destinations, quiet hours, opt-out keywords |
| **Alerts** | 80% / 100% budget and cap alerts, per-country spend spikes, low Verify conversion (SMS pumping), first traffic to a new country; optional Slack/Teams webhook |
| **Rate card & fees** | Per-product, per-country prices + carrier pass-through fees, CSV import, re-price history; fixed/recurring fees (numbers, 10DLC/toll-free/sender registrations, support) |
| **Cost calculator** | GSM-7 vs UCS-2 explanation, highlights characters that force Unicode, one-click GSM-safe rewrite, campaign cost estimate by country split vs a target price (e.g. "< $0.01 per message") |
| **Reports** | Monthly usage + fees by product and country × product, 12-month trend, CSV and print/PDF |
| **Import usage** | Import Telesign Portal / invoice exports (per transaction or aggregated) so traffic sent outside the dashboard is included; undo per import |
| **Gateway API** | Your own systems send SMS / Verify / Phone ID *through* the dashboard with a bearer token, so every request is logged, costed and checked against your limits |
| **Admin** | Admin/viewer roles, API tokens, Telesign connection test, callback signature verification, audit log, demo data reset / go-live |

## Quick start

Requires **Node.js 20+**. No database server needed locally (embedded Postgres); set `DATABASE_URL` to use Neon or any Postgres.

```bash
npm install
npm run build      # build the web UI
npm start          # http://localhost:4000
```

Open the URL, create the first admin account and choose **Explore with demo data** (six months of realistic sample traffic, including a simulated SMS-pumping attack) or **Start empty**.

Development with hot reload: `npm run dev` (UI on http://localhost:5173, API on :4000).
Tests: `npm test`.

## Going live

1. **Settings → Data → Remove demo data & go live.**
2. **Settings → Telesign connection**: enter your Customer ID and API key (or set `TELESIGN_CUSTOMER_ID` / `TELESIGN_API_KEY` in `.env`), then **Save & test connection**.
3. **Rate card & fees**: enter or import your contracted prices per country and product, plus fixed fees. All costs are computed from these unless Telesign returns a price on the transaction.
4. **Spending controls**: set budgets, enable hard stop, and preferably switch to an **allow list** of the countries you actually serve.
5. Deploy behind HTTPS, set `PUBLIC_URL` in `.env`, and ask Telesign to send **delivery reports and inbound messages** to `https://<your-host>/api/callbacks/telesign`. Enable *Require valid Telesign signature*. Without callbacks, pending messages are polled after 2 minutes.
6. Import your contacts with consent information, send a **test** campaign to internal numbers, then a small real campaign before scaling.
7. Point other systems to the **Gateway API** (Settings → Gateway API & tokens) so their traffic is tracked and controlled too, or import their usage regularly.

See [docs/WALKTHROUGH.md](docs/WALKTHROUGH.md) for the operator guide.

## Database

Postgres everywhere:

- **Production / Vercel:** set `DATABASE_URL` (e.g. a [Neon](https://neon.com) connection string, pooled endpoint).
- **Local / tests:** with no `DATABASE_URL`, an embedded Postgres ([PGlite](https://pglite.dev)) is stored in `data/pglite`. Nothing to install.

The schema is created automatically on first start. `npm run seed:demo` loads demo data into whichever database is configured.

## Hosting

### Vercel + Neon (recommended)

[vercel.json](vercel.json) serves the built UI from Vercel's CDN and every `/api/*` request through one serverless function ([api/index.js](api/index.js)).

1. Import the GitHub repo in Vercel (framework preset: *Other*; build settings come from `vercel.json`).
2. Environment variables: `DATABASE_URL` (Neon, pooled), `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TELESIGN_CUSTOMER_ID`, `TELESIGN_API_KEY`, `PUBLIC_URL` (the Vercel URL), `CRON_SECRET` (long random string).
3. Deploy. Load demo data once with `npm run seed:demo` locally against the same `DATABASE_URL`, or start empty.

**Background work on serverless.** There is no always-on process, so campaign sending, delivery-status polling and alert checks run in short idempotent *ticks*:
- while anyone has the dashboard open, it triggers a tick every 20 s;
- Vercel Cron calls `/api/cron/tick` (the Hobby plan allows **once a day**);
- for unattended campaigns and timely alerts, point a free external scheduler (e.g. cron-job.org) at `https://<app>/api/cron/tick?key=<CRON_SECRET>` every minute.

Ticks are safe to run concurrently: campaign send credit is time-based and queue rows are claimed with `FOR UPDATE SKIP LOCKED`, so nothing is sent twice.

### Container hosts (Render, Railway, Fly.io)

The [Dockerfile](Dockerfile) runs `server/index.js`, which serves the UI and runs the scheduler every 5 seconds. Set `DATABASE_URL` to keep data in Postgres; otherwise PGlite stores it under `/app/data` (mount a persistent disk). [render.yaml](render.yaml) is a Render Blueprint.

**Trial Telesign accounts** can only send to phone numbers verified in the Telesign Portal; other numbers fail with "has not been verified for this trial account" (logged as failed, cost 0).

## How costs are calculated (and the limits of that)

Telesign does not offer a public usage/billing API, so the dashboard builds its numbers from three sources:

1. **Requests sent through the dashboard** (campaigns, replies, quick send, Gateway API): logged with country, segments and status, and priced at send time. If a Telesign response includes a price, that is used (`cost_source = telesign`), otherwise your rate card (`rate_card`).
2. **Delivery callbacks / status polling** update the status of each message.
3. **CSV imports** of Portal or invoice data for traffic sent outside the dashboard (`cost_source = invoice` when the file has a cost column).

Your Telesign invoice is the source of truth. Use the monthly report to reconcile it, and *Re-price history* after rate changes. Spending controls can only **block** traffic that flows through the dashboard; also set limits in the Telesign Portal for direct traffic.

**SMS billing:** GSM-7 messages carry 160 characters (153 per part when split); any Unicode character (emoji, smart quotes, en dash, many accented letters) switches the whole message to UCS-2 with 70 (67) characters per segment. Every segment is billed. The calculator and all editors show this live.

## Configuration (`.env`)

See [.env.example](.env.example): `DATABASE_URL`, `PUBLIC_URL`, `TELESIGN_CUSTOMER_ID`, `TELESIGN_API_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CRON_SECRET`, `TRUST_PROXY`, `PORT`.

## Security notes

- Passwords hashed with scrypt; sessions are HttpOnly SameSite cookies (Secure when `PUBLIC_URL` is https); login rate limiting.
- API tokens are stored hashed and shown once; revocable.
- The Telesign API key is never sent back to the browser (masked).
- Database connections use TLS with certificate verification. Neon keeps point-in-time backups; for PGlite back up `data/pglite`.

## Project layout

```
api/           Vercel serverless entry point
server/        Express app (app.js), local server (index.js), Postgres layer (db.js), scheduler ticks, Telesign client, pricing, controls, demo data
  routes/      auth, analytics, messaging (log/campaigns/contacts/inbox), admin, public (gateway + callbacks)
shared/        Code used by server and browser: SMS segment math, products, status codes
client/        React (Vite) UI: pages/, components/
tests/         node:test unit + integration tests
```
