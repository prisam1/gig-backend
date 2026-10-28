# Testing the API with Postman

Step-by-step guide for testing every endpoint with `gig-backend.postman_collection.json`.

## 1. Start the server

```sh
npm install
cp .env.example .env              # fill in Supabase values and the three secret keys
npm run db:link && npm run db:seed  # tables + sample companies, issuers, roadshows, petitions, learn, webinars
npm run dev                       # http://localhost:4000/api/v1
```

Keep the terminal running `npm run dev` visible. **OTP codes are printed there** (`OTP_DELIVERY=console`), for example:

```text
[otp] SIGNUP EMAIL a***@gig.test code=482913
```

## 2. Import the collection

1. Postman → **Import** → choose `gig-backend.postman_collection.json`.
2. Open the collection → **Variables** tab. Check `baseUrl` is `http://localhost:4000/api/v1`.
3. Run **Health → Readiness**. Expected: `{ "status": "ok", "database": "ok" }`.

Tokens, OTP challenge IDs and the IDs of companies, issuers, roadshows and so on are saved into collection variables automatically by the requests. You only edit the values marked "set" below.

## 3. Test accounts

The seed has no users, so create these three once. The passwords meet the policy (8+ characters, upper, lower, digit, special character, and they don't contain the email name or phone).

| Role | Email | Phone | Password | Used for |
| --- | --- | --- | --- | --- |
| Admin (staff) | `admin@gig.test` | `9000000001` | `Gig#Pass2026` | All `/admin/*` requests, approving KYC |
| Prive investor | `investor@gig.test` | `9000000002` | `Gig#Pass2026` | Reviews, ratings, signing, questions, Power Pool |
| Institutional | `institution@gig.test` | `9000000003` | `Gig#Pass2026` | Posting a roadshow offer |

You need separate accounts because staff can't approve their own KYC or grant themselves credits (`409 SELF_ACTION`).

### 3.1 Create an account (repeat for each row)

1. **Auth → Register**. Edit the body with that row's name, email, phone and password:
   ```json
   { "name": "GIG Admin", "email": "admin@gig.test", "countryCode": "+91",
     "phone": "9000000001", "password": "Gig#Pass2026", "ageConfirmed": true }
   ```
   Two OTPs are sent, one to the email and one to the phone; both challenge IDs are saved automatically.
2. From the server terminal copy the `EMAIL` code into the `emailOtp` variable and the `PHONE` code into `phoneOtp`.
3. **Auth → Signup verify EMAIL** (returns `PENDING`), then **Auth → Signup verify PHONE** (returns `COMPLETED` with tokens). You're now signed in. Codes expire after 5 minutes.
4. Before choosing a tier, finish onboarding: **Update me** (experience, job profile, location) and **Set preferences**. Otherwise `PUT /me/tier` returns `409 ONBOARDING_INCOMPLETE`.

### 3.2 Make the first account an admin

1. Signed in as `admin@gig.test`, run **Users → Get me** and copy `data.id`.
2. In the Supabase SQL editor run:
   ```sql
   insert into app.user_roles (user_id, role)
   select id, 'ADMIN' from app.users where public_id = '<paste data.id here>';
   ```
3. **Admin → Staff & users → Admin me** should now list the `ADMIN` role.

### 3.3 Make the investor a verified Prive member

Signed in as `investor@gig.test`:

1. **Users → Choose tier** with `{ "tier": "PRIVE" }`.
2. **Files & KYC → Get upload URL** (purpose `KYC_DOCUMENT`, mimeType `application/pdf`; set `sizeBytes` to the file's real size).
3. **Files & KYC → Upload file to signed URL**: Body → binary → choose any small PDF → Send.
4. **Files & KYC → Submit KYC**.

Then log in as admin (section 4) and:

5. **Admin → KYC → List KYC** (saves `kycId`) → **Approve KYC**.
6. **Admin → Staff & users → List users** with `q=investor@gig.test`, check the saved `userId` is the investor, then **Grant credits** (gives 5 credits; joining a Power Pool costs 1).

Repeat steps 1-5 for `institution@gig.test` with `{ "tier": "INSTITUTIONAL" }`.

## 4. Switching between accounts

Set the collection variables `identifier` (email, or phone as `+919000000001`) and `password`, then run **Auth → Login**. The new tokens replace the old ones. If the access token expires (15 minutes), run **Auth → Refresh**.

## 5. Test order, folder by folder

Run each folder top to bottom: list requests save the IDs the next requests use.

| Folder | Sign in as | Notes |
| --- | --- | --- |
| Health | anyone | No token needed |
| Auth | any | OTP Send (`LOGIN` / `PASSWORD_RESET`) → code from the terminal → OTP Verify. Forgot password → OTP Verify (saves `resetToken`) → Reset password. Run **Logout** and **Revoke all sessions** last; they end your session |
| Users, profile & lookups | investor | Run **Lookup** for each type first (`job-profiles`, `investment-focus`, `risk-levels`, `investment-styles`, `investment-sectors`) and put real codes into **Update me** / **Set preferences** |
| Files & KYC | investor | See 3.3 |
| Companies & reviews | investor (Prive) | **List companies** first. Positive review needs no file. Negative review needs an evidence file: Get upload URL with purpose `REVIEW_EVIDENCE` + upload, then submit. A new review is `PENDING_MODERATION` until an admin approves it |
| Issuers & ratings | investor (Prive) | Run **Lookups** `rating-factors` and `risk-factors` first; the body must flag every factor once and pick exactly 3 different risk factors |
| Representations | investor (Prive) | Get upload URL with purpose `SIGNATURE` (PNG/JPG/PDF) + upload, then **Sign**. Returns a `GIG-XXXXXXXXX` signature ID |
| Roadshows | investor (Prive) / institution | **Ask question** and **Join Power Pool** as investor (needs ≥1 credit, pool must be enabled). **Post offer** as institution |
| Learn & webinars | investor | PREMIUM items unlock only for verified Prive / Institutional |
| Top rated | anyone | `type=company` or `type=issuer` |
| Saved, credits & notifications | investor | Run **List companies** first so `companyId` is set |
| Admin | admin | Approve the investor's review / rating / question in **Moderation** (Queue → Get item → Decide). For document requests run **Staff upload URL** + upload first (saves `staffPath`) |

## 6. Things to know

- **Idempotency:** creating requests send a fresh `Idempotency-Key` each time. To test retry safety, replace `{{$guid}}` with a fixed value and send twice: the second call returns the same result instead of a duplicate.
- **Expected errors:** `401` = no or expired token; `403` = wrong tier, KYC not approved, or no staff role; `409` = duplicate (one review per company and scheme, one rating per issuer, one signature per petition, one pool join).
- **Error format:** `{ "error": { "code", "message", "fields" } }`. `fields` shows which body field failed.
- **Rate limits:** OTP has a 45 s resend cooldown and a limit on attempts. If you get `429`, wait and retry.
- **Delete requests** in Admin remove the item whose ID is currently saved. Run them last, or create a fresh item first.
