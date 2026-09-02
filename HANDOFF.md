# AHL Flow — Handoff

**Status as of 29 Aug 2026.** Supersedes `CLAUDE_HANDOFF.md`, which describes a
database schema that does not exist. Do not build against that file.

Inventory, purchase requests and goods receipt for American Hair Line — a hair
and skin clinic with studios in Mumbai (HO + Khar), Delhi and Bangalore.

---

## 1. Read this first — five facts that cost a day to discover

1. **There are two copies of this project on this machine.**
   - `C:\Users\admin\Desktop\Purchase\ahl-flow` — **this one, the live one.** Dev server on **port 3001**.
   - `C:\Users\admin\Documents\ChatGPT\AHL Finance FY25-26\ahl-flow` — stale, on port 3000. It has **no NextAuth API routes** (`/api/auth/csrf` returns 404), so login there fails no matter what credentials you use. Cookies ignore port numbers, so having both running causes redirect loops. Kill the 3000 one.

2. **The Apps Script web app returns HTTP 403 to every request.** Google denies access before `doPost` runs — the response is an HTML "Access denied — Drive. You need access" page, not our JSON. This is a **deployment access setting**, not a code bug. The manifest already declares `ANYONE_ANONYMOUS` and a fresh deployment still 403s, which points to a Google Workspace policy on `americanhairline.com` blocking anonymous web apps. **Nothing can be verified end-to-end until this clears.** Check: Apps Script → Deploy → Manage deployments → ✏️ → "Who has access". If *Anyone* is greyed out, it needs a Workspace admin.

3. **Apps Script cannot set HTTP status codes.** `ContentService` always returns HTTP 200, even for FORBIDDEN or INSUFFICIENT_STOCK. **Never branch on `res.ok`.** Branch on the `success` field in the body. The intended status is echoed in `body.status` for logging only.

4. **A service account cannot call an Apps Script web app.** There is a service-account key at `Desktop\Purchase\ahl-sheets-automation-*.json`; it is useless for this transport. That is *why* the HMAC layer exists — the endpoint is meant to be anonymous at Google's layer with our own signature as the security boundary. The service account is only useful if you later abandon the web app and talk to the Sheets API directly.

5. **`HMAC_SECRET` is server-only.** It must never be prefixed `NEXT_PUBLIC_` or imported into a `"use client"` file. `src/lib/api.ts` is server-only by contract.

---

## 2. Architecture

```
Client component ("use client")
   │  postAction(action, data)          src/lib/api-client.ts
   ▼
POST /api/gas   (same origin)           src/app/api/gas/route.ts
   │  • auth() — rejects if no session
   │  • role allowlist per action
   │  • injects `actor` from the session (never trusted from the client)
   ▼
callAppsScript()                        src/lib/api.ts   ← SERVER ONLY
   │  body = JSON.stringify({ action, actor, data })
   │  sig  = base64(HMAC_SHA256(`${ts}.${body}`, HMAC_SECRET))
   ▼
POST {APPS_SCRIPT_URL}?ts=…&sig=…
   ▼
doPost()                                apps-script/Code.gs
   verifyHmac → isActiveUser → LockService → handler → JSON
```

**Why the proxy exists:** the pages are client components. A non-`NEXT_PUBLIC_`
env var is `undefined` in the browser, so signing client-side silently breaks;
making it public would hand the shared secret to every visitor. A browser POST
straight to `script.google.com` also fails CORS preflight. Signing on the server
solves all three.

**Signing contract** — must stay byte-identical to `verifyHmac()` in
`apps-script/Validation.gs`. The body is serialised **once**; the bytes signed
must be the bytes sent. Verified test vector:

```
ts   1700000000000
body {"action":"stock.receive","actor":"satvik@ahl.com","data":{"productId":"P001","qty":5}}
sig  jP4Qyk1HuzvGNYRBND1Q5Rurj5xJlwc+Uff/vJfATKk=
```

---

## 3. The database

**Sheet: "AHL Flow DB"** — `16LFKuCYPOk46dWalYXHcoDYuqPf6mn213pfSp0ukEe4`

Seven tabs, deliberately consolidated down from an earlier 21-table design that
modelled a system nobody has built. Schema is defined once in
`apps-script/Setup.gs` under `SCHEMA`.

