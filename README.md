# GIG Backend

REST API for the GIG (Global Investorz Group) mobile app. Node.js + TypeScript + Express, with Supabase (Postgres, Auth, Storage).

> **Status:** Phase 1 "Users, profile and KYC" and "Catalog and reviews" are implemented. Ratings, representations, roadshows and admin are not built yet.

## Getting started

Requires Node.js **22.11+**.

```sh
npm install
cp .env.example .env   # then fill in your Supabase URL and service role key
npm run dev            # http://localhost:4000/api/v1/health/ready
```

The Supabase values are under **Project Settings → API** in the Supabase dashboard. The server refuses to start if any required variable is missing.

## Database setup

Apply the migrations in filename order, then the seed, to your Supabase project (SQL editor, or `supabase db push` with the Supabase CLI):

1. `supabase/migrations/20261027000000_users_profile_kyc.sql`: users, profiles, preferences, follows, files, KYC, lookups, storage buckets
2. `supabase/migrations/20261027000100_catalog_reviews.sql`: companies, issuers, reviews, stats, trends, views and functions
3. `supabase/migrations/20261027000200_reviews_use_gig_users.sql`: links reviews to `users.public_id`
4. `supabase/seed.sql`: sample lookup options, companies and issuers (replace with the app's full lists before UAT)

Never edit a migration once it has been applied; add a new file instead.

The API reads and writes with the service role. Every table has Row Level Security enabled with no policies, so the app cannot query the database directly.

The Supabase client is typed from `src/types/database.ts`, and the domain enums (`Tier`, `KycStatus`, ...) derive from it. After any schema change, regenerate it so the compiler catches mismatches:

```sh
npx supabase gen types typescript --project-id <project-ref> --schema public > src/types/database.ts
```

Company scores give newer reviews more weight, so the stats need a nightly recompute (for example with pg_cron): `select public.recompute_all_company_stats();`

## Auth and users

Sign-up, OTP, login, password reset and token refresh are done by the app with **Supabase Auth**. The API accepts its access tokens (`src/lib/auth.ts`) and creates the GIG user row (`public.users`) on the first authenticated request.

- Every module identifies a user by `users.public_id` (a uuid): `/users/:id`, `reviews.user_id`, and the first folder of every uploaded file (`<public_id>/<file>`).
- Tier and KYC status live on `public.users`. Prive and Institutional are granted only after KYC approval; until then the choice is stored as `requested_tier`.
- The catalog and reviews modules read the signed-in user only through `src/lib/membership.ts`. The reviewer's name (`user_profiles.name`) is saved on each review when it is submitted.

To test review submission before the admin module exists, make a user a verified Prive member in the SQL editor:

```sql
update public.users set tier = 'PRIVE', kyc_status = 'APPROVED' where public_id = '<user id>';
```

## API conventions

All routes are served under `/api/v1`.

- **Auth:** `Authorization: Bearer <Supabase access token>`.
- **Access levels:**
  - **Public**: no token needed.
  - **User**: any signed-in tier.
  - **Prive**: Prive tier with approved KYC.
  - **Full**: Prive with approved KYC, or Institutional.
- **Success responses:** `{ "data": ... }`. Lists add `"meta": { "page", "pageSize", "total" }`. Paging is `?page=1&pageSize=20`, with a maximum `pageSize` of 100.
- **Error responses:** `{ "error": { "code", "message", "fields"? } }`.
  - Shared codes: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `INTERNAL`. Some routes add their own: `ACCOUNT_SUSPENDED`, `KYC_REQUIRED`, `KYC_PENDING`, `KYC_ALREADY_PENDING`, `TIER_NOT_REQUESTED`, `IDEMPOTENCY_CONFLICT`.
  - `fields` maps a field path, such as `metrics.transparency`, to its message.
- **Submissions:** send an `Idempotency-Key` header (8-128 characters, for example a UUID). The key is saved on the review. A retry with the same key and body returns the same review (with the header `Idempotent-Replayed: true`); the same key with a different body gets `409 IDEMPOTENCY_CONFLICT`.
- **Filters:** `filter[name]=A,B`. Values within one filter are OR'd; separate filters are AND'd.

## Users, profile and KYC

| Method        | Path                  | Access | Purpose                                                                           |
| ------------- | --------------------- | ------ | --------------------------------------------------------------------------------- |
| GET / PATCH   | `/me`                 | User   | Own profile; update name, experience, job profile, location, avatar               |
| PUT           | `/me/preferences`     | User   | 1 focus, 1 risk, 1-3 styles, 1-3 sectors (validated against lookups)              |
| PUT           | `/me/tier`            | User   | Observer applies at once; Prive / Institutional become `requestedTier`            |
| GET           | `/users/:id`          | User   | Public profile (no contact details) with follower counts                          |
| POST / DELETE | `/users/:id/follow`   | User   | Follow / unfollow                                                                 |
| POST          | `/files/upload-url`   | User   | Signed upload URL; PDF/JPG/PNG up to 10 MB; returns `fileId`                      |
| POST          | `/kyc/submissions`    | User   | Submit uploaded documents (+ consent, required for Prive)                         |
| GET           | `/kyc/submissions/me` | User   | KYC status, latest submission and rejection reason                                |
| GET           | `/lookups/:type`      | Public | `job-profiles`, `focus`, `risk-levels`, `styles`, `sectors`, `asset-classes`, ... |

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

Evidence files are uploaded first with `POST /files/upload-url` and purpose `REVIEW_EVIDENCE`. They go into the private bucket `review-evidence` at `<user public_id>/<file name>`. The review sends each file's path as `evidence[].path`. On submission, the reviews module checks that each file is in the reviewer's own folder, exists in Storage and isn't attached to another review.

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

`npm test` runs the whole suite. It needs no database, no Supabase project and no `.env`.

| Location         | What it tests                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/*.test.ts` | Users, profile, KYC, files, lookups and auth through Express, with the repositories stubbed (`test/helpers.ts`)                                       |
| `test/unit/`     | Review rules from the plan, list filters, compare ids, trend ranges, query helpers                                                                    |
| `test/db/`       | All migrations and the seed in PGlite (Postgres in WASM): constraints, review submission, evidence checks, stats, trends, feed, search, resolution    |
| `test/api/`      | Every catalog and review endpoint through Express with a fake Supabase client: access rules per tier and KYC, response shapes, idempotency, errors |

## Project structure

```text
src/
  server.ts               # starts the HTTP server, graceful shutdown
  app.ts                  # Express app: request id, security headers, CORS, JSON, routes, errors
  config/env.ts           # environment variables, validated with zod
  lib/
    supabase.ts           # typed supabaseAdmin (service role) and unwrap()
    auth.ts               # verifies Supabase Auth access tokens
    membership.ts         # the signed-in user as the catalog and reviews modules see it
    http.ts               # response envelope, zod parsing, pagination helpers
    enums.ts              # zod schemas for the database enums
  types/
    database.ts           # typed Supabase schema (tables, views, functions, enums)
    domain.ts             # domain enums derived from it
  middleware/             # errors, auth + tier guards, validation, request context
  routes/index.ts         # /api/v1 router; feature routers are mounted here
  modules/                # one folder per feature
    users/  files/  kyc/  lookups/  catalog/  reviews/
supabase/
  migrations/             # SQL migrations, applied in filename order
  seed.sql                # development data
```
