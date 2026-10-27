# GIG Backend

REST API for the GIG (Global Investorz Group) mobile app. Node.js + TypeScript + Express, with Supabase (Postgres) as the database.

> **Status:** Phase 1 "Auth and onboarding" is implemented. Other modules are not started.

## Getting started

Requires Node.js **22.11+**.

```sh
npm install
cp .env.example .env   # fill in Supabase values and generate the three secret keys
npm run db:migrate     # creates the tables in Supabase
npm run dev            # http://localhost:4000/api/v1/health/ready
```

The server refuses to start if any required variable is missing or invalid.

## Scripts

| Command              | Purpose                                              |
| -------------------- | ---------------------------------------------------- |
| `npm run dev`        | Start with hot reload (tsx watch), loads `.env`      |
| `npm run build`      | Compile to `dist/`                                   |
| `npm start`          | Run the compiled build                               |
| `npm run db:migrate` | Apply new SQL files in `supabase/migrations/`        |
| `npm test`           | Unit tests                                           |
| `npm run typecheck`  | TypeScript check                                     |
| `npm run lint`       | ESLint                                               |
| `npm run format`     | Prettier                                             |

## Project structure

```text
src/
  server.ts               # starts the HTTP server, purge job, graceful shutdown
  app.ts                  # Express app: request id, security headers, CORS, JSON, routes, errors
  config/env.ts           # environment variables, validated with zod
  db/migrate.ts           # migration runner
  lib/                    # db, crypto (PII encryption), passwords, JWT, rate limits, audit, OTP delivery
  middleware/             # errors, auth guard, validation, request context
  routes/index.ts         # /api/v1 router; feature routers are mounted here
  modules/
    auth/                 # register, OTP, login, refresh, sessions, password reset
    users/                # /me profile, preferences, tier; /lookups option lists
supabase/migrations/      # SQL migrations, applied in name order, never edited once applied
```

## Database

All tables live in the private `app` schema. The Supabase Data API roles (`anon`, `authenticated`) have no access to it and RLS is enabled with no policies, so the publishable key cannot read or write anything. The API connects with `DATABASE_URL`.

To change the schema, add a new file to `supabase/migrations/` (for example `20261101090000_kyc.sql`) and run `npm run db:migrate`. The runner records each file's checksum and refuses to run if an applied file was edited.

## Auth and onboarding

Phase 1, plan weeks 3-5. All routes are under `/api/v1`. Successful responses are `{ "data": ... }`; errors are `{ "error": { "code", "message", "fields"? } }`.

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

Phase 1. Only the endpoints the sign-up screens need are built so far.

| Method | Path                    | Access | Purpose                                                                         |
| ------ | ----------------------- | ------ | ------------------------------------------------------------------------------- |
| GET    | `/me`                   | User   | Profile, preferences, tier and onboarding progress                               |
| PATCH  | `/me`                   | User   | Sign-up step 2: experience, job profile (or Others + text), location; name edits |
| PUT    | `/me/preferences`       | User   | Sign-up step 3: 1 focus, 1 risk, 1-3 styles, 1-3 sectors                          |
| PUT    | `/me/tier`              | User   | Observer is granted at once; Prive / Institutional wait for KYC                  |
| GET    | `/lookups/:type`        | Public | `job-profiles`, `investment-focus`, `risk-levels`, `investment-styles`, `investment-sectors` |

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