| Tab | Columns |
|---|---|
| `PRODUCTS` | ProductID, Name, CategoryID, IssueUOM, PurchaseUOM, ConvFactor, Cost, GSTPercent, VendorID, ReorderLevel, Active, Notes |
| `PEOPLE` | UserID, Email, Name, Role, LocationID, ApprovalLimit, Active, PasswordHash, PasswordSalt |
| `LISTS` | Type, Code, Name, Extra, Active — `Type` ∈ CATEGORY \| VENDOR \| LOCATION \| UOM |
| `LEDGER` | TxnID, Date, Type, Direction, ProductID, Qty, UOM, QtyBase, LocationID, CategoryID, PersonID, VendorID, HandoverID, PORef, InvoiceNo, Amount, BillPhotoURL, Actor, Status, Notes |
| `REQUESTS` | RequestID, Date, ProductID, Qty, RequestedBy, Urgency, EstValue, Status, ApprovedBy, ApprovedAt, Actor, Notes |
| `CONFIG` | Key, Value, Notes |
| `AUDIT` | AuditID, Timestamp, Actor, Action, Ref, Detail, Result |

**Source of the seed data:** the original 21-tab sheet "AHL"
(`1uXdnPiAvC5AH21jwCYVI6mEWQ7nyGXY8USdQky-RaKg`). `setupDatabase()` in
`Setup.gs` migrates from it. Keep it as an archive; the app does not read it.

### Design rules for the ledger

- **`LEDGER` is the single source of truth for stock.** There is no running
  total anywhere. Balance = `Σ (QtyBase × Direction)`. `Direction` is `+1` for
  receipts, `-1` for issues. A transfer between studios is two rows, not a
  separate table.
- **`QtyBase` is always in the product's `IssueUOM`.** Receipts arrive in
  `PurchaseUOM` and are multiplied by `ConvFactor` (a 5000ml can of solvent
  becomes `QtyBase = 5000` with `Qty = 1, UOM = CAN`). Issues are already in
  base units. Get this wrong and every balance is wrong.
- **Never address a column by position.** Use `appendRecord(tab, {ColumnName: value})`
  from `Db.gs`. Position-based writes are what corrupted the previous version —
  11 values written into a 30-column table put `ProductID` under `TxnDate`.
- **`Active` may be `TRUE`, `"Yes"`, or `1`.** Always read it through `isTruthy()`.

---

## 4. What is built

### Working (typechecks, builds, lints clean — but unverified end-to-end because of the 403)

- **Auth & routing.** `src/middleware.ts` gates by role. Roles: `Admin`,
  `PurchaseCoordinator`, `ProductDistributor`. Login verified working on 3001.
- **Transport.** `src/lib/api.ts`, `src/app/api/gas/route.ts`, `src/lib/api-client.ts`.
- **Stock Out** (`/stock-out`, Hitesh). Product picker, multi-split allocation
  across categories and recipients, live issued/available counter, wired to
  `stock.issue`.
- **Purchase Hub** (`/purchase`, Satvik). Request logger → `purchase.request`
  with optimistic rows that roll back on failure. GRN tab → `stock.receive`
  with a required bill photo.
- **`<PhotoCapture />`** (`src/components/photo-capture.tsx`). `getUserMedia`
  with rear-camera preference, `<input capture>` fallback, client-side
  compression (longest edge 1600px, JPEG quality stepped 0.82→0.35 until under
  600KB), stream cleanup on unmount.
- **Drive storage.** `apps-script/Drive.gs` decodes base64 into `yyyy-MM`
  folders, validates MIME and an 8MB ceiling, writes the URL to
  `LEDGER.BillPhotoURL`.
- **Design system.** Tokens in `src/app/globals.css`; shell, page and form
  primitives in `src/components/app-shell.tsx` and `src/components/ui/field.tsx`.
  **Use these — do not hardcode `bg-slate-900` etc.** That drift is what made
  the earlier UI inconsistent.

### Not built

- **Admin dashboard** (`/admin`) — three placeholder cards. Approvals queue,
  three-way match, Category P&L are all unimplemented.
- **Read sync.** All master data is a static mirror in `src/lib/mock-data.ts`.
  Product `balance` is deliberately `null` — the ledger is empty, so there is no
  real figure, and the UI says "Balance syncs from ledger" rather than inventing
  one. **This is the highest-value next feature.**
- **Two-sided handover.** `LEDGER.Status` is written as `PENDING_CONFIRM` on
  issue, but nothing ever confirms it. Technicians are not users of the app.

---

## 5. Setup

### Environment (`.env`, gitignored)

```env
AUTH_SECRET="<set-in-local-env>"
NEXT_PUBLIC_APPS_SCRIPT_URL="https://script.google.com/macros/s/AKfycbwSwWsSPEe5uDGLiMRt-H4XH0bz4ICG-S6Dc40YjUVtvt193A5dAz37kUdzA6S-zMc7XQ/exec"
HMAC_SECRET="<set-in-local-env-and-apps-script-properties>"
```

> The file was once saved as UTF-16, which made `dotenv` skip the URL silently.
> If env vars read as `undefined`, check the encoding is ASCII first.

### Apps Script — Script Properties (Project Settings)

| Key | Value |
|---|---|
| `SHEET_ID_DB` | `16LFKuCYPOk46dWalYXHcoDYuqPf6mn213pfSp0ukEe4` |
| `HMAC_SECRET` | must match `.env` **exactly** |

