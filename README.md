# GIG Backend

REST API for the GIG (Global Investorz Group) mobile app. Node.js + TypeScript + Express, with Supabase (Postgres) as the database.

> **Status:** the Catalog and reviews module is implemented. Auth/onboarding, KYC, ratings, representations, roadshows and admin are not built yet.

## Getting started

Requires Node.js **22.11+**.

```sh
npm install
cp .env.example .env   # then fill in your Supabase URL and keys
npm run dev            # http://localhost:4000/api/v1/health
```

The Supabase values are under **Project Settings → API** in the Supabase dashboard. The server refuses to start if any required variable is missing.

### Database

The schema is in `supabase/migrations/` (apply the files in filename order). `supabase/seed.sql` loads the companies and issuers from the app's mock data. With the Supabase CLI:

```sh
npx supabase link --project-ref <your-project-ref>
npx supabase db push                        # applies supabase/migrations
psql "$DATABASE_URL" -f supabase/seed.sql   # optional dev data
```

Or paste each file into the dashboard's SQL editor.

`src/types/database.ts` mirrors the schema. After a schema change, regenerate it:

```sh
npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
```

The migration creates the plan's 10 tables for this section:

| Domain  | Tables                                                                                                     |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| Catalog | `companies`, `company_tags`, `issuers`, `issuer_tags`                                                      |
| Reviews | `reviews`, `review_tags`, `review_attachments`, `review_versions`, `company_stats`, `company_trend_points` |

It also creates two read-only views, `company_cards` and `review_feed`, and the private Storage bucket `review-evidence`. The `issuers` tables are read by the Ratings module's APIs.

The API reads and writes with the service role. Every table has Row Level Security enabled with no policies, so the app cannot query the database directly.

Company scores give newer reviews more weight, so the stats need a nightly recompute (for example with pg_cron): `select public.recompute_all_company_stats();`

### Users, tier and KYC

User profiles, tiers and KYC belong to the auth/onboarding module, which is built separately. This module stays independent of it:

- Tables reference Supabase Auth users (`auth.users`) directly.
- The reviewer's name is saved on each review when it is submitted.
- Tier and KYC status are read in one place: `src/lib/membership.ts`.

Until the auth module's profile table exists, `membership.ts` reads these Supabase Auth fields:

- `app_metadata.tier`: `OBSERVER`, `PRIVE` or `INSTITUTIONAL`. Defaults to `OBSERVER`.
- `app_metadata.kyc_status`: `NOT_STARTED`, `PENDING`, `APPROVED` or `REJECTED`.
- `user_metadata.full_name`

When the profile table is ready, change only `loadMembership` in that file.

To test review submission, make a user a verified Prive member in the SQL editor, then sign in again to get a fresh token:

```sql
update auth.users
set raw_app_meta_data = raw_app_meta_data || '{"tier": "PRIVE", "kyc_status": "APPROVED"}'
where email = 'tester@example.com';
```

## Scripts

| Command              | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `npm run dev`        | Start with hot reload (nodemon + tsx), loads `.env` |
| `npm run build`      | Compile to `dist/`                                  |
| `npm start`          | Run the compiled build                              |
| `npm run typecheck`  | TypeScript check (source and tests)                 |
| `npm run lint`       | ESLint                                              |
| `npm run format`     | Prettier                                            |
| `npm test`           | Run all tests once (Vitest)                         |
| `npm run test:watch` | Re-run tests on file changes                        |

## Tests

`npm test` runs the whole suite. It needs no database, no Supabase project and no `.env`: the database tests use PGlite (Postgres in WASM), and the HTTP tests use a fake Supabase client.

