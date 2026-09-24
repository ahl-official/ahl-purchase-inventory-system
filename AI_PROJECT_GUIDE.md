# AHL Flow — Project Guide for AI and CLI Agents

This file is the operational handoff for any AI, coding CLI, or developer working on AHL Flow. Read it before changing the application, Google Sheets, or Google Apps Script.

Last reviewed: 21 September 2026.

## 1. Read order and source of truth

Read these files in this order:

1. `AGENTS.md` — repository instructions. This project uses Next.js 16. Read the relevant local documentation under `node_modules/next/dist/docs/` before changing Next.js code.
2. `AI_PROJECT_GUIDE.md` — this operating guide.
3. `apps-script/Setup.gs` — current database schema and migration code.
4. `apps-script/Code.gs` — API actions, authorization, locking, and idempotency.
5. `src/app/api/gas/route.ts` and `src/lib/api.ts` — frontend-to-Apps-Script transport and HMAC contract.
6. `HANDOFF.md` — useful history and known issues. Some status statements are dated, so verify them against the current code and live read-only checks.


When documents disagree, use this priority:

1. User's latest explicit decision.
2. Current production data, inspected read-only.
3. Current code and `apps-script/Setup.gs` schema.
4. This guide.
5. `HANDOFF.md` historical notes.
6. Old planning documents and mock data.

Use **Salon**, not Studio, in new user-facing names and documentation.

## 2. What the system is

AHL Flow is a mobile-friendly inventory and purchasing application.

```text
Browser / PWA
  -> Next.js client calls POST /api/gas
  -> Next.js authenticates the user and injects the actor email
  -> server signs the exact request body with HMAC-SHA256
  -> Google Apps Script web app validates HMAC, role and operation ID
  -> Apps Script reads or writes AHL Flow DB in Google Sheets
  -> bill/product photos are stored in Google Drive
```

The three layers are separate:

| Layer | Location | Change method |
|---|---|---|
| Next.js UI and server proxy | `src/` | edit files, then lint/typecheck/build |
| Apps Script backend | `apps-script/*.gs` | edit files locally, then deploy with `clasp` |
| Sheet data and formatting | Google Sheets | use Google Sheets/Drive MCP for precise ranges, or the approved Sheet UI |

The application does not use the product-intake spreadsheet directly at runtime. Verified products must be mapped into the production `PRODUCTS` tab without changing existing Product IDs.

## 3. Important Google resources

### Production database

- Name: `AHL Flow DB`
- Spreadsheet ID: `16LFKuCYPOk46dWalYXHcoDYuqPf6mn213pfSp0ukEe4`
- Used by Apps Script through Script Property `SHEET_ID_DB` or the fallback in `apps-script/Setup.gs`.

Core tabs include:

- `PRODUCTS` — product master used by the app.
- `PEOPLE` — users, roles and assigned locations.
- `USER` — temporary login records. Treat as sensitive.
- `LISTS` — categories, vendors, locations, UOMs and settings.
- `PURCHASE_ORDERS` — purchase-order records.
- `LEDGER` — canonical append-only stock movements.
- `REQUESTS` — purchase requests.
- `OPENING_COUNTS` — submitted and approved opening quantities.
- `OPERATIONS` — idempotency records for mutations.
- `AUDIT` — system audit trail.
- `STOCK_*`, `OPENING_*`, `HANDOVER_TRACKER`, `ISSUE_HISTORY`, `IN_USE`, `REPORTS`, and `PURCHASE_TRACKER` — formula-generated views.

### Product intake and opening-stock template

- Name: `AHL Product List and Opening Stock Template`
- Spreadsheet ID: `1JYp_W0ZOiZnZkO8Ca_zCOzU2XpeHml4g4WfcP9wrW8M`
- `Products` tab gid: `1119950004`
- `Opening stock` tab gid: `218008071`

This is a staging and review workbook. It is not the live stock database. Rows marked `To verify` must not be imported as approved master data.

### Original seed/archive workbook