Login emails, roles and salted password hashes live in `PEOPLE`; account
passwords are not Vercel environment variables. To provision or reset one,
temporarily set `PASSWORD_EMAIL` and `PASSWORD_VALUE` in Script Properties,
run `updateUserPasswordFromScriptProperties()`, and confirm that the function
deleted both temporary plaintext properties.

Without `HMAC_SECRET`, `Validation.gs` falls back to
`DEV_SECRET_DO_NOT_USE_IN_PROD` and every signature fails with FORBIDDEN while
the signing code is perfectly correct. `SHEET_ID_DB` falls back to the constant
`TARGET_SHEET_ID` in `Setup.gs`, so that one is optional.

### Commands

```bash
npm run dev                 # port 3001 if 3000 is taken
npx tsc --noEmit
npx next build

cd apps-script
clasp push --force
clasp create-version "message"
clasp redeploy AKfycbwSwWsSPEe5uDGLiMRt-H4XH0bz4ICG-S6Dc40YjUVtvt193A5dAz37kUdzA6S-zMc7XQ -V <n>
clasp open-script
```

`clasp` is v3.3.0, logged in as `ai@americanhairline.com`. **`clasp deploy` with
no `-i` mints a new URL** — always `redeploy` the existing deployment id above,
or `.env` goes stale.

### Health check

`Code.gs` exposes `doGet`. Open the `/exec` URL in a browser: it returns JSON
with the sheet id, product/people/ledger counts and whether the secret is
configured. If that returns JSON, everything below the deployment layer works.

---

## 6. Next steps, in order

1. **Unblock the 403.** Deployment access → "Anyone". Needs a Workspace admin if
   greyed out. Everything else is untestable until this is done.
2. **Run `setupDatabase()`** once from the Apps Script editor. Builds the 7 tabs
   and migrates master data. Idempotent. Approve the Drive permission prompt —
   `Drive.gs` added the `drive` scope and the web app runs as `USER_DEPLOYING`,
   so without consent GRN writes fail inside `saveBillPhoto`.
3. **Fix the blank emails.** In `PEOPLE`, Satvik (`USR-005`) and Hitesh
   (`USR-006`) have no Email, so `isActiveUser()` cannot match their logins. The
   migration writes `MISSING-satvik` etc. to make the gap visible. Note `CONFIG`
   restricts `AllowedEmailDomain` to `americanhairline.com`, which the seeded
   `@ahl.com` addresses violate — decide which side changes.
4. **Build the read sync.** A `GET`-style action returning `PRODUCTS`, `LISTS`,
   `PEOPLE` and balances from `LEDGER`, so `mock-data.ts` can be deleted and
   `balance` becomes real.
5. **Admin dashboard.** Approvals read `REQUESTS` where `Status = PENDING_APPROVAL`;
   Category P&L groups `LEDGER` by `CategoryID` using `Amount`.

---

## 7. Gotchas

- **Non-ASCII characters in the payload break HMAC verification.** An em
  dash, ₹, a curly quote, or Devanagari text anywhere in the request body
  makes the live endpoint return FORBIDDEN, even with a correct secret and
  clock — something between the client and `doPost()` re-encodes multi-byte
  UTF-8 inconsistently. Fixed by signing and sending an ASCII-safe body
  (`asciiSafeStringify()` in `src/lib/api.ts`, `\uXXXX`-escapes every
  non-ASCII char before it hits the wire; `JSON.parse()` on the Apps Script
  side restores the original text losslessly). Discovered by testing a real
  request with an em dash in `notes` against the live deployment — do not
  revert this thinking it's unnecessary escaping, the plain-ASCII test vector
  above will still pass either way and mask the bug.
- **Base64 in the audit log.** An inlined bill photo is ~800KB of text against a
  **50,000-character cell limit** and throws on append — after the ledger row is
  already written. `redactForAudit()` in `Drive.gs` strips it. Keep that.
- **`next dev` refuses to start** if another instance is running for the same
  directory; it prints the existing port and PID.
- **`middleware.ts` is deprecated** in Next 16 in favour of `proxy`. Currently
  just a warning. Codemod: `npx @next/codemod@canary middleware-to-proxy .`
- **React Compiler lint** flags `Date.now()` and ref reads that it cannot prove
  happen outside render. Use a module counter for list keys, and defer
  `handleSubmit` as `onClick={() => void form.handleSubmit(fn)()}`.
- **One standing lint warning** — react-hook-form's `watch()` is not memoizable.
  Inherent to the library, not a defect.
- **`LockService.getScriptLock()`** is the only thing preventing two concurrent
  writes from computing the same balance. Every handler must run inside it —
  `doPost` already does this; don't add a write path that bypasses it.
