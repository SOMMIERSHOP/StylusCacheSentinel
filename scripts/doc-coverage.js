#!/usr/bin/env node
/**
 * Inline documentation coverage checker for the TypeScript sources.
 *
 * Milestone 5 commits to at least 80% of code functions and modules carrying
 * inline documentation comments. This script measures that directly: every
 * exported declaration in src/ must be immediately preceded by a JSDoc block
 * (`/** ... *\/`), and every module must open with one.
 *
 * Plain `//` comments do not count — the KPI is about documentation a reader
 * or a doc generator can consume, not incidental remarks.
 *
 * Usage:
 *   node scripts/doc-coverage.js           # report coverage, exit 1 if below 80%
 *   node scripts/doc-coverage.js --list    # also list every undocumented symbol
 */

const fs = require("node:fs");
const path = require("node:path");

const THRESHOLD = 80;
const SRC = path.join(__dirname, "..", "src");

/**
 * Recursively collect every .ts file under a directory.
 *
 * @param {string} dir - directory to walk
 * @returns {string[]} absolute paths to TypeScript files, sorted
 */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

// Exported declarations we expect to carry documentation. Re-exports
// (`export { x } from "./y"`) and bare `export type { ... }` forwarding are
// excluded: the documentation belongs on the original declaration.
const EXPORT_RE =
  /^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(function|const|let|var|class|interface|type|enum|abstract\s+class)\s+([A-Za-z0-9_$]+)/;

/**
 * Determine whether the line at `index` is immediately preceded by a JSDoc
 * block, allowing blank lines and single-line `//` comments in between.
 *
 * @param {string[]} lines - all lines of the file
 * @param {number} index - zero-based index of the declaration line
 * @returns {boolean} true if a JSDoc block precedes the declaration
 */
function hasJsDocAbove(lines, index) {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (line.startsWith("//")) continue;
    return line.endsWith("*/");
  }
  return false;
}

/**
 * Determine whether a file opens with a module-level JSDoc block, allowing a
 * leading shebang and blank lines.
 *
 * @param {string[]} lines - all lines of the file
 * @returns {boolean} true if the file starts with a JSDoc block
 */
function hasModuleDoc(lines) {
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#!")) continue;
    return line.startsWith("/**");
  }
  return false;
}

const listAll = process.argv.includes("--list");
const files = walk(SRC);
const root = path.join(__dirname, "..");

let documented = 0;
let total = 0;
const undocumented = [];

for (const abs of files) {
  const rel = path.relative(root, abs);
  const lines = fs.readFileSync(abs, "utf8").split("\n");

  // The module header counts as one documentable unit ("modules" in the KPI).
  total++;
  if (hasModuleDoc(lines)) documented++;
  else undocumented.push(`${rel}:1  (module header)`);

  lines.forEach((line, i) => {
    const m = line.match(EXPORT_RE);
    if (!m) return;
    total++;
    if (hasJsDocAbove(lines, i)) documented++;
    else undocumented.push(`${rel}:${i + 1}  ${m[1]} ${m[2]}`);
  });
}

const pct = total === 0 ? 0 : (documented / total) * 100;

console.log("\n  Inline documentation coverage — threshold %d%%\n", THRESHOLD);
console.log(`  files scanned:        ${files.length}`);
console.log(`  documentable units:   ${total}  (module headers + exported declarations)`);
console.log(`  documented:           ${documented}`);
console.log(`  undocumented:         ${undocumented.length}`);
console.log(`  coverage:             ${pct.toFixed(1)}%\n`);

if (undocumented.length > 0) {
  const shown = listAll ? undocumented : undocumented.slice(0, 15);
  console.log("  undocumented units:");
  for (const u of shown) console.log(`    ${u}`);
  if (!listAll && undocumented.length > shown.length) {
    console.log(`    ... and ${undocumented.length - shown.length} more (--list to see all)`);
  }
  console.log();
}

if (pct < THRESHOLD) {
  console.error(`  FAIL — ${pct.toFixed(1)}% is below the ${THRESHOLD}% threshold\n`);
  process.exit(1);
}

console.log(`  PASS — ${pct.toFixed(1)}% >= ${THRESHOLD}%\n`);
