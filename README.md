# GIG Backend

REST API for the GIG (Global Investorz Group) mobile app. Node.js + TypeScript + Express, with Supabase (Postgres) as the database.

> **Status:** Phase 1 "Auth and onboarding", "Users, profile and KYC" and "Catalog and reviews" are implemented. Ratings, representations, roadshows and admin are not built yet.

## Getting started

Requires Node.js **22.11+**.

```sh
npm install
cp .env.example .env   # fill in Supabase values and generate the three secret keys
npx supabase login     # once per machine
npm run db:link && npm run db:seed   # creates the tables and sample data in Supabase
npm run dev            # http://localhost:4000/api/v1/health/ready
```

The server refuses to start if any required variable is missing or invalid.

## Scripts

| Command              | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `npm run dev`        | Start with hot reload (nodemon + tsx), loads `.env` |
| `npm run build`      | Compile to `dist/`                                  |
| `npm start`          | Run the compiled build                              |
| `npm run db:migrate` | Push new SQL files in `supabase/migrations/` (Supabase CLI) |
| `npm run db:seed`    | Push migrations and `supabase/seed.sql`             |
| `npm run typecheck`  | TypeScript check (source and tests)                 |
| `npm run lint`       | ESLint                                              |
| `npm run format`     | Prettier                                            |
| `npm test`           | Run all tests once (Vitest)                         |
| `npm run test:watch` | Re-run tests on file changes                        |

## Tests

`npm test` runs the whole suite. It needs no database, no Supabase project and no `.env`: the database tests use PGlite (Postgres in WASM), and the HTTP tests stub sign-in (`authProvider.loadMember`), the repositories, rate limits and the audit log (`test/setup.ts`).

`test/auth.test.ts` checks that every protected route rejects a missing, forged, unsigned (`alg: none`), expired or wrongly signed token, a token for another issuer or audience, and a valid token whose session has ended. `test/users.test.ts`, `test/files.test.ts` and `test/kyc.test.ts` cover public profiles and follows, uploads, and KYC submissions.

| Folder       | What it tests                                                                                                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/` | Request validation: sign-up, login, OTP and onboarding rules; every review rule from the plan (per-sentiment fields, 10-800 chars, metrics 1-5, 6 resolution statuses, 400-char note, declarations), list filters, compare ids, trend ranges |
| `test/db/`   | The real migrations and seed: constraints, review submission and receipt numbers, one active review per product, evidence checks, stats and weighted score, trends, public feed and name masking, search filters, resolution updates |
| `test/api/`  | Every catalog and review endpoint through Express: access rules per tier and KYC, response shapes, filters and sorting sent to the database, idempotency keys, evidence errors, 400/401/403/404/409 errors                          |

## Project structure

```text
src/
  server.ts               # starts the HTTP server, purge job, graceful shutdown
  app.ts                  # Express app: request id, security headers, CORS, JSON, routes, errors
  config/env.ts           # environment variables, validated with zod
  lib/
    db.ts                 # direct Postgres client for the private "app" schema
    supabase.ts           # typed supabaseAdmin (service role) for catalog/reviews tables and Storage
    membership.ts         # the signed-in member: session, tier, KYC status and name
    http.ts               # response envelope, zod parsing, pagination helpers
    enums.ts              # zod schemas for the database enums
    ...                   # crypto (PII encryption), passwords, JWT, rate limits, audit, OTP delivery
  types/database.ts       # typed Supabase schema (tables, views, functions, enums)
  middleware/             # errors, auth + tier guards, validation, request context
  routes/index.ts         # /api/v1 router; feature routers are mounted here
  modules/                # one folder per feature: *.routes.ts, *.schemas.ts, *.service.ts
    auth/                 # register, OTP, login, refresh, sessions, password reset
    users/                # /me profile, avatar, preferences, tier; /users/:id, follows; /lookups
    files/                # signed upload URLs for avatars, KYC documents and review evidence
    kyc/                  # KYC submissions and status
    catalog/  reviews/    # companies, trends, compare; review submission and receipts
supabase/
  migrations/             # SQL migrations, applied in name order, never edited once applied
  seed.sql                # development data