- Spreadsheet ID: `1uXdnPiAvC5AH21jwCYVI6mEWQ7nyGXY8USdQky-RaKg`
- Used only by the initial migration code in `apps-script/Setup.gs`.
- Keep it as an archive. Do not point the running application back to it.

### Apps Script project

- Script ID: `1F2x4lA75QfLyDc80IyxqKEEsfNm9waTJJIJmxYllntUgmYSqmLPKWgvg`
- Portable configuration: root `.clasp.json`
- Production deployment ID currently referenced by `.env.example`:
  `AKfycbwSwWsSPEe5uDGLiMRt-H4XH0bz4ICG-S6Dc40YjUVtvt193A5dAz37kUdzA6S-zMc7XQ`

Before deploying, run `clasp deployments` and confirm the intended deployment still exists. Never print secrets or copy `.env` values into a prompt, issue, commit, or log.

## 4. Google Sheets MCP workflow

Use the installed Google Drive/Google Sheets connector when an AI needs to inspect or change Sheet data, validation, formulas, formatting, frozen rows, or column sizes. MCP tool names vary by client, so discover the connected Google Drive/Sheets tools instead of inventing a command name.

If the environment provides a Google Sheets or Google Drive skill/instruction file, load it before the first connector call and follow its range and verification rules.

### Read workflow

1. Identify the spreadsheet by exact ID, not by a similar title.
2. Fetch spreadsheet metadata and tab names first.
3. Read only the ranges required for the task.
4. Read the header row before interpreting or writing tabular data.
5. Use Product ID, User ID, Location ID, or another stable key. Do not match only on display name.
6. Report any mismatch between the expected schema and the live header row before writing.

### Write workflow

1. Capture the current values and formulas in the exact target range.
2. Calculate the smallest range that needs to change.
3. Preserve formulas, validation, formatting and IDs outside that range.
4. Perform a range-specific update, append, or formatting request.
5. Read the written range back and verify values, formulas and row count.
6. For master-data work, also check duplicate IDs and normalized duplicate names.

### Production Sheet safety

- Never directly edit, delete, sort, or replace existing rows in `LEDGER`, `OPERATIONS`, or `AUDIT` through MCP.
- Never clear or overwrite an entire production tab.
- Never paste the staging product sheet over `PRODUCTS`.
- Never change an existing `ProductID` that is referenced by the ledger.
- Never write a running balance. Stock is derived from signed ledger rows.
- Never type values into formula-generated view tabs. Change their definition in `apps-script/Views.gs`, deploy it, and run the additive upgrade function when appropriate.
- Do not expose `USER` passwords, password hashes, salts, HMAC secrets, service-account keys, or environment files.
- A timeout or uncertain connector response is not permission to repeat a write. Read the target range first and determine whether it landed.

### Product-master import rule

The safe product workflow is:

1. Read existing production `PRODUCTS` IDs and names.
2. Read only reviewed/approved rows from the product-intake workbook.
3. Normalize names for comparison, while keeping the approved display name.
4. Classify each row as existing, possible duplicate, or new.
5. Preserve the Product ID for every existing product.
6. Assign a new unique Product ID only after duplicate review.
7. Require valid `IssueUOM`, `PurchaseUOM`, and `ConvFactor` before use.
8. Use product type `Consumable`, `Retail`, or `Both` for the new product master. Keep existing furniture/asset records and their workflow separate.
9. Write only the approved rows and fields.
10. Read back the changed rows and run a catalogue read through the application backend.

Category is selected when stock is issued or consumed. A product can be used by different categories, so do not permanently force all stock usage into the product's default category.

## 5. Apps Script (`GAS`) development with `clasp`

Google Sheets MCP changes Sheet content. It does not replace the Apps Script deployment workflow.

All Apps Script source must be edited locally in `apps-script/` and committed to Git. Run `clasp` from the repository root so it uses the committed root `.clasp.json`.

### Files

