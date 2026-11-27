// Turns the Playwright JSON report into "title<TAB>PASS|FAIL|SKIP<TAB>detail" rows for the results table.
import { readFileSync } from "node:fs";
let report;
try { report = JSON.parse(readFileSync(process.argv[2], "utf8")); } catch { console.log("playwright\tFAIL\tno report (the run crashed)"); process.exit(0); }
const walk = (suite, prefix = []) => [
  ...(suite.specs ?? []).flatMap((s) => s.tests.map((t) => ({ title: [...prefix, s.title].join(" > "), t }))),
  ...(suite.suites ?? []).flatMap((c) => walk(c, c.title && !c.title.endsWith(".ts") ? [...prefix, c.title] : prefix)),
];
for (const { title, t } of report.suites.flatMap((s) => walk(s))) {
  const r = t.results.at(-1);
  const status = t.status === "skipped" ? "SKIP" : t.status === "expected" ? "PASS" : "FAIL";
  const detail = (r?.error?.message ?? t.annotations?.map((a) => a.description).join(" ") ?? "").split("\n")[0].replace(/\u001b\[[0-9;]*m/g, "").slice(0, 160);
  console.log(`${title.replace(/@preflight\s*/, "")}\t${status}\t${detail}`);
}
