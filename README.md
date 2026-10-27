# GIG Backend

REST API for the GIG (Global Investorz Group) mobile app. Node.js + TypeScript + Express, with Supabase (Postgres) as the database.

> **Status:** Users, profile and KYC module implemented. Auth (sign-up, OTP, login) is next.

## Database setup

Apply the migration and sample lookups to your Supabase project (SQL editor, or `supabase db push` with the Supabase CLI):

1. `supabase/migrations/20261027000000_users_profile_kyc.sql`: tables, storage buckets, atomic functions
2. `supabase/seed.sql`: sample lookup options (replace with the app's full lists)

The Supabase client is typed from `src/types/database.ts`, and the domain enums (`Tier`, `KycStatus`, ...) derive from it. After any schema change, regenerate it so the compiler catches mismatches:

```sh
npx supabase gen types typescript --project-id <project-ref> --schema public > src/types/database.ts
```

## Users, profile and KYC endpoints

All routes need `Authorization: Bearer <Supabase access token>`, except `GET /lookups/:type`. A GIG user row is created on the first authenticated request.

| Method        | Path                  | Purpose                                                                           |
| ------------- | --------------------- | --------------------------------------------------------------------------------- |
| GET / PATCH   | `/me`                 | Own profile; update name, experience, job profile, location, avatar               |
| PUT           | `/me/preferences`     | 1 focus, 1 risk, 1-3 styles, 1-3 sectors (validated against lookups)              |
| PUT           | `/me/tier`            | Observer applies at once; Prive / Institutional become `requestedTier`            |
| GET           | `/users/:id`          | Public profile (no contact details) with follower counts                          |
| POST / DELETE | `/users/:id/follow`   | Follow / unfollow                                                                 |
| POST          | `/files/upload-url`   | Signed upload URL; PDF/JPG/PNG up to 10 MB; returns `fileId`                      |
| POST          | `/kyc/submissions`    | Submit uploaded documents (+ consent, required for Prive)                         |
| GET           | `/kyc/submissions/me` | KYC status, latest submission and rejection reason                                |
| GET           | `/lookups/:type`      | `job-profiles`, `focus`, `risk-levels`, `styles`, `sectors`, `asset-classes`, ... |

Errors use `{ error: { code, message, fields? } }`; `fields` maps each invalid input to its message.

## Getting started

Requires Node.js **22.11+**.

```sh
npm install
cp .env.example .env   # then fill in your Supabase URL and keys
npm run dev            # http://localhost:4000/api/v1/health
```

The Supabase values are under **Project Settings → API** in the Supabase dashboard. The server refuses to start if any required variable is missing.

## Scripts

| Command             | Purpose                                         |
| ------------------- | ----------------------------------------------- |
| `npm run dev`       | Start with hot reload (tsx watch), loads `.env` |
| `npm run build`     | Compile to `dist/`                              |
| `npm start`         | Run the compiled build                          |
| `npm test`          | Run the API tests (Vitest + Supertest)          |
| `npm run typecheck` | TypeScript check                                |
| `npm run lint`      | ESLint                                          |
| `npm run format`    | Prettier                                        |

## Project structure

```text
src/
  server.ts               # starts the HTTP server, graceful shutdown
  app.ts                  # Express app: security headers, CORS, JSON, routes, errors
  config/env.ts           # environment variables, validated with zod
  lib/supabase.ts         # supabaseAdmin (service role) and supabaseForUser (RLS)
  middleware/             # error handling, later auth
  routes/index.ts         # /api/v1 router; feature routers are mounted here
  modules/                # one folder per feature (auth, reviews, ratings, ...)
```

All routes are served under `/api/v1`.
