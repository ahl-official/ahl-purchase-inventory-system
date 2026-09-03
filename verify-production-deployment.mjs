import fs from "node:fs";
import crypto from "node:crypto";

const env = {};
for (const line of fs.readFileSync(".env.vercel", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const separator = line.indexOf("=");
  env[line.slice(0, separator).trim()] = line
    .slice(separator + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}

async function call(action, actor = "satvik@ahl.com", data = {}) {
  const body = JSON.stringify({ action, actor, data });
  const timestamp = Date.now();
  const signature = crypto
    .createHmac("sha256", env.HMAC_SECRET)
    .update(`${timestamp}.${body}`, "utf8")
    .digest("base64");
  const target = new URL(env.NEXT_PUBLIC_APPS_SCRIPT_URL);
  target.searchParams.set("ts", String(timestamp));
  target.searchParams.set("sig", signature);
  const response = await fetch(target, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body,
    redirect: "follow",
  });
  const envelope = await response.json();
  if (!response.ok || !envelope.success) throw new Error(`${action}: ${envelope.error || response.status}`);
  return envelope;
}

// Keep these sequential. Apps Script and Sheets can throttle several cold
// spreadsheet reads started at the exact same moment, which makes a healthy
// deployment look intermittently incomplete.
const envelope = await call("dashboard.read");
const opening = await call("opening.list");
const assets = await call("asset.list");
const login = process.env.E2E_PASSWORD
  ? await call("auth.login", "satvik@ahl.com", {
      email: "satvik@ahl.com",
      password: process.env.E2E_PASSWORD,
    })
  : null;
const firstStock = envelope.data?.stock?.[0];
const result = {
  success: envelope.success,
  status: envelope.status,
  error: envelope.error,
  stockRows: envelope.data?.stock?.length,
  assetsArray: Array.isArray(envelope.data?.assetsInUse),
  openingListReady: Array.isArray(opening.data),
  assetListReady: Array.isArray(assets.data),
  loginReady: login ? login.data?.role === "PurchaseCoordinator" : "not tested",
  loginRole: login?.data?.role,
  hasNewLocationFields:
    !!firstStock && "headOfficeBalance" in firstStock && "salonFloorBalance" in firstStock,
};
console.log(JSON.stringify(result, null, 2));
if (!envelope.success || !result.assetsArray || !result.openingListReady || !result.assetListReady || result.loginReady === false || !result.hasNewLocationFields) {
  process.exitCode = 1;
}
