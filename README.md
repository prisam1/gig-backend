# GIG Backend

REST API for the GIG (Global Investorz Group) mobile app. Node.js + TypeScript + Express, with Supabase (Postgres) as the database.

> **Status:** Phase 1 "Auth and onboarding", "Users, profile and KYC", "Catalog and reviews", "Ratings", "Representations", "Learn, saved items, credits and notifications" and "Admin console APIs", and Phase 2 "Roadshows", are implemented. Top-rated lists are not built yet.

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

| Command              | Purpose                                                     |
| -------------------- | ----------------------------------------------------------- |
| `npm run dev`        | Start with hot reload (nodemon + tsx), loads `.env`         |
| `npm run build`      | Compile to `dist/`                                          |
| `npm start`          | Run the compiled build                                      |
| `npm run db:migrate` | Push new SQL files in `supabase/migrations/` (Supabase CLI) |
| `npm run db:seed`    | Push migrations and `supabase/seed.sql`                     |
| `npm run typecheck`  | TypeScript check (source and tests)                         |
| `npm run lint`       | ESLint                                                      |
| `npm run format`     | Prettier                                                    |
| `npm test`           | Run all tests once (Vitest)                                 |
| `npm run test:watch` | Re-run tests on file changes                                |

## Tests

`npm test` runs the whole suite. It needs no database, no Supabase project and no `.env`: the database tests use PGlite (Postgres in WASM), and the HTTP tests stub sign-in (`authProvider.loadMember`), the repositories, rate limits and the audit log (`test/setup.ts`).

`test/auth.test.ts` checks that every protected route rejects a missing, forged, unsigned (`alg: none`), expired or wrongly signed token, a token for another issuer or audience, and a valid token whose session has ended. `test/users.test.ts`, `test/files.test.ts` and `test/kyc.test.ts` cover public profiles and follows, uploads, and KYC submissions.

| Folder       | What it tests |
| ------------ | ------------- |
| `test/unit/` | Request validation: sign-up, login, OTP and onboarding rules; every review, rating and signing rule from the plan; list filters, compare ids, trend ranges |
| `test/db/`   | All migrations and the seed in PGlite. The `app_*` functions: sign-up, OTP limits and decoys, sessions, refresh-token theft, password reset, tier, KYC, who may call them, append-only audit log. Ratings and Representations: their repositories call the same `app_*` functions against PGlite (rating and signature transactions, issuer stats, effective petition status, signer names, infected documents, counts). Roadshows and engagement: pool joins and credit spending, question rules, ledger append-only. Catalog and reviews: constraints, review submission and receipt numbers, evidence checks, stats, trends, feed, search, resolution updates. Admin: staff roles, suspension, KYC decisions, moderation, content, petition track, credits and audit search |
| `test/api/`  | Every catalog, review, rating, representation, learn, webinar, saved, credits, notifications, roadshow and admin endpoint through Express: staff roles and permissions, access rules per tier and KYC, response shapes, filters and sorting, idempotency keys, evidence and signature-file errors, 400/401/403/404/409 errors |

## Project structure

```text
src/
  server.ts               # starts the HTTP server, purge job, graceful shutdown
  app.ts                  # Express app: request id, security headers, CORS, JSON, routes, errors
  config/env.ts           # environment variables, validated with zod
  lib/
    db.ts                 # callDb(): the app_* database functions, through supabase-js
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
    ratings/              # issuers, rating summary, rating submission and receipts
    representations/      # petitions, timeline, signatures and receipt PDFs, submission packs
    admin/                # staff roles, users, KYC decisions, moderation, content, credits, audit log
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

`supabase/seed.sql` loads the companies and issuers from the app's mock data (`npm run db:seed`). It is safe to run again: existing rows are skipped. The sign-up option lists (job profiles, focus, risk, styles, sectors) are inserted by the auth migration itself, and the rating factors, risk factors and investor types by `20261027161000_ratings_representations_support.sql`. The seed also loads the app's mock petitions.

The API has one way into the database: supabase-js with the service-role key (`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; no database password or connection string). The data is split into two schemas:

