import fs from "node:fs";
import crypto from "node:crypto";

const env = {};
for (const line of fs.readFileSync(".env", "utf8").split(/\r?\n/)) {
  if (!line || line.startsWith("#") || !line.includes("=")) continue;
  const separator = line.indexOf("=");
  const key = line.slice(0, separator).trim();
  const value = line
    .slice(separator + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
  env[key] = value;
}

const body = JSON.stringify({
  action: "dashboard.read",
  actor: "satvik@ahl.com",
  data: {},
});
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
const firstStock = envelope.data?.stock?.[0];

console.log(
  JSON.stringify(
    {
      http: response.status,
      success: envelope.success,
      responseKeys: Object.keys(envelope),
      service: envelope.service,
      status: envelope.status,
      error: envelope.error,
      stockRows: envelope.data?.stock?.length,
      pendingHandovers: envelope.data?.pendingHandovers?.length,
      openRequests: envelope.data?.openRequests?.length,
      hasCustodySafeFields:
        firstStock &&
        Object.hasOwn(firstStock, "receivingAvailable") &&
        Object.hasOwn(firstStock, "pendingHandover"),
    },
    null,
    2
  )
);

if (!response.ok || !envelope.success || !firstStock) process.exitCode = 1;