| Folder       | What it tests                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/` | Request validation: every review rule from the plan (per-sentiment fields, 10-800 chars, metrics 1-5, 6 resolution statuses, 400-char note, declarations), list filters, compare ids, trend ranges, membership adapter              |
| `test/db/`   | The real migration and seed: constraints, review submission and receipt numbers, one active review per product, evidence checks, stats and weighted score, trends, public feed and name masking, search filters, resolution updates |
| `test/api/`  | Every endpoint through Express: access rules per tier and KYC, response shapes, filters and sorting sent to the database, idempotency keys, evidence errors, 400/401/403/404/409 errors                                             |

## Project structure

```text
src/
  server.ts               # starts the HTTP server, graceful shutdown
  app.ts                  # Express app: security headers, CORS, JSON, routes, errors
  config/env.ts           # environment variables, validated with zod
  lib/supabase.ts         # typed supabaseAdmin (service role) and supabaseForUser (RLS)
  lib/http.ts             # response envelope, zod parsing, pagination helpers
  lib/enums.ts            # zod schemas for the database enums
  lib/membership.ts       # tier, KYC status and name for a user (auth-module integration point)
  types/database.ts       # typed Supabase schema (tables, views, functions, enums)
  middleware/             # errors, auth + tier guards
  routes/index.ts         # /api/v1 router; feature routers are mounted here
  modules/                # one folder per feature: *.routes.ts, *.schemas.ts, *.service.ts
    catalog/  reviews/
supabase/
  migrations/             # SQL schema, applied in filename order
  seed.sql                # development data
```

All routes are served under `/api/v1`.

## API conventions

- **Auth:** `Authorization: Bearer <Supabase access token>`.
- **Access levels:**
  - **Public**: no token needed.
  - **User**: any signed-in tier.
  - **Prive**: Prive tier with approved KYC.
  - **Full**: Prive with approved KYC, or Institutional.
- **Success responses:** `{ "data": ... }`. Lists add `"meta": { "page", "pageSize", "total" }`. Paging is `?page=1&pageSize=20`, with a maximum `pageSize` of 100.
- **Error responses:** `{ "error": { "code", "message", "fields"? } }`.
  - `code` is one of `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `KYC_REQUIRED`, `NOT_FOUND`, `CONFLICT` or `IDEMPOTENCY_CONFLICT`.
  - `fields` maps a field path, such as `metrics.transparency`, to its message.
- **Submissions:** send an `Idempotency-Key` header (8-128 characters, for example a UUID). The key is saved on the review. A retry with the same key and body returns the same review (with the header `Idempotent-Replayed: true`); the same key with a different body gets `409 IDEMPOTENCY_CONFLICT`.
- **Filters:** `filter[name]=A,B`. Values within one filter are OR'd; separate filters are AND'd.

## Catalog and reviews