- **`app`** (auth, onboarding, profile, KYC, ratings and representations): users, sessions, OTP challenges, profiles, preferences, follows, files, KYC submissions and documents, consents, audit log, rate limits, the 4 Ratings tables and the 4 Representations tables. It is not exposed by the Supabase API at all. The server reaches it only through the `public.app_*` database functions (`supabase/migrations/20261027160000_app_functions.sql` and `20261027190000_ratings_representations_functions.sql`, called via `callDb` in `src/lib/db.ts`). Each function is one transaction, runs as its owner, and can be called by the service role only; the publishable key gets "permission denied". Hashing, encryption and token generation stay in the API, so the database only ever stores hashes and ciphertext.
- **`public`** (catalog and reviews): `companies`, `company_tags`, `issuers`, `issuer_tags`, `reviews`, `review_tags`, `review_attachments`, `review_versions`, `company_stats`, `company_trend_points`, plus the read-only views `company_cards` and `review_feed`, and the private Storage bucket `review-evidence`. The API reads and writes them with the service role (`src/lib/supabase.ts`). Every table has Row Level Security enabled with no policies, so the app cannot query the database directly. The `issuers` tables are read by the Ratings module's APIs.

`src/types/database.ts` mirrors the `public` schema. After a schema change, regenerate it:

```sh
npx supabase gen types typescript --project-id <ref> --schema public > src/types/database.ts
```

Company and issuer scores give newer reviews and ratings more weight, so the stats need a nightly recompute (for example with pg_cron): `select public.recompute_all_company_stats(); select app.recompute_all_issuer_stats();`

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

| Method | Path                    | Access | Purpose                                                                                      |
| ------ | ----------------------- | ------ | -------------------------------------------------------------------------------------------- |
| POST   | `/auth/register`        | Public | Sign-up step 1: name, email, phone, password, 18+ confirmation. Sends 2 OTPs                 |
| POST   | `/auth/otp/send`        | Public | Resend a code `{ challengeId }`, or start `{ purpose: LOGIN \| PASSWORD_RESET, identifier }` |
| POST   | `/auth/otp/verify`      | Public | Verify a 6-digit code. Returns tokens, sign-up progress, or a reset token                    |
| POST   | `/auth/login`           | Public | Email or phone (`+91…`, `+971…`) + password                                                  |
| POST   | `/auth/refresh`         | Public | Rotate the refresh token                                                                     |
| POST   | `/auth/logout`          | User   | End this session                                                                             |
| POST   | `/auth/password/forgot` | Public | Start a reset by OTP                                                                         |
| POST   | `/auth/password/reset`  | Public | Set a new password with the reset token; signs out every device                              |
| GET    | `/auth/sessions`        | User   | Signed-in devices                                                                            |
| DELETE | `/auth/sessions`        | User   | Sign out every other device                                                                  |
| DELETE | `/auth/sessions/:id`    | User   | Sign out one device                                                                          |

## Users, profile and KYC

Phase 1, plan weeks 5-7. Every route except `/lookups` requires your access token and a live session.

| Method        | Path                  | Access | Purpose                                                                                            |
| ------------- | --------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| GET           | `/me`                 | User   | Profile, avatar, follower counts, preferences, tier and onboarding progress                        |
| PATCH         | `/me`                 | User   | Sign-up step 2: experience, job profile (or Others + text), location; name and avatar edits        |
| PUT           | `/me/preferences`     | User   | Sign-up step 3: 1 focus, 1 risk, 1-3 styles, 1-3 sectors                                           |
| PUT           | `/me/tier`            | User   | Observer is granted at once; Prive / Institutional wait for KYC. Blocked while KYC is under review |
| GET           | `/users/:id`          | User   | Public profile (no email, phone or KYC detail) with follower counts                                |
| POST / DELETE | `/users/:id/follow`   | User   | Follow / unfollow                                                                                  |
| POST          | `/files/upload-url`   | User   | Signed upload URL; PDF/JPG/PNG up to 10 MB. Returns `fileId` and the Storage `path`                |
| POST          | `/kyc/submissions`    | User   | Submit uploaded documents for the requested tier (+ consent, required for Prive)                   |
| GET           | `/kyc/submissions/me` | User   | KYC status, latest submission and rejection reason                                                 |
| GET           | `/lookups/:type`      | Public | `job-profiles`, `investment-focus`, `risk-levels`, `investment-styles`, `investment-sectors`; also `rating-factors`, `risk-factors`, `investor-types` |

