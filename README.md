# AHL Flow

Inventory and purchasing for American Hairline: Next.js app (`src/`) -> signed `/api/gas` proxy -> Google Apps Script (`apps-script/`) -> Google Sheets ledger.

- Setup, data rules and deploy steps: `AI_PROJECT_GUIDE.md` (read it before changing anything).
- Run locally: `npm ci`, copy `.env.example` to `.env`, `npm run dev`.
- Check: `npx tsc --noEmit && npm run lint && npm run build`.
- Live end-to-end test (writes dummy data): `node tests/api-flow.mjs`.
- Read-only backend check: `node verify-live-deployment.mjs`.
