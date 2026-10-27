# GIG Backend

REST API for the GIG (Global Investorz Group) mobile app. Node.js + TypeScript + Express, with Supabase (Postgres) as the database.

> **Status:** project setup only. No feature modules are implemented yet.

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