**Uploads:** the app asks for a URL with `purpose` (`AVATAR`, `KYC_DOCUMENT` or `REVIEW_EVIDENCE`), `mimeType` and `sizeBytes`, then PUTs the file to `uploadUrl`. Files are stored at `<user public_id>/<random id>.<ext>`, so each user writes only to their own folder. Avatars go to the public `avatars` bucket; KYC documents and review evidence stay private. Use the `fileId` for `PATCH /me` (`avatarFileId`) and KYC documents, and the `path` for review evidence.

**KYC:** one open submission per user. Submitting stores the documents, the consent (with time, IP, user agent and app version) and sets `kycStatus` to `PENDING`, in one transaction. GIG staff approve or reject it through `/admin/kyc` (see [Admin](#admin)).

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

New reviews stay `PENDING_MODERATION` and do not count towards public numbers until a moderator approves them through `/admin/moderation` (see [Admin](#admin)). Company stats recompute automatically whenever a published review changes.

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

## Ratings

| Method | Path                          | Access | Purpose                                                                                          |
| ------ | ----------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| GET    | `/issuers`                    | Public | Issuers with offer terms and aggregate score. `q`, `sort`, `filter[assetType]`, `filter[listed]` |
| GET    | `/issuers/:id`                | Public | Offer details                                                                                    |
| GET    | `/issuers/:id/rating-summary` | Public | Average score and count. Full members also get the weighted score and full breakdown             |
| POST   | `/issuers/:id/ratings`        | Prive  | Submit a rating. Needs `Idempotency-Key`. Returns the receipt (`GIG-RT-YYYY-NNNNNN`)             |
| GET    | `/ratings/me`                 | User   | My ratings. Optional `?status=` filter                                                           |

- `sort` is `recent`, `closing_soon`, `top_rated` or `most_rated`.
- A rating is `{ overallScore, factors, riskFactors }`:
  - `overallScore`: an integer from 1 to 5.
  - `factors`: a flag (`POSITIVE`, `NEUTRAL` or `NEGATIVE`) for every one of the 10 rating factors.
  - `riskFactors`: exactly 3 different risk factors from the 12.
- Factor and risk codes come from `GET /lookups/rating-factors` and `GET /lookups/risk-factors`.
- One active rating per investor and issuer; a second one gets `409 RATING_ALREADY_SUBMITTED`.
- Ratings start as `PENDING_MODERATION` and count towards the summary only once `PUBLISHED`.
- The breakdown has the weighted score (newer ratings weigh more, down to 0.5 at 24 months), the 1-5 distribution, the share of each flag per factor, and how often each risk was picked.

Tables (private `app` schema): `issuer_ratings`, `issuer_rating_factors`, `issuer_rating_risks`, `issuer_stats` (the plan's Ratings domain). A rating and its factors and risks are saved, and audited (`rating.submitted`), in one transaction. Recompute stats nightly with `select app.recompute_all_issuer_stats();`.

## Representations

| Method | Path                              | Access       | Purpose                                                                                          |
| ------ | --------------------------------- | ------------ | ------------------------------------------------------------------------------------------------ |
| GET    | `/representations`                | Public       | Petitions with goal, signatures, progress, days left and track status                            |
| GET    | `/representations/:id`            | Public       | Overview, evidence download links, recent signers; your own signature and receipt when signed in |
| GET    | `/representations/:id/timeline`   | Public       | The 9-step track with when each step was reached, and the status history                         |
| POST   | `/representations/:id/signatures` | Prive        | Sign. Needs `Idempotency-Key`. Returns the signature ID (`GIG-XXXXXXXXX`) and a receipt PDF link |
| GET    | `/representations/:id/submission` | Prive, Inst. | Download link for the submitted petition pack; `404 SUBMISSION_NOT_AVAILABLE` until there is one |

- `GET /representations` takes `q`, `sort` (`closing_soon`, `recent`, `most_signed` or `progress`), and the filters `filter[status]`, `filter[country]` and `filter[openForSigning]`.
- Track statuses: `OPEN`, `CLOSING_SOON`, `CLOSED`, `UNDER_REVIEW`, `SUBMITTED_TO_REGULATOR`, `MEETING_REQUESTED`, `MEETING_SCHEDULED`, `REGULATOR_RESPONDED`, `RESOLVED`.
  - The first three follow the signing window: "Closing Soon" in the last 7 days, "Closed" after `closesAt`.
  - The rest are set by GIG staff, and every change is recorded in the history.
- Each response also carries the app's label (`trackLabel`), for example "Submitted to Reg.".
- A signature is `{ displayMode, investorType?, signatureFileId, consents: { supportSubmission: true, digitalEndorsement: true } }`.
  - `displayMode` is `FULL_NAME`, `INITIALS` or `ANONYMOUS`. Anonymous signers are counted but never named.
  - `investorType` is a code from `GET /lookups/investor-types`.
  - `signatureFileId` comes from `POST /files/upload-url` with `purpose: "SIGNATURE"` (PDF, JPG or PNG).
  - Both consents are stored in `app.consents` with their version, IP, user agent and app version, in the same transaction as the signature and its audit entry (`representation.signed`).
- Only Prive signatures count as votes (`voteCount`). One signature per investor and petition; a second one gets `409 ALREADY_SIGNED`.
- Signatures have a `status` (`VALID` or `REMOVED`) and a soft delete. Removed or deleted signatures stop counting and are no longer listed, and the investor can sign again.
- Signature files and petition documents flagged `INFECTED` by the virus scan are never accepted or offered for download.
- The receipt PDF is stored privately and served through 5-minute download links.

Tables (private `app` schema): `representations`, `representation_signatures`, `representation_status_history`, `representation_documents` (the plan's Representations domain). Storage buckets: `signatures`, `signature-receipts` and `representation-documents`, all private. Petition packs themselves are generated in Phase 2 ("Petition PDF packs"); the download endpoint serves them once GIG attaches one.

### Mapping the app's current values (ratings and representations)

| In the app                                                                                                                         | API                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Rating factor labels ("PROMOTERS", "FINANCIAL HEALTH", ...)                                                                        | Codes from `/lookups/rating-factors` (`PROMOTERS`, ...)      |
| Flags `negative` / `neutral` / `positive`                                                                                          | `NEGATIVE` / `NEUTRAL` / `POSITIVE`                          |
| Risk factors 'Credit', 'Market', ...                                                                                               | Codes from `/lookups/risk-factors` (`CREDIT`, ...)           |
| Issuer chosen by name (`companyName`)                                                                                              | Issuer `id` in the URL                                       |
| Name display 'Show full name' / 'Show initials only' / 'Anonymous (counted but not shown)' (stored in the review form's `country`) | `displayMode`: `FULL_NAME` / `INITIALS` / `ANONYMOUS`        |
| Investor type label (stored in the review form's `assetClass`)                                                                     | `investorType` code from `/lookups/investor-types`           |
| Signature file name only                                                                                                           | Upload the file, send its `signatureFileId`                  |
| Review-form `isKycVerified` / `isGenuine` as the 2 consents                                                                        | `consents.supportSubmission` / `consents.digitalEndorsement` |
| `signedSignature`, `Goal`, `closeIn`, `totalSignature`                                                                             | `signatureCount`, `goal`, `daysLeft`, `progressPercent`      |
| Petition opened without an id                                                                                                      | Petition `id` in the URL                                     |

## Learn, saved items, credits and notifications

| Method | Path                      | Access | Purpose                                                                                       |
| ------ | ------------------------- | ------ | --------------------------------------------------------------------------------------------- |
| GET    | `/learn`                  | Public | Content list. `q`, `sort` (`recent`, `top_rated`), `filter[format]`, `[category]`, `[access]` |
| GET    | `/learn/:id`              | Public | `contentUrl` (null when `locked`), report `download` (Full only), `myRating`                  |
| POST   | `/learn/:id/rating`       | User   | `{ rating: 1-5 }`; rating again replaces it. Returns the new average and count                |
| GET    | `/webinars?when=upcoming` | User   | `upcoming` (incl. live) or `past`; `joinUrl` for registered members, delayed recordings       |
| POST   | `/webinars/:id/register`  | User   | Register; PREMIUM webinars need Full access                                                   |
| GET    | `/me/saved?type=COMPANY`  | User   | Saved items, newest first, each with a `{ name, subtitle, imageUrl }` summary                 |
| POST   | `/me/saved`               | User   | `{ type, id }`; `type` is `COMPANY`, `ISSUER`, `ROADSHOW` or `LEARN_ITEM`                     |
| DELETE | `/me/saved/:type/:id`     | User   | Remove a saved item                                                                           |
| GET    | `/me/credits`             | User   | `{ balance, entries }` with the ledger paged in `meta`                                        |
| GET    | `/me/notifications`       | User   | Inbox; `?unread=true`; `meta.unread` is the badge count                                       |
| POST   | `/me/notifications/read`  | User   | `{ ids?: [...] }`; omit `ids` to mark all read                                                |
| POST   | `/me/devices`             | User   | `{ token, platform: IOS / ANDROID / WEB, appVersion? }` push token                            |

PREMIUM learn content and webinars are for Full members; others see them with `locked: true`. Report downloads are 5-minute signed URLs from the private `learn-reports` bucket.

**Credits.** `credit_ledger` is append-only (updates and deletes are refused by a trigger); `app.users.credit_balance` caches the sum and can never go below 0. Every change goes through `public.apply_credit_change`. Until `/admin/credits/grant` exists, grant credits in the SQL editor:

```sql
select public.apply_credit_change('<user public_id>', 5, 'ADMIN_GRANT', null, null, 'Launch credits');
```

## Roadshows

| Method | Path                              | Access | Purpose                                                                                                                      |
| ------ | --------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/roadshows`                      | Public | `state` (`OPEN` default, `CLOSED`, `ALL`), `q`, `sort` (`closing_soon`, `recent`), `filter[poolEnabled]`, `filter[currency]` |
| GET    | `/roadshows/:id`                  | Public | Issue summary and terms, risk factors, document list, `inPool` for signed-in users                                           |
| GET    | `/roadshows/:id/financials`       | User   | Latest 3 fiscal years; `?currency=INR/USD/EUR/GBP/AED` converts with `fx_rates`                                              |
| GET    | `/roadshows/:id/documents/:docId` | Full   | 5-minute signed download URL for a DD PDF                                                                                    |
| GET    | `/roadshows/:id/questions`        | User   | Published questions with answers. `sort=top` (Top Asked) or `recent`; `category`; `q`                                        |
| POST   | `/roadshows/:id/questions`        | Prive  | `{ question, category? }` while the roadshow is open; published after moderation                                             |
| POST   | `/roadshows/:id/pool`             | Prive  | Join the Power Pool: `{ capitalInterest, expectations }` (3+ of 8). Costs 1 credit. Needs `Idempotency-Key`                  |
| GET    | `/roadshows/:id/pool-power`       | User   | Participants, total and average capital interest, % per improvement, heat map                                                |
| POST   | `/roadshows/:id/offers`           | Inst.  | Post an offer (price, ROI/IRR, loads, lock-in, allotment and payment terms); `PENDING_REVIEW`                                |

- **Power Pool join** runs in one transaction (`public.join_roadshow_pool`): checks the roadshow is published, open and pool-enabled, spends 1 credit, stores the membership and expectations, and adds an inbox notification. Errors: `402 INSUFFICIENT_CREDITS`, `409 ALREADY_IN_POOL`, `409 POOL_NOT_ENABLED`, `409 ROADSHOW_CLOSED`. A retry with the same key and body returns the same membership with `Idempotent-Replayed: true`.
- **Expectations:** `BETTER_ROI_IRR`, `SHORTER_LOCK_IN`, `LOWER_ENTRY_LOAD`, `LOWER_EXIT_LOAD`, `PRIORITY_ALLOTMENT`, `FLEXIBLE_PAYMENT_TERMS`, `DISCOUNTED_OFFER_PRICE`, `REGULAR_DISCLOSURES`.
- **Heat map:** members are split into capital-interest quartile bands; each cell is the share of a band asking for an improvement.
- **Top Asked** lists staff-featured questions first, then answered ones. GIG staff answer and feature questions through `/admin/roadshows/:id/questions/:questionId/answer` (see [Admin](#admin)); publishing offers is not built yet.
- `fx_rates` holds units per 1 USD; the FX feed job (not built yet) should overwrite it. A missing rate returns `503 FX_RATE_UNAVAILABLE`.

## Admin

Phase 1, plan weeks 14-15: the API behind GIG's admin console. Every route is under `/admin`, needs an access token, and is open to GIG staff only (`403 STAFF_ONLY` for everyone else, whatever their tier). Staff roles are a second axis next to the membership tier; each route also needs one permission (`403 ROLE_FORBIDDEN` otherwise).

| Permission      | ADMIN | MODERATOR | SUPPORT | ANALYST | Routes                                                             |
| --------------- | :---: | :-------: | :-----: | :-----: | ------------------------------------------------------------------ |
| `users.read`    |   ✓   |     ✓     |    ✓    |    ✓    | `GET /admin/users`, `/admin/users/:id`, `/admin/users/:id/credits` |
| `users.contact` |   ✓   |           |    ✓    |         | Email and phone in `GET /admin/users/:id` (each view audited)      |
| `users.write`   |   ✓   |           |         |         | `PATCH /admin/users/:id`                                           |
| `roles.write`   |   ✓   |           |         |         | `PUT /admin/users/:id/roles`                                       |
| `kyc.read`      |   ✓   |     ✓     |    ✓    |         | `GET /admin/kyc`, `/admin/kyc/:id` (each view audited)             |
| `kyc.decide`    |   ✓   |     ✓     |         |         | `POST /admin/kyc/:id/approve`, `/reject`                           |
| `moderation`    |   ✓   |     ✓     |         |         | `/admin/moderation/*`; roadshow questions and answers              |
| `content.read`  |   ✓   |     ✓     |    ✓    |    ✓    | `GET` companies, issuers, representations, roadshows, learn        |
| `content.write` |   ✓   |           |         |         | Create, update, delete content; petition track and documents       |
| `credits.grant` |   ✓   |           |         |         | `POST /admin/credits/grant`                                        |
| `audit.read`    |   ✓   |           |         |         | `GET /admin/audit-logs`                                            |

`GET /admin/me` returns the signed-in staff member's roles and permissions, for the console's menus. The matrix lives in `src/modules/admin/admin.access.ts`.

**The first ADMIN** is created in the SQL editor. After that, admins manage roles with `PUT /admin/users/:id/roles`:

```sql
insert into app.user_roles (user_id, role)
select id, 'ADMIN' from app.users where public_id = '<user id>';
```

| Method               | Path                                                           | Purpose                                                                                                                                  |
| -------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GET                  | `/admin/users`                                                 | `q`: exact email, phone with country code, user ID, or part of the name. `filter[tier/kycStatus/status/role]`. `sort`: `-createdAt`, `createdAt`, `name`, `-lastLoginAt` |
| GET                  | `/admin/users/:id`                                             | Account, profile, roles, credits, activity counts, KYC submissions, tier history. `contact` for ADMIN and SUPPORT only                  |
| PATCH                | `/admin/users/:id`                                             | `{ tier?, status?: ACTIVE or SUSPENDED, reason }`. Suspending signs the user out everywhere                                              |
| PUT                  | `/admin/users/:id/roles`                                       | `{ roles: [...] }` replaces the user's staff roles                                                                                       |
| GET                  | `/admin/users/:id/credits`                                     | Credit ledger, newest first; the balance is in `meta.balance`                                                                            |
| GET                  | `/admin/kyc`                                                   | Queue: pending first, oldest first. `filter[status]` (default `PENDING`), `filter[tier]`                                                 |
| GET                  | `/admin/kyc/:id`                                               | Submission, user, consent, and documents with 5-minute download links                                                                    |
| POST                 | `/admin/kyc/:id/approve`                                       | Grants the submitted tier (recorded in the tier history as `KYC_APPROVED`)                                                               |
| POST                 | `/admin/kyc/:id/reject`                                        | `{ reason }`, which the user sees in `GET /kyc/submissions/me`                                                                           |
| GET                  | `/admin/moderation/queue`                                      | Reviews, ratings and roadshow questions, oldest first. `filter[type]=REVIEW,RATING,QUESTION`, `filter[status]` (default `PENDING_MODERATION`) |
| GET                  | `/admin/moderation/:id?type=REVIEW`                            | The full review (with evidence links), rating or question                                                                                |
| POST                 | `/admin/moderation/:id/decision`                               | `{ type, decision, note? }`. `note` is required for every decision except `APPROVE`                                                      |
| GET / POST           | `/admin/companies`, `/admin/issuers`, `/admin/representations`, `/admin/roadshows`, `/admin/learn` | List / create. Companies, issuers, representations: `filter[deleted]=true` includes deleted items. Roadshows, learn: `filter[status]` (default `DRAFT,PUBLISHED`; add `ARCHIVED`) |
| GET / PATCH / DELETE | `/admin/<resource>/:id`                                        | Read / update only the fields sent / delete: a soft delete, or for roadshows and learn, archive (`status: ARCHIVED`) |
| POST                 | `/admin/representations/:id/documents/upload-url`              | Signed URL to PUT one document (PDF, JPG or PNG, up to 25 MB) into the petition's folder                                                 |
| POST                 | `/admin/representations/:id/documents`                         | Attach uploaded documents (evidence and others) outside the track                                                                       |
| POST                 | `/admin/representations/:id/status`                            | `{ status, note?, documents? }`: moves the track forward, from Under Review onwards                                                      |
| GET                  | `/admin/roadshows/:id/questions`                               | Ask Me Anything questions, oldest first. `filter[status]`, `filter[category]`, `filter[answered]`                                       |
| POST                 | `/admin/roadshows/:id/questions/:questionId/answer`            | `{ answer, featured? }`: publishes the issuer's answer (sending it again replaces it) and notifies the asker; a pending question is published with it. `featured` puts it in "Top Asked" |
| POST                 | `/admin/credits/grant`                                         | `{ userId, delta, reason }`; a negative `delta` revokes. Needs an `Idempotency-Key` header                                              |
| GET                  | `/admin/audit-logs`                                            | Newest first. `filter[action]` (exact, or a prefix such as `admin.*`), `filter[user]` (entries by or about the user), `filter[from]`, `filter[to]` |

**Rules.** The database functions enforce these, so they also hold when requests run at the same time.

- **Moderation:** `APPROVE` publishes a pending or changes-requested item. `REQUEST_CHANGES` and `REJECT` decide a pending one. `REMOVE` takes a published one down. Any other combination is `409 INVALID_TRANSITION`. Review decisions appear on the review's status timeline, and company and issuer stats recompute through the existing triggers. Roadshow questions have only `PENDING_MODERATION`, `PUBLISHED` and `REJECTED`: `REMOVE` rejects a published question, and `REQUEST_CHANGES` does not apply.
- **KYC:** a submission is decided once (`409 KYC_ALREADY_DECIDED`). A submission with an infected document cannot be approved (`409 DOCUMENT_INFECTED`).
- **Users:** Prive and Institutional need approved KYC (`409 KYC_NOT_APPROVED`). Suspended users cannot sign in, and their existing tokens stop working.
- **Conflicts of interest:** staff cannot decide their own KYC or moderate their own content (`403 CONFLICT_OF_INTEREST`). They cannot change their own status, drop their own ADMIN role, or grant themselves credits (`409 SELF_CHANGE`). GIG always keeps one active ADMIN (`409 LAST_ADMIN`).
- **Petition track:** staff set the statuses from Under Review to Resolved. Steps can be skipped but never reversed, and moving to Under Review ends signing early. Each step records its note, the staff member and its documents, which show on the public timeline. Documents must be uploaded to the petition's folder first.
- **Content:** companies, issuers and representations are soft-deleted; roadshows and learn items are archived (`status: ARCHIVED`), as the Roadshows and Learn modules intend. Either way the item leaves the app and its reviews, ratings, signatures, pool, questions and learn ratings stay. A slug already in use is `409 SLUG_TAKEN`.
- **Roadshows** (`public.roadshows`): issue summary (type of issue, instruments, offer price, lock-in, maturity, convertibility, callable, coupon rate), risk factors, the pool window (`opensAt`, which may be null, to `closesAt`; `poolEnabled`) and financials per fiscal year (`fiscalYear: 2025`; revenue, EBITDA, net profit, total assets, total liabilities, net worth, total debt, cash and equivalents, operating cash flow, EPS), all in the roadshow's `currency`. Sending `financials` replaces every year. `status` is `DRAFT`, `PUBLISHED` (the first publication time is kept) or `ARCHIVED`. The issuer must exist (`400`, field `issuerId`).
- **Roadshow questions** (`public.roadshow_questions`): categories `GENERAL`, `EQUITY`, `DEBT`, `INSURANCE`, `CRYPTO`, `MUTUAL_FUNDS`. Rejected questions cannot be answered (`409 INVALID_TRANSITION`). The asker is notified the first time their question is answered.
- **Learn** (`public.learn_items`): `format` is `VIDEO`, `ARTICLE`, `REPORT` or `PODCAST`; `access` is `FREE` or `PREMIUM` (Full members only); `contentUrl` is the stream or article link. `downloadPath` names a PDF already uploaded to the private `learn-reports` bucket (`400` if it is not there). `status` works as for roadshows.
- **Credits:** grants and revocations go through the Credits module's `public.apply_credit_change`, so they land in the same append-only `public.credit_ledger` (reason `ADMIN_GRANT` or `ADMIN_REVOKE`, `refType: ADMIN` with the staff member's id, and the reason as the entry's `note`, at most 400 characters). The balance never goes below zero (`409 INSUFFICIENT_CREDITS`), and the user gets a `CREDITS` notification. A retry with the same `Idempotency-Key` returns the original entry with `Idempotent-Replayed: true`.
- **Audit:** every admin write records its own audit entry (`admin.*` actions) in the same transaction, with the staff member, IP, user agent and request ID. Opening a user's contact details or a KYC submission is audited too.

Migrations:

- `supabase/migrations/20261028090000_admin.sql`: `app.user_roles` (staff roles) and `app.admin_credit_grants` (the Idempotency-Key of each credit grant), plus the admin functions for users, KYC, moderation, companies, issuers, representations, credits and the audit trail.
- `supabase/migrations/20261028100000_admin_roadshows_learn.sql`: no new tables. It adds `moderation_note` and `answered_by` to `public.roadshow_questions`, the admin functions for roadshows, questions and learn items, and adds questions to the moderation queue.

Every `app_admin_*` function is declared with its arguments and result shape in `src/lib/dbFunctions.ts`, like the rest of the API.

**Not covered yet:** uploading roadshow DD documents and learn report files (staff upload them to the `roadshow-documents` and `learn-reports` buckets directly for now), publishing institutional roadshow offers, and webinar management.
