#!/usr/bin/env node
/**
 * Flesch Reading Ease checker for the project's Markdown documentation.
 *
 * Milestone 5 commits to a Flesch Reading Ease score of 60 or higher across
 * the documentation set. This script measures it so the claim is reproducible
 * rather than asserted.
 *
 * Prose only: fenced code blocks, inline code, tables, headings, link targets,
 * and shell snippets are stripped before scoring, because identifiers like
 * `defaultPolicy.headroomPercent` are not English words and would distort both
 * the syllable and the word counts.
 *
 * Usage:
 *   node scripts/readability.js                 # score every documentation file
 *   node scripts/readability.js docs/bidding.md # score specific files
 */

const fs = require("node:fs");
const path = require("node:path");

const THRESHOLD = 60;

const DEFAULT_FILES = [
  "README.md",
  "CONTRIBUTING.md",
  ...fs
    .readdirSync(path.join(__dirname, "..", "docs"))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join("docs", f)),
];

/**
 * Strip everything that is not English prose from a Markdown document.
 *
 * @param {string} md - raw Markdown source
 * @returns {string} prose with code, tables, headings, and link targets removed
 */
function stripToProse(md) {
  return (
    md
      // fenced code blocks, including ```jsonc / ```bash
      .replace(/```[\s\S]*?```/g, " ")
      // indented code blocks (four spaces at line start)
      .replace(/^ {4,}\S.*$/gm, " ")
      // markdown tables — rows and separators alike
      .replace(/^\s*\|.*$/gm, " ")
      // headings are labels, not sentences
      .replace(/^#{1,6}\s.*$/gm, " ")
      // horizontal rules
      .replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, " ")
      // images and links: keep the visible text, drop the target
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // inline code — must run BEFORE the bare-URL rule below. A URL inside
      // backticks would otherwise have its closing backtick consumed as part
      // of the URL, leaving an unbalanced backtick that swallows real prose.
      .replace(/`[^`]*`/g, " ")
      // bare URLs — stop at whitespace or any closing delimiter
      .replace(/<?https?:\/\/[^\s`)>\]]+>?/g, " ")
      // emphasis markers, blockquote markers, list bullets
      .replace(/[*_]{1,3}/g, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/^\s*[-+*]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      // leftover HTML
      .replace(/<[^>]+>/g, " ")
  );
}

/**
 * Count syllables in a single English word using the standard vowel-group
 * heuristic (vowel runs, minus a silent trailing "e", minimum one).
 *
 * @param {string} word - a single lowercase alphabetic word
 * @returns {number} estimated syllable count, at least 1
 */
function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;

  const groups = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "")
    .replace(/^y/, "")
    .match(/[aeiouy]{1,2}/g);

  return groups ? groups.length : 1;
}

/**
 * Compute Flesch Reading Ease for a block of prose.
 *
 * @param {string} prose - text with code and markup already stripped
 * @returns {{score: number, words: number, sentences: number, syllables: number}}
 */
function flesch(prose) {
  const sentences = prose
    .split(/[.!?]+(?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const words = prose.match(/[A-Za-z][A-Za-z'-]*/g) ?? [];
  const syllables = words.reduce((acc, w) => acc + countSyllables(w), 0);

  if (words.length === 0 || sentences.length === 0) {
    return { score: 0, words: 0, sentences: 0, syllables: 0 };
  }

  const score =
    206.835 -
    1.015 * (words.length / sentences.length) -
    84.6 * (syllables / words.length);

  return {
    score,
    words: words.length,
    sentences: sentences.length,
    syllables,
  };
}

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : DEFAULT_FILES;

const root = path.join(__dirname, "..");
let totalWords = 0;
let totalSentences = 0;
let totalSyllables = 0;
const failures = [];

console.log("\n  Flesch Reading Ease — threshold %d\n", THRESHOLD);
console.log("  %s %s %s %s", "file".padEnd(28), "score".padStart(7), "words".padStart(7), "sent".padStart(6));
console.log("  " + "-".repeat(51));

for (const rel of files) {
  const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
  const md = fs.readFileSync(abs, "utf8");
  const r = flesch(stripToProse(md));

  totalWords += r.words;
  totalSentences += r.sentences;
  totalSyllables += r.syllables;

  const pass = r.score >= THRESHOLD;
  if (!pass) failures.push({ file: rel, score: r.score });

  console.log(
    "  %s %s %s %s  %s",
    rel.padEnd(28),
    r.score.toFixed(1).padStart(7),
    String(r.words).padStart(7),
    String(r.sentences).padStart(6),
    pass ? "ok" : "BELOW"
  );
}

const overall =
  206.835 -
  1.015 * (totalWords / totalSentences) -
  84.6 * (totalSyllables / totalWords);

console.log("  " + "-".repeat(51));
console.log(
  "  %s %s %s %s",
  "OVERALL".padEnd(28),
  overall.toFixed(1).padStart(7),
  String(totalWords).padStart(7),
  String(totalSentences).padStart(6)
);
console.log();

if (overall < THRESHOLD) {
  console.error(
    `  FAIL — overall score ${overall.toFixed(1)} is below the ${THRESHOLD} threshold\n`
  );
  process.exit(1);
}

if (failures.length > 0) {
  console.log(
    `  overall passes at ${overall.toFixed(1)}, but ${failures.length} file(s) score below ${THRESHOLD}:`
  );
  for (const f of failures) {
    console.log(`    ${f.file} (${f.score.toFixed(1)})`);
  }
  console.log();
}

console.log(`  PASS — overall ${overall.toFixed(1)} >= ${THRESHOLD}\n`);
