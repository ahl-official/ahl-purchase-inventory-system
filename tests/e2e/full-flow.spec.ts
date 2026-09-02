import { test, expect, type Page } from "@playwright/test";
import path from "path";

const TEST_IMAGE = path.join(__dirname, "fixtures", "test-photo.png");
const NEW_PRODUCT_LABEL = "[E2E TEST] Playwright Widget";
const E2E_PASSWORD = process.env.E2E_PASSWORD ?? "";

if (!E2E_PASSWORD) {
  throw new Error("Set E2E_PASSWORD before running the end-to-end suite.");
}

// IDs pulled straight from src/lib/mock-data.ts -- selecting by value instead
// of by visible label text, since Playwright's selectOption label matcher
// only accepts an exact string, not a pattern.
const ALOE_VERA_GEL = "PRD-0015";
const HAIR_PATCH_GRADE_A = "PRD-0001";
const GAURI = "USR-012";
const ANITA = "USR-013";
const HAIRTECH_INDIA = "VND-01";
const AHL_SERVICE = "CAT-02";
const NEW_PRODUCT_SENTINEL = "__NEW__";

async function loginAs(page: Page, email: string) {
  // If a previous session is still active (switching from Satvik to
  // Hitesh), sign out first -- middleware redirects an already-logged-in
  // user away from /login back to their own home page, so the login form
  // never actually renders and the next line waits forever for it.
  const signOutBtn = page.getByRole("button", { name: /sign out/i });
  if (await signOutBtn.isVisible().catch(() => false)) {
    await signOutBtn.click();
    await page.waitForURL((url) => url.pathname.startsWith("/login"), { timeout: 15_000 });
  }

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(E2E_PASSWORD);
  await page.getByRole("button", { name: /sign in/i }).click();
  // The app does a hard navigation to "/" after sign-in, then middleware
  // routes by role -- wait for that redirect to land, not just for "/login"
  // to disappear from the URL.
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
}

test.describe.configure({ mode: "serial" });