test/                     # unit/, db/, api/ and helpers/
```

## Database

The schema is pushed to Supabase with the Supabase CLI, the same way as agpcrypto. Sign in once per machine; no database password or connection string is needed:

```sh
npx supabase login     # opens the browser once
npm run db:link        # links this folder to project enkokznzruhyldqdpbwg
npm run db:seed        # first time: applies every migration, then supabase/seed.sql
npm run db:migrate     # afterwards: applies only new migrations
```

The CLI records applied migrations in `supabase_migrations.schema_migrations`. To change the schema, add a new file (for example `20261101090000_kyc.sql`); never edit a file that has been pushed.

`supabase/seed.sql` loads the companies and issuers from the app's mock data (`npm run db:seed`). It is safe to run again: existing rows are skipped. The sign-up option lists (job profiles, focus, risk, styles, sectors) are inserted by the auth migration itself.

The data is split into two schemas:

- **`app`** (auth, onboarding, profile and KYC): users, sessions, OTP challenges, profiles, preferences, follows, files, KYC submissions and documents, consents, audit log, rate limits. It is private: the Supabase Data API roles (`anon`, `authenticated`) have no access to it. The API connects with `DATABASE_URL` (`src/lib/db.ts`) so these flows run in transactions.
- **`public`** (catalog and reviews): `companies`, `company_tags`, `issuers`, `issuer_tags`, `reviews`, `review_tags`, `review_attachments`, `review_versions`, `company_stats`, `company_trend_points`, plus the read-only views `company_cards` and `review_feed`, and the private Storage bucket `review-evidence`. The API reads and writes them with the service role (`src/lib/supabase.ts`). Every table has Row Level Security enabled with no policies, so the app cannot query the database directly. The `issuers` tables are read by the Ratings module's APIs.

`src/types/database.ts` mirrors the `public` schema. After a schema change, regenerate it:

```sh
npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
```

Company scores give newer reviews more weight, so the stats need a nightly recompute (for example with pg_cron): `select public.recompute_all_company_stats();`

### Users, tier and KYC

Users belong to the auth module (`app.users`). Other modules identify a user by `app.users.public_id` (a uuid): it is stored in `reviews.user_id` and `review_versions.actor_id`, and is the first folder of every evidence path. Tier, KYC status and the reviewer's name (`app.user_profiles.name`) are loaded with the session on every request, by `authProvider.loadMember` in `src/lib/auth.ts`. The reviewer's name is also saved on each review when it is submitted.

Prive and Institutional are granted only after KYC approval. To test review submission before the KYC module exists, make a user a verified Prive member in the SQL editor (the next request picks it up; no new sign-in needed):

```sql
update app.users set tier = 'PRIVE', kyc_status = 'APPROVED' where public_id = '<user id>';
```

## API conventions

All routes are served under `/api/v1`.

- **Auth:** `Authorization: Bearer <access token>` from `/auth/login`, `/auth/otp/verify` or `/auth/refresh`.
- **Access levels:**
  - **Public**: no token needed.
  - **User**: any signed-in tier.
  - **Prive**: Prive tier with approved KYC.
  - **Full**: Prive with approved KYC, or Institutional.
- **Success responses:** `{ "data": ... }`. Lists add `"meta": { "page", "pageSize", "total" }`. Paging is `?page=1&pageSize=20`, with a maximum `pageSize` of 100.
- **Error responses:** `{ "error": { "code", "message", "fields"? } }`.
  - Shared codes: `VALIDATION_FAILED`, `UNAUTHENTICATED`, `FORBIDDEN`, `KYC_REQUIRED`, `NOT_FOUND`, `CONFLICT`, `IDEMPOTENCY_CONFLICT`, `INTERNAL`. Some auth routes add their own, such as `INVALID_CREDENTIALS` or `INVALID_REFRESH_TOKEN`.
  - `fields` maps a field path, such as `metrics.transparency`, to its message.
- **Submissions:** send an `Idempotency-Key` header (8-128 characters, for example a UUID). The key is saved on the review. A retry with the same key and body returns the same review (with the header `Idempotent-Replayed: true`); the same key with a different body gets `409 IDEMPOTENCY_CONFLICT`.
- **Filters:** `filter[name]=A,B`. Values within one filter are OR'd; separate filters are AND'd.

## Auth and onboarding

Phase 1, plan weeks 3-5.

| Method | Path                    | Access | Purpose                                                                         |
| ------ | ----------------------- | ------ | ------------------------------------------------------------------------------- |
| POST   | `/auth/register`        | Public | Sign-up step 1: name, email, phone, password, 18+ confirmation. Sends 2 OTPs     |
| POST   | `/auth/otp/send`        | Public | Resend a code `{ challengeId }`, or start `{ purpose: LOGIN \| PASSWORD_RESET, identifier }` |
| POST   | `/auth/otp/verify`      | Public | Verify a 6-digit code. Returns tokens, sign-up progress, or a reset token        |
| POST   | `/auth/login`           | Public | Email or phone (`+91…`, `+971…`) + password                                      |
| POST   | `/auth/refresh`         | Public | Rotate the refresh token                                                         |
| POST   | `/auth/logout`          | User   | End this session                                                                 |
| POST   | `/auth/password/forgot` | Public | Start a reset by OTP                                                             |
| POST   | `/auth/password/reset`  | Public | Set a new password with the reset token; signs out every device                  |
| GET    | `/auth/sessions`        | User   | Signed-in devices                                                                |
| DELETE | `/auth/sessions`        | User   | Sign out every other device                                                      |
| DELETE | `/auth/sessions/:id`    | User   | Sign out one device                                                              |

## Users, profile and KYC

Phase 1, plan weeks 5-7. Every route except `/lookups` requires your access token and a live session.

| Method        | Path                    | Access | Purpose                                                                         |
| ------------- | ----------------------- | ------ | ------------------------------------------------------------------------------- |
| GET           | `/me`                   | User   | Profile, avatar, follower counts, preferences, tier and onboarding progress      |
| PATCH         | `/me`                   | User   | Sign-up step 2: experience, job profile (or Others + text), location; name and avatar edits |
| PUT           | `/me/preferences`       | User   | Sign-up step 3: 1 focus, 1 risk, 1-3 styles, 1-3 sectors                          |
| PUT           | `/me/tier`              | User   | Observer is granted at once; Prive / Institutional wait for KYC. Blocked while KYC is under review |
| GET           | `/users/:id`            | User   | Public profile (no email, phone or KYC detail) with follower counts              |
| POST / DELETE | `/users/:id/follow`     | User   | Follow / unfollow                                                                |
| POST          | `/files/upload-url`     | User   | Signed upload URL; PDF/JPG/PNG up to 10 MB. Returns `fileId` and the Storage `path` |
| POST          | `/kyc/submissions`      | User   | Submit uploaded documents for the requested tier (+ consent, required for Prive) |
| GET           | `/kyc/submissions/me`   | User   | KYC status, latest submission and rejection reason                               |
| GET           | `/lookups/:type`        | Public | `job-profiles`, `investment-focus`, `risk-levels`, `investment-styles`, `investment-sectors` |

**Uploads:** the app asks for a URL with `purpose` (`AVATAR`, `KYC_DOCUMENT` or `REVIEW_EVIDENCE`), `mimeType` and `sizeBytes`, then PUTs the file to `uploadUrl`. Files are stored at `<user public_id>/<random id>.<ext>`, so each user writes only to their own folder. Avatars go to the public `avatars` bucket; KYC documents and review evidence stay private. Use the `fileId` for `PATCH /me` (`avatarFileId`) and KYC documents, and the `path` for review evidence.

**KYC:** one open submission per user. Submitting stores the documents, the consent (with time, IP, user agent and app version) and sets `kycStatus` to `PENDING`, in one transaction. Approval and rejection belong to the admin module, which is not built yet.

### Sign-up flow

1. `POST /auth/register` returns a `signupId` and two challenges (email and phone).
2. `POST /auth/otp/verify` for each challenge. The first returns `status: "PENDING"`; the second creates the account and returns `status: "COMPLETED"` with the user and tokens.
3. `PATCH /me`, then `PUT /me/preferences`, then `PUT /me/tier`.

The account only exists once both email and phone are verified. A pending sign-up expires after 1 hour.

### Security rules

- **Passwords:** Argon2id. 8-128 characters with upper, lower, digit and special character. Must not contain the email name or phone number.
- **OTP:** 6 digits, valid 5 minutes, 5 wrong attempts per code, 45 s resend cooldown, 5 sends per challenge. Codes are stored only as keyed hashes.
- **No account discovery:** register, OTP login and forgot-password respond the same whether or not the email or phone is registered. Login has a single "incorrect email/phone or password" error and equal timing.
- **Rate limits** (shared across instances, in Postgres):
  - per IP on every auth route
  - 5 codes per email or phone per hour
  - 5 failed logins per email or phone per 15 minutes, applied whether or not the account exists
- **Tokens:** 15-minute access JWT (HS256, issuer and audience checked). The 30-day refresh token is rotated on every use, and every session ends after 90 days at most. Reusing an old refresh token revokes that session. Every authenticated request also checks the session in the database, so logout, password reset and suspension apply immediately.
- **PII:** email and phone are encrypted with AES-256-GCM. Lookups use HMAC-SHA256 hashes.
- **Audit log:** registrations, logins (including failures), OTP failures, token reuse, logouts, session revokes, password resets and onboarding changes. The table rejects updates and deletes.
- **Requests:** unknown body fields are rejected, bodies are capped at 100 KB, and auth responses are sent with `Cache-Control: no-store`.

### Changes needed in the mobile app

- **OTP input:** use 6 boxes instead of 4, for both the sign-up and the reset flows.
- **Sign-up order:** verify the email and phone OTPs right after step 1, before the professional and investment steps. The account is only created after both codes are verified.
- **Option lists:** send option **codes** from `/lookups` (for example `LOW_LEVEL`, `FOUNDER`), not labels.
- **Experience:** send a whole number of years (`"5+"` is not accepted).
- **Login:** the field takes an email, or a phone number with country code (`+919876543210`).
- **Phone at sign-up:** send the country code (`+91` by default, or `+971`).
- **Forgot password:** the app needs a "new password" screen that calls `/auth/password/reset`.
- **Tier choice:** choosing Prive or Institutional records a request (`requestedTier`). The tier itself changes only after KYC approval.

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

Evidence files are uploaded with `POST /files/upload-url`, which belongs to the "Users, profile and KYC" section and is not part of this module. Uploads go into the private bucket `review-evidence` at `<user_id>/<file name>`, where `<user_id>` is the user's `public_id`. The review sends each file's path as `evidence[].path`. On submission, this module checks that each file is in the reviewer's own folder, exists in Storage and isn't attached to another review.

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