| Method | Path                              | Access | Purpose                                                                                                                          |
| ------ | --------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/companies`                      | Public | Company list with search, sort and filters (see below)                                                                           |
| GET    | `/companies/compare?ids=a,b`      | User   | 2-4 companies side by side ("across"). Resolution lens and 12-month change for Full only                                         |
| GET    | `/companies/:id`                  | Public | Header, sentiment split, 5-metric scorecard. `analytics` (resolution lens, momentum) for Full only                               |
| GET    | `/companies/:id/trends?range=12M` | Full   | Monthly overall-satisfaction and positive-sentiment series. `range` is `12M`, `24M` or `ALL`                                     |
| GET    | `/companies/:id/reviews`          | Public | Published reviews (see below)                                                                                                    |
| POST   | `/reviews`                        | Prive  | Submit a review. Needs `Idempotency-Key`. Returns the full receipt (`receiptNo`, reviewer, company, status `PENDING_MODERATION`) |
| GET    | `/reviews/me`                     | User   | My reviews. Optional `?status=` filter                                                                                           |
| GET    | `/reviews/:id`                    | User   | Owner: the full receipt with evidence and status timeline. Others: the published review                                          |
| PATCH  | `/reviews/:id/resolution`         | Prive  | Reviewer only: `resolutionStatus` and `followUpNote` (omit to keep it, `null` to clear it)                                       |

**`GET /companies`**

- `q`: matches company names and tags.
- `sort`: `relevant`, `recent`, `trending`, `top_rated`, `most_reviewed` or `improving`.
- Filters: `filter[sentiment]`, `filter[assetClass]`, `filter[resolution]`, `filter[score]`, `filter[country]`, `filter[investedStatus]`, `filter[year]`. Years are `2024` or `before_2021`.

**`GET /companies/:id/reviews`**

- Each review has `detail: "SUMMARY"` for Observers and signed-out visitors, or `detail: "FULL"` for Full members.
- `sort`: `recent`, `oldest`, `highest` or `lowest`.
- Filters: `sentiment`, `resolution`, `assetClass`, `investedStatus`, `year`.

New reviews stay `PENDING_MODERATION` and do not count towards public numbers until a moderator sets `status = 'PUBLISHED'`. That moderation step belongs to the admin module, which is not built yet. Company stats recompute automatically whenever a published review changes.

### Submitting a review

`sentiment` decides which fields are required:

| Sentiment | Required fields                                                                                     |
| --------- | --------------------------------------------------------------------------------------------------- |
| Positive  | `appreciations` (1+), `detailedReview` (10-800 chars), `reinvestStatus` (`YES`, `MAYBE`, `NO`)      |
| Neutral   | `mixedReview` and `detailedReview` (10-800 chars each)                                              |
| Negative  | `concerns` (1+), `contactStatus` (1+), `negativeDescription` (10-800 chars), `evidence` (1-5 files) |

`investmentYear` is a year or `"OLDER"`.

Option codes (appreciations, concerns, contact statuses, document types) are fixed lists in `src/modules/reviews/reviews.schemas.ts`, with the same values checked by the database.

Evidence files are uploaded with `POST /files/upload-url`, which belongs to the "Users, profile and KYC" section and is not part of this module. Uploads go into the private bucket `review-evidence` at `<user_id>/<file name>`. The review sends each file's path as `evidence[].path`. On submission, this module checks that each file is in the reviewer's own folder, exists in Storage and isn't attached to another review.

```json
POST /api/v1/reviews
Idempotency-Key: 7d0f6c2e-1b7a-4f0e-9a51-3f1c2b9e8a10

{
  "companyId": "8f1c…",
  "country": "IN",
  "assetClass": "MF",
  "productScheme": "Bluechip Fund - Direct Growth",
  "investmentYear": 2024,
  "investmentStatus": "CURRENTLY_INVESTED",
  "sentiment": "Negative",
  "concerns": ["DELAY_IN_RESPONSE"],
  "contactStatus": ["CONTACTED_NO_RESPONSE"],
  "negativeDescription": "Redemption took 21 days …",
  "evidence": [{ "path": "<your user id>/statement.pdf", "docType": "STATEMENT" }],
  "metrics": { "transparency": 2, "responsiveness": 1, "easeOfProcess": 2, "trustworthiness": 2, "overallSatisfaction": 2 },
  "resolutionStatus": "CLOSED_UNRESOLVED",
  "displayMode": "INITIALS",
  "declarations": { "kycVerified": true, "genuine": true, "understandInsights": true, "allowContact": false }
}
```

### Mapping the app's current values to API codes

| In the app                                                                                         | API code                                                                                           |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Investment status `yes` / `maybe` ("Excited") / `no`                                               | `CURRENTLY_INVESTED` / `EXITED` / `NEVER_INVESTED`                                                 |
| Resolution `not_contacted`, `contacted`, `in_progress`, `resolved`, `partially_resolved`, `closed` | `NOT_CONTACTED`, `CONTACTED`, `IN_PROGRESS`, `RESOLVED`, `PARTIALLY_RESOLVED`, `CLOSED_UNRESOLVED` |
| Country India / UAE / Other                                                                        | `IN` / `AE` / `OTHER`                                                                              |
| Asset class "Trading Platform"                                                                     | `BRK` (Broker / Platform)                                                                          |
| Invest again Yes / Maybe / No                                                                      | `YES` / `MAYBE` / `NO`                                                                             |
| Tag labels (appreciations, concerns, contact status, document types)                               | Codes listed in `reviews.schemas.ts`                                                               |
| Company name typed as free text                                                                    | `companyId`, picked from `GET /companies?q=`                                                       |
