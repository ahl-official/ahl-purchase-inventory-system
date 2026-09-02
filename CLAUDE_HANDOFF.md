> [!WARNING]
> **SUPERSEDED — 29 Aug 2026. Do not build against this document.**
> The schema described below does not exist in the spreadsheet. Building against
> it caused column-misaligned writes that had to be reverted.
> **Read `HANDOFF.md` instead.** This file is kept only as a record of the
> original brief.

---

# AHL Flow: Project Context & Handoff Guide

This document contains the complete context, architecture, and remaining requirements for the AHL Flow application.

## 🏗️ Architecture & Tech Stack
- **Frontend**: Next.js 15 (App Router), React, Tailwind CSS, shadcn/ui.
- **Authentication**: `next-auth` (Credentials Provider). Roles: `Admin`, `PurchaseCoordinator`, `ProductDistributor`.
- **Backend Database**: Google Sheets (21 Tables).
- **Backend API**: Google Apps Script (Web App) handling concurrent writes using `LockService`. 
- **Security**: The Next.js app communicates with Apps Script via `POST` requests. Every payload must be signed using HMAC-SHA256.

## 📍 Current State (What is already built)
1. **Phase M0 (Auth & Routing):** 
   - `src/middleware.ts` is fully implemented. It protects routes based on the session role.
   - `/login` works using standard email/password (Admin, Satvik, Hitesh).
2. **Phase M1 (Stock Out - Hitesh's Workflow):** 
   - UI built at `src/app/stock-out/page.tsx`. Fully responsive dashboard.
3. **Backend (Apps Script):** 
   - Deployed and live. Contains `processStockIssue` and `processStockReceive`. 
   - Uses `LockService.getScriptLock()` to prevent race conditions during high-volume stock updates.
   - Verifies incoming Next.js requests using `verifyHmac()`.

---

## 🎯 What You Need to Build Next (Remaining Tasks)

### Task 1: API Utility (HMAC Signing)
Currently, the UI forms just trigger an `alert()`. You need to build the `fetch` utility that talks to the Google Apps Script Web App.
- **Requirement:** Create `src/lib/api.ts`.
- **Logic:** For every POST request to `process.env.NEXT_PUBLIC_APPS_SCRIPT_URL`, you must generate a timestamp and an HMAC-SHA256 signature of the payload using `process.env.HMAC_SECRET`. 
- **Payload Structure:** 
  ```json
  {
    "action": "stock.issue", // or "stock.receive", "purchase.request"
    "actor": "user@ahl.com",
    "data": { ... }
  }
  ```

### Task 2: Complete the Purchase Hub (`src/app/purchase/page.tsx`)
This is Satvik's workspace. Half of the UI is scaffolded, but it needs functionality.
- **WhatsApp Request Logger:** Wire up the existing UI form to send a `purchase.request` payload to the backend.
- **GRN Photo Capture (Critical):** Build a new component `<PhotoCapture />`.
  - **Requirement:** Satvik must take a photo of physical delivery bills using his phone/laptop camera.
  - **Flow:** The component should compress the image on the client-side -> convert to Base64 -> send to Apps Script inside the `stock.receive` payload.
  - **Backend Update:** You will need to update `Code.gs` / `Ledger.gs` to decode the Base64 string, save the image file to Google Drive, and store the Drive URL in the Google Sheet.

### Task 3: Build the Admin Dashboard (`src/app/admin/page.tsx`)
This is the workspace for Management (Jagruti/Vishal). It is currently a blank placeholder.
- **Approvals UI:** A dashboard to view pending purchase requests (specifically those over ₹5,000) and click "Approve" or "Reject".
- **Three-Way Match UI:** A screen comparing the Purchase Order, the Bill Photo (from Google Drive), and the GRN before Management authorizes payment to the vendor.
- **Category P&L:** A read-only dashboard summarizing expenses grouped by Category (e.g., SMB, Hair, Skin).

## 🔑 Environment Variables Available
```env
NEXT_PUBLIC_APPS_SCRIPT_URL="https://script.google.com/macros/s/.../exec"
HMAC_SECRET="<set-in-local-env-and-apps-script-properties>"
```
*(Plus standard NextAuth secrets and credentials in `.env`)*

## ⚠️ Important Rules for Implementation
1. **Never use free-text inputs** for Master Data (Users, Products, Categories). Always use dropdowns/selects populated from Master Data (currently located in `src/lib/mock-data.ts` until read-sync is built).
2. **Thumb-Zone Optimization:** Hitesh and Satvik use phones on the floor. Primary actions (like "CONFIRM") must be large sticky buttons at the bottom of the screen.
3. **Offline-first feel:** Use optimistic UI updates where possible so the users are never blocked waiting for the Apps Script backend to respond.