test("full purchase-to-issue flow, both roles", async ({ page }) => {
  // ---------------------------------------------------------- Satvik: login
  await test.step("Satvik logs in and lands on Purchase Hub", async () => {
    await loginAs(page, "satvik@ahl.com");
    await expect(page).toHaveURL(/\/purchase/);
    await expect(page.getByRole("heading", { name: "Purchase Hub" })).toBeVisible();
  });

  // --------------------------------------------------- Log Request: normal
  await test.step("Log a normal request (Aloe Vera Gel)", async () => {
    await page.getByRole("tab", { name: /log request/i }).click();
    await page.locator("#req-product").selectOption(ALOE_VERA_GEL);
    await page.locator("#req-qty").fill("5");
    await page.locator("#req-by").selectOption(GAURI);
    await page.getByRole("button", { name: /^log request$/i }).click();
    await expect(page.getByText(/request logged/i)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/added to the purchase queue/i)).toBeVisible();
  });

  // ------------------------------------------- Log Request: over threshold
  await test.step("Log a request over the approval threshold", async () => {
    await page.locator("#req-product").selectOption(HAIR_PATCH_GRADE_A);
    await page.locator("#req-qty").fill("1"); // 1 x ₹8,500 > ₹5,000
    await page.locator("#req-by").selectOption(GAURI);

    await expect(page.locator("#req-approved-by")).toBeVisible();

    // Submitting with no approver picked should be blocked -- react-hook-form's
    // own "required" validator on the field fires before the component's own
    // banner-based check ever gets a chance to run, so the real UX is an
    // inline field error, not a banner.
    await page.getByRole("button", { name: /^log request$/i }).click();
    await expect(page.getByText(/needs a name here before it can be logged/i)).toBeVisible();

    // Value is the approver's display name, not an id -- see MOCK_APPROVERS.
    await page.locator("#req-approved-by").selectOption("Jagruti Mam");
    await page.getByRole("button", { name: /^log request$/i }).click();
    await expect(page.getByText(/recorded as approved by/i)).toBeVisible({ timeout: 60_000 });
  });

  // ------------------------------------------------- Log Request: new item
  await test.step("Log a brand-new-product request", async () => {
    await page.locator("#req-product").selectOption(NEW_PRODUCT_SENTINEL);
    await expect(page.locator("#req-new-name")).toBeVisible();
    await page.locator("#req-new-name").fill(NEW_PRODUCT_LABEL);
    await page.locator("#req-qty").fill("2");
    await page.locator("#req-by").selectOption(GAURI);
    await page.getByRole("button", { name: /^log request$/i }).click();
    await expect(page.getByText(/flagged as a new product/i)).toBeVisible({ timeout: 60_000 });
  });

  // ------------------------------------------- Receive Delivery (the spot
  // the user reported trouble with) -- probe every field individually so a
  // failure here points at exactly which one broke.
  await test.step("Switch to Receive Delivery tab", async () => {
    await page.getByRole("tab", { name: /receive delivery/i }).click();
    await expect(page.locator("#grn-product")).toBeVisible();
  });

  await test.step("Fill every GRN field", async () => {
    await page.locator("#grn-product").selectOption(ALOE_VERA_GEL);
    await page.locator("#grn-qty").fill("50");
    await expect(page.locator("#grn-location")).toHaveValue("LOC-07");
    await page.locator("#grn-vendor").selectOption(HAIRTECH_INDIA);
    await page.locator("#grn-category").selectOption(AHL_SERVICE);
    await page.locator("#grn-po").fill("PO-E2E-001");
    await page.locator("#grn-invoice").fill("INV-E2E-001");
    await page.locator("#grn-amount").fill("100");
    await expect(page.locator("#grn-received-by")).toBeVisible();
  });

  await test.step("Submitting with no bill photo is blocked", async () => {
    const confirmBtn = page.getByRole("button", { name: /confirm receipt/i });
    await expect(confirmBtn).toBeDisabled();
  });

  await test.step("Attach bill photo and submit GRN", async () => {
    const billSection = page.locator("section", { hasText: "Bill photo" });
    await billSection.locator('input[type="file"]').setInputFiles(TEST_IMAGE);
    await expect(billSection.getByText("Attached")).toBeVisible({ timeout: 10_000 });

    const confirmBtn = page.getByRole("button", { name: /confirm receipt/i });
    await expect(confirmBtn).toBeEnabled();
    await confirmBtn.click();
    await expect(page.getByText(/stock received/i)).toBeVisible({ timeout: 60_000 });
  });

  // ------------------------------------------------------------ Handover
  await test.step("Hand the received stock over to Hitesh", async () => {
    await page.getByRole("tab", { name: /handover/i }).click();
    await page.locator("#ho-product").selectOption(ALOE_VERA_GEL);
    await page.locator("#ho-qty").fill("50");
    await expect(page.locator("#ho-to")).toBeVisible();
    await page.getByRole("button", { name: /log handover/i }).click();
    await expect(page.getByText(/handed over/i)).toBeVisible({ timeout: 60_000 });
    // Scoped to the pending-handovers panel -- an unscoped page-wide text
    // search also matches the (now hidden) <option> still sitting in the
    // reset product <select>, which is a strict-mode violation. .first()
    // because reruns of this test leave their own prior handovers pending
    // too (this suite doesn't clean up after itself) -- more than one match
    // is expected and fine, not a sign of anything broken.
    const pendingPanel = page.locator("section", { hasText: "Awaiting Hitesh" });
    await expect(pendingPanel.getByText(/aloe vera gel/i).first()).toBeVisible();
  });

  // ------------------------------------------------------ Hitesh: confirm
  await test.step("Hitesh logs in and confirms the handover", async () => {
    await loginAs(page, "hitesh@ahl.com");
    await expect(page).toHaveURL(/\/stock-out/);

    await page.getByRole("tab", { name: /confirm handovers/i }).click();
    await expect(page.getByText(/aloe vera gel/i).first()).toBeVisible({ timeout: 60_000 });

    const row = page.locator("li", { hasText: "Aloe Vera Gel" }).first();
    await row.getByRole("button", { name: /confirm/i }).click();
    await expect(page.getByText(/handover confirmed/i)).toBeVisible({ timeout: 60_000 });
  });

  // -------------------------------------------------------- Hitesh: issue
  await test.step("Hitesh issues stock to a technician", async () => {
    await page.getByRole("tab", { name: /issue stock/i }).click();
    await page.getByRole("button", { name: /Aloe Vera Gel/i }).click();

    await page.locator("#qty-0").fill("10");
    await page.getByRole("button", { name: "AHL Service" }).click();
    await page.locator("#to-0").selectOption(ANITA);

    await page.getByRole("button", { name: /confirm issue/i }).click();
    await expect(page.getByText(/stock issued/i)).toBeVisible({ timeout: 60_000 });
  });

  // -------------------------------------------------------------- Dashboard
  await test.step("Dashboard reflects the whole chain", async () => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible();

    // The product row for Aloe Vera Gel should exist after the whole chain.
    const stockRow = page.locator("tr", { hasText: "Aloe Vera Gel" });
    await expect(stockRow).toBeVisible({ timeout: 60_000 });

    // The new-product request should show up, tagged. .first() because
    // reruns of this suite create another request with the same fixed
    // label each time (no cleanup between runs) -- that's expected.
    await expect(page.getByText(NEW_PRODUCT_LABEL).first()).toBeVisible();
    await expect(page.getByText(/new product/i).first()).toBeVisible();

    // Recent activity should mention the product from every stage.
    await expect(
      page.locator("li", { hasText: "Aloe Vera Gel" }).first()
    ).toBeVisible();
  });
});
