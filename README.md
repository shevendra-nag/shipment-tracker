<div align="center">

# Shipment Tracker

**One workspace for every shipment, from dispatch to delivery.**

A self-hosted shipment management platform for teams that need clear delivery timelines, reliable records, and a simple way to keep customers informed.

[![Tests](https://github.com/shevendra-nag/shipment-tracker/actions/workflows/ci.yml/badge.svg)](https://github.com/shevendra-nag/shipment-tracker/actions/workflows/ci.yml)
![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=nodedotjs&logoColor=white)
![SQLite](https://img.shields.io/badge/Database-SQLite-003B57?logo=sqlite&logoColor=white)
![Self-hosted](https://img.shields.io/badge/Deployment-Self--hosted-334155)

[Features](#features) · [Get started](#get-started) · [Configuration](#configuration) · [Docker deployment](#docker-deployment) · [Integrations](#integrations) · [Project structure](#project-structure)

</div>

---

## Overview

Shipment Tracker replaces scattered spreadsheets and manual status checks with a single, responsive operations dashboard. Create shipments, follow their progress, investigate exceptions, review delivery performance, and give customers a tracking link without exposing internal records.

**Start with manual tracking.** Connect [AfterShip](https://www.aftership.com/) for courier updates and [Resend](https://resend.com/) for email notifications when you need them. Both services are optional; the core application works without external API keys.

## Features

| Area | Capabilities |
| --- | --- |
| **Shipment management** | Create, edit, search, filter, sort, and delete shipments; track recipient, carrier, route, service, dates, and order references. |
| **Delivery timeline** | Record manual milestones and locations across six delivery statuses, with a chronological history for each shipment. |
| **Live courier integration** | Register individual shipments with AfterShip, pull carrier checkpoints, synchronize on a schedule, and process signed webhooks. |
| **Customer tracking** | Generate shareable tracking pages with delivery progress, latest location, estimated delivery, and milestone history. Rotate or revoke links at any time. |
| **Team access** | First-run admin setup, password-based sign-in, seven-day sessions, and admin/operator/viewer permissions. |
| **Analytics** | Review shipment activity, on-time delivery rates, overdue shipments, transit times, and carrier performance across selectable date ranges. |
| **CSV operations** | Export shipment records or preview, validate, and bulk-import up to 500 shipments per batch with duplicate detection. |
| **Notifications** | Send opt-in status-change emails through Resend, with queued delivery and retries. |
| **Branding** | Configure workspace name, initials, accent color, support email, tracking message, and a PNG/JPEG logo. |
| **Deployment** | Run directly on Node.js or use Docker Compose with persistent SQLite storage and GitHub Actions tests. |

### Delivery statuses

`Pending` → `Picked up` → `In transit` → `Out for delivery` → `Delivered`

`Exception` is available for delayed, failed, or otherwise interrupted deliveries. A shipment's status changes only when an operator records an event or a connected courier supplies an update.

### Team permissions

| Action | Admin | Operator | Viewer |
| --- | :---: | :---: | :---: |
| View shipments and reports | ✓ | ✓ | ✓ |
| Create or edit shipments | ✓ | ✓ | — |
| Add delivery milestones | ✓ | ✓ | — |
| Import shipments from CSV | ✓ | ✓ | — |
| Create tracking links and connect couriers | ✓ | ✓ | — |
| Delete shipments | ✓ | — | — |
| Manage team, branding, and integration settings | ✓ | — | — |

## Get started

### Requirements

- **Node.js 22.13.0 or newer** (Node.js 24 is also tested in CI)
- Git, if you want to clone the repository
- No external npm packages or separate database server

### 1. Download the project

```bash
git clone https://github.com/shevendra-nag/shipment-tracker.git
cd shipment-tracker
```

### 2. Start the server

```bash
npm start
```

Open **http://127.0.0.1:3000**. On the first visit, create an administrator account with a password of at least 12 characters.

That's enough to begin adding shipments and updating their statuses manually. SQLite is created automatically in the local `data/` directory.

For automatic reloads during development:

```bash
npm run dev
```

> [!NOTE]
> Node.js may print an experimental warning for its built-in SQLite module. The application uses `node:sqlite` and does not need an additional SQLite npm dependency.

## Configuration

Configuration is provided through environment variables. The repository contains `.env.example` as a reference; private `.env` files are excluded from Git.

To use a local environment file:

```bash
cp .env.example .env
# Edit .env with your own settings.
node --env-file=.env server/app.js
```

**Important:** Set `COOKIE_SECURE=false` when signing in over plain HTTP on localhost. Use `COOKIE_SECURE=true` when the application is accessed over HTTPS. Running `npm start` by itself does **not** automatically load `.env`.

| Variable | Purpose |
| --- | --- |
| `PORT` | HTTP port; defaults to `3000`. |
| `HOST` | Bind address; defaults to `127.0.0.1` outside Docker. |
| `DATA_DIR` | Directory containing the SQLite database; defaults to `./data`. |
| `COOKIE_SECURE` | Mark session cookies as HTTPS-only when set to `true`. |
| `ADMIN_SETUP_KEY` | Private first-run setup key; **required in production**, minimum 20 characters. |
| `PUBLIC_BASE_URL` | Public application origin (HTTPS in production), used for links in notification emails. |
| `AFTERSHIP_API_KEY` | Optional API key for courier tracking. |
| `AFTERSHIP_WEBHOOK_SECRET` | Optional secret for verifying AfterShip webhook signatures. |
| `TRACKING_SYNC_MINUTES` | Interval for scheduled courier synchronization; default `30`. |
| `RESEND_API_KEY` | Optional key for outgoing notification emails. |
| `RESEND_FROM_EMAIL` | Sender address configured for email delivery through Resend. |

Keep credentials outside source control. Never commit real API keys, the administrator setup key, or a local database.

## Docker deployment

The provided `Dockerfile` runs the application as an unprivileged user. Docker Compose stores data in a persistent named volume and exposes port `3000` **only on the host's loopback interface**.

```bash
cp .env.example .env
```

Before starting, edit `.env` and set a unique `ADMIN_SETUP_KEY` of at least 20 characters. For a public deployment, also set `COOKIE_SECURE=true` and `PUBLIC_BASE_URL` to your HTTPS origin.

```bash
docker compose up -d --build
```

Verify the server health endpoint:

```bash
curl http://127.0.0.1:3000/api/healthz
```

Expected response: `{"ok":true}`.

**Public access requires an HTTPS reverse proxy** (for example, Caddy or Nginx) that forwards requests to `127.0.0.1:3000` and preserves the original `Host` header. Use the HTTPS URL to sign in when secure cookies are enabled.

To view logs or stop the application:

```bash
docker compose logs -f shipment-tracker
docker compose down
```

> [!CAUTION]
> `docker compose down` preserves the named database volume; `docker compose down -v` removes it. Do **not** use `-v` unless you intentionally want to delete the stored data.

## Integrations

### Courier tracking with AfterShip

1. Add `AFTERSHIP_API_KEY` to the server environment and restart the application.
2. Create a shipment or open an existing one.
3. Use the shipment's tracking controls to connect it to AfterShip, supplying the supported carrier slug where needed.
4. Synchronize an individual shipment on demand, or let the background scheduler check connected shipments.
5. Optionally configure `AFTERSHIP_WEBHOOK_SECRET` and register the webhook endpoint at **`/api/webhooks/aftership`** with your public HTTPS domain.

AfterShip integration is **opt-in per shipment**. A manual shipment is not sent to the provider until you connect it. Carrier coverage, API access, and provider charges depend on your AfterShip account.

### Email notifications with Resend

1. Configure `RESEND_API_KEY` and `RESEND_FROM_EMAIL` in the server environment.
2. Set `PUBLIC_BASE_URL` if outgoing messages should contain customer tracking links.
3. Obtain recipient consent and enable **email opt-in** on the relevant shipment.
4. Record a status change or receive an update from a connected courier.

Only opted-in shipments with a recipient email can trigger notifications. Failed sends are retried through the application's persisted notification queue. Email delivery requires valid Resend credentials and an authorized sender address.

### Public tracking links

Enable public sharing from a shipment's details to create a unique tracking URL. You can rotate the token to invalidate old links or disable sharing entirely.

Public views show the shipment's tracking number, carrier, route cities, status, estimated dates, location, and tracking milestones. They **do not** expose recipient contact information, internal notes, order references, or package descriptions.

## Bulk import and reporting

### Import shipments

Open **Bulk import** and download the built-in CSV template. The required column headings are:

```text
Tracking number, Carrier, Recipient, Origin, Destination
```

Additional columns can include recipient email, service, weight, estimated delivery, order reference, notes, and email opt-in.

- Preview the CSV before committing any changes.
- Review row-specific validation errors and duplicates.
- Import up to **500 rows per batch**; the file limit is **600 KB**.
- Invalid rows prevent the entire batch from being imported.

The **All shipments** screen also provides CSV export.

### Analyze delivery performance

Open **Analytics** to compare the last **7, 30, 90, or 365 days**. Reports include shipment activity, overdue counts, delivery and exception rates, average transit duration, and carrier-level summaries. Some metrics require valid shipping, estimated delivery, or actual delivery dates and will remain unavailable when those records are missing.

## Data and backups

Shipment records, user accounts, sessions, tracking links, branding, and notification records are stored in **SQLite** under `DATA_DIR`. By default, the database file is `data/shipments.sqlite`. SQLite may also create `-wal` and `-shm` files while running.

- **Local setup:** Back up the entire `data/` directory after stopping the application, or use a consistent SQLite backup process.
- **Docker:** Back up the named `shipment_data` volume using a consistent backup method; avoid copying a live database without accounting for WAL files.
- **Upgrading:** Keep the existing data directory or Docker volume when replacing application code.
- **Legacy data:** On creation of a new database, the app can import an existing `shipments.json` from the same data directory.

The database, environment secrets, temporary files, dependencies, and caches are excluded from Git by `.gitignore`.

## Project structure

```text
shipment-tracker/
├── .github/
│   └── workflows/ci.yml      # Node.js 22/24 test workflow
├── public/
│   ├── assets/               # Dashboard and tracking UI
│   ├── index.html
│   ├── track.html
│   └── favicon.svg
├── server/
│   ├── app.js                # HTTP server and API routes
│   ├── auth.js               # Accounts, roles, sessions
│   ├── store.js              # SQLite shipment persistence
│   ├── automation.js         # Sync scheduler and email queue
│   ├── integrations.js       # AfterShip API and webhooks
│   ├── analytics.js          # Delivery performance metrics
│   ├── bulk.js               # CSV parsing and validation
│   ├── branding.js           # Workspace customization
│   ├── constants.js
│   └── validation.js
├── tests/                    # API, security and UI tests
├── .dockerignore
├── .env.example
├── .gitignore
├── compose.yaml
├── Dockerfile
├── package.json
└── README.md
```

## Testing

Run the complete automated test suite:

```bash
npm test
```

The release has **24 automated tests** covering shipment operations, authorization, migrations, courier update processing, CSV imports, analytics, public-link privacy, and interface utilities. GitHub Actions runs the suite on Node.js **22 and 24** for pushes to `main` and pull requests.

The courier and email integration tests use simulated provider responses. Actual deliveries, live provider accounts, reverse-proxy settings, and a production security review should be verified before exposing the service publicly.

## Security and operational notes 🔐

- Use HTTPS and secure session cookies for public deployments.
- Create a strong administrator password and a separate, private setup key.
- Treat public tracking URLs as bearer links; rotate or revoke them if exposed unintentionally.
- Back up your database regularly and restrict access to the server and backups.
- Keep API keys, `.env`, and databases out of the repository.
- Review and test reverse-proxy behavior, provider webhooks, and account access before production use.

This project includes practical security controls, but passing automated tests is **not** a substitute for deployment testing or an independent security assessment.

## Maintainer

Built and maintained by **[Shevendra Nag](https://github.com/shevendra-nag)**.

For bugs or feature discussions, use [GitHub Issues](https://github.com/shevendra-nag/shipment-tracker/issues).
