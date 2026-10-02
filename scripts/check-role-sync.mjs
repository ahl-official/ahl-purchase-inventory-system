// Guards against the exact bug that shipped once already: src/app/api/gas/route.ts and
// apps-script/Code.gs each keep their own list of which role can call which action. A role
// granted in one but not the other either silently blocks a real user, or (worse) lets a
// request through the Next.js gate but still fails at the backend. This compares them and
// fails the build if they ever drift apart again.
import fs from "node:fs";

function parseRoutePy(src) {
  const m = src.match(/const ACTION_ROLES[^{]*\{([\s\S]*?)\n\};/);
  const map = {};
  for (const line of m[1].split("\n")) {
    const row = line.match(/"([\w.]+)":\s*\[([^\]]*)\]/);
    if (row) map[row[1]] = row[2].match(/"([\w]+)"/g).map((s) => s.slice(1, -1)).sort();
  }
  return map;
}

function parseCodeGs(src) {
  const m = src.match(/var roles = \{([\s\S]*?)\n\s*\};/);
  const map = {};
  for (const row of m[1].matchAll(/'([\w.]+)':\s*\[([^\]]*)\]/g)) {
    map[row[1]] = row[2].match(/'([\w]+)'/g).map((s) => s.slice(1, -1)).sort();
  }
  return map;
}

const route = parseRoutePy(fs.readFileSync("src/app/api/gas/route.ts", "utf8"));
const backend = parseCodeGs(fs.readFileSync("apps-script/Code.gs", "utf8"));
let ok = true;
const actions = new Set([...Object.keys(route), ...Object.keys(backend)]);
for (const action of actions) {
  const a = route[action], b = backend[action];
  if (!a) { console.error(`route.ts is missing "${action}" (Code.gs has it: ${b})`); ok = false; continue; }
  if (!b) { console.error(`Code.gs is missing "${action}" (route.ts has it: ${a}) -- is this a read-only action that doesn't need a Code.gs entry?`); continue; }
  if (a.join(",") !== b.join(",")) { console.error(`"${action}" differs: route.ts=[${a}] Code.gs=[${b}]`); ok = false; }
}
if (!ok) { console.error("\nFix: make src/app/api/gas/route.ts's ACTION_ROLES match apps-script/Code.gs's roles map."); process.exit(1); }
console.log(`role lists in sync (${actions.size} actions checked)`);
