import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TEXT = /\.(js|mjs|cjs|sh|py|md|json|jsonc|yml|yaml|txt)$/i;
const files = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && TEXT.test(f));

const bad = files.filter((f) => readFileSync(f, "utf8").includes("\r"));
if (bad.length) {
  console.error(`CRLF found in ${bad.length} file(s):`);
  for (const f of bad) console.error(`  - ${f}`);
  console.error("Fix: git add --renormalize . && git checkout -- .");
  process.exit(1);
}
console.log(`LF check: ${files.length} files OK`);