| File | Responsibility |
|---|---|
| `Code.gs` | `doGet`, `doPost`, action routing, roles, locks and idempotency |
| `Validation.gs` | HMAC validation and request validation helpers |
| `Db.gs` | header-name-based Sheet reads and writes |
| `Setup.gs` | schema, initial migration and setup |
| `Ledger.gs` | receipts, issues, handovers, opening stock and dashboard logic |
| `Operations.gs` | catalogue, POs, corrections and operations response |
| `Drive.gs` | bill and product photo storage and audit redaction |
| `Views.gs` | generated Sheet views and additive view/schema upgrades |
| `appsscript.json` | runtime, web-app access and OAuth scopes |

### Before editing Apps Script

```powershell
git status --short
clasp status
clasp deployments
```

Inspect the relevant handler and the matching frontend types/schema. When adding an action, update all of these together:

1. `AppsScriptAction` in `src/lib/api.ts`.
2. `ACTION_ROLES` in `src/app/api/gas/route.ts`.
3. role map and switch routing in `apps-script/Code.gs`.
4. the handler and its validation.
5. the UI/domain schema that sends or receives the payload.

Every mutation must remain inside the `doPost` script lock and must use the `operationId` idempotency flow. Do not create a separate web entry point or write path that bypasses those controls.

All Sheet access must resolve columns by header name through `Db.gs`. Do not use positional row arrays for business records.

### Push and redeploy

After local checks and review:

```powershell
clasp push --force
clasp create-version "Short description of the change"
clasp redeploy AKfycbwSwWsSPEe5uDGLiMRt-H4XH0bz4ICG-S6Dc40YjUVtvt193A5dAz37kUdzA6S-zMc7XQ -V <VERSION_NUMBER>
```

Then verify:

```powershell
node verify-live-deployment.mjs
```

`verify-live-deployment.mjs` performs a signed read. It does not create stock transactions. The `/exec` URL also supports a read-only `GET` health check.

Do not run `clasp deploy` without an existing deployment ID. It creates a new URL and can leave the frontend pointing at an old deployment.

Do not run `clasp pull` casually. It can replace reviewed local source with the remote copy. If a pull is necessary, require a clean Git tree, record the current commit, pull, and inspect the complete diff before continuing.

Functions such as `setupDatabase()` and `upgradeInventoryDatabase()` execute against Google Sheets. Pushing source does not execute them. Run them only when the change explicitly requires a schema/view migration and after reading their current implementation. `setupDatabase()` must never be used as a general product sync on a populated production database.

## 6. There is no fake GAS backend

This repository does not contain a fake Google Apps Script server. Development and production API calls go through the real `/api/gas` proxy to the configured Apps Script deployment.

The old `mock-data.ts` demo values were deleted. The app shows only live data from Apps Script; never invent balances.

If a future agent adds a fake backend for automated tests, it must:

- be enabled only by an explicit test-only environment flag;
- fail closed in production builds;
- keep the same request/response envelope as Apps Script;
- simulate role checks, negative-stock checks and idempotency;
- never use production spreadsheet IDs or credentials;
- be documented here and tested separately from live integration tests.

Do not silently fall back from a failed live request to demo data. Showing no live balance with an error is safer than showing an invented balance.

## 7. Local setup

Prerequisites:

- Node.js and npm.
- Project dependencies from `package-lock.json`.
- `clasp` 3.x authenticated to an account with access to the Apps Script project.
- Local `.env` based on `.env.example`.

```powershell
npm ci
Copy-Item .env.example .env
# Fill secrets locally. Never commit .env.
npm run dev
```

Required environment variables:

```env
AUTH_SECRET="<local secret>"
NEXT_PUBLIC_APPS_SCRIPT_URL="<existing /exec URL>"
HMAC_SECRET="<must exactly match the Apps Script Script Property>"
```

Despite its historical name, `NEXT_PUBLIC_APPS_SCRIPT_URL` is used by server transport code. `HMAC_SECRET` is server-only and must never receive a `NEXT_PUBLIC_` prefix or be imported by a client component.

Apps Script Script Properties:

| Key | Meaning |
|---|---|
| `SHEET_ID_DB` | production `AHL Flow DB` spreadsheet ID |
| `HMAC_SECRET` | exact match for the Next.js server secret |

## 8. Validation commands

Run the checks appropriate to the change:

