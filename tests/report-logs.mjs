// Turns the tail of each test log into GitHub annotations, so results are readable from the run page
// (and through the public API) without downloading raw logs.
import { existsSync, readFileSync } from "node:fs";

const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "").replace(/\n/g, "%0A");
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) { console.log(`::notice title=${file}::(no log written)`); continue; }
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !/^::/.test(l) && !/Downloading|Progress:|▕|░|█/.test(l))
    .map((l) => l.replace(/^PASS  /, "✓ ").replace(/^FAIL  /, "✗ FAIL "));
  const text = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "").slice(-14000);
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < 4; i += 3500) chunks.push(text.slice(i, i + 3500));
  chunks.forEach((c, i) => console.log(`::notice title=${file} (${i + 1}/${chunks.length})::${esc(c)}`));
}