```powershell
npm run lint
npx tsc --noEmit
npm run build
```

For a live read-only backend check:

```powershell
node verify-live-deployment.mjs
```

`tests/api-flow.mjs` is a live end-to-end test. It calls the real backend as Satvik and Hitesh and **writes dummy data** (three products named `TEST-<id> ...`, with their ledger rows). It is not a routine check. Run it only when live test data is acceptable, and delete the TEST rows before go-live:

```powershell
node tests/api-flow.mjs
```

## 9. Core data rules

These rules protect stock accuracy:

1. `LEDGER` is the stock source of truth. Balance is the sum of `QtyBase * Direction` for non-void rows.
2. `QtyBase` is always expressed in the product's issue unit.
3. A receipt converts purchase quantity through `ConvFactor`.
4. A transfer is two linked ledger rows. It does not create an expense.
5. An issue requires location, category and recipient/person where applicable.
6. Negative available stock is blocked inside the lock.
7. Corrections are explicit return, damage or count-adjustment transactions. Do not rewrite history.
8. Pending handovers reserve sender stock until the receiver confirms or the handover is cancelled.
9. Opening stock enters the ledger only after approval.
10. Every mutation carries a unique operation ID so an uncertain retry cannot duplicate stock.
11. Apps Script `ContentService` normally returns HTTP 200 even for a business rejection. Clients must inspect the response envelope's `success`/`ok` value.
12. Preserve `asciiSafeStringify()` in `src/lib/api.ts`; it prevents HMAC mismatch for non-ASCII names and notes.
13. Keep base64 photos out of audit cells. `redactForAudit()` protects against Google Sheets' cell-size limit.

## 10. Current product and location decisions

- Product types for the new master: `Consumable`, `Retail`, `Both`.
- `Piece in IMS` is not a product type.
- Existing furniture/asset records remain separate because the application has an assignment workflow for them.
- Category is chosen at issue/consumption time.
- Current application logic is mainly hardcoded for `LOC-01` Head Office and `LOC-02` Khar Salon Floor.
- Delhi and Bangalore appear in older/static location data but are not yet implemented as complete custody and transfer workflows.
- Do not describe a branch as a Studio in new UI. Use Salon.

## 11. Safe change sequence

For any task:

1. Restate the requested behavior and identify whether it touches UI, Apps Script, Sheet data, or more than one layer.
2. Inspect `git status` and the relevant source files.
3. Perform live inspection read-only before changing production data.
4. Make the smallest coherent local code change.
5. Run lint, typecheck and build as applicable.
6. Review the diff for secrets, unexpected generated files and schema drift.
7. If Sheet data must change, use MCP with exact ranges and verify by reading back.
8. If Apps Script changed, push, version and redeploy the existing deployment, then run the read-only verifier.
9. Do not create live stock transactions for testing without explicit authorization.
10. Report what changed, what was verified, and any remaining operational step.

## 12. Known gaps to consider before new development

- The production workflow needs a controlled import from the reviewed product master.
- The UI/product filters must support `Both` without breaking the furniture asset workflow.
- Several flows still assume only Head Office and Khar Salon.
- The application currently allows some purchase/receipt paths that can bypass the intended PR -> approval -> PO -> receipt control.
- Three-way PO/receipt/invoice matching and payment release are not complete.
- Daily measured consumption, retail sale transactions and full multi-location reorder rules remain future work.
- Some old components/tests still refer to static mock IDs or older UI wording; verify them against current screens before relying on them.

## 13. Security and handoff rules

- Commit code and documentation, never credentials.
- Keep `.env`, `.env.vercel`, service-account JSON, credentials, cookies and passwords out of Git and AI responses.
- A service account can access the Sheets API if configured, but it cannot replace the HMAC contract used to call the Apps Script web app.
- Never trust an actor/email supplied by browser JSON. The Next.js server must inject it from the authenticated session.
- Keep authorization checks in both the Next.js route and Apps Script.
- When handing the project to another AI, provide the repository and this file. Give account access and secrets through the organization's secure channel, never by editing this guide.
