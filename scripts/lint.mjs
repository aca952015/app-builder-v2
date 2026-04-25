import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const EXTS = new Set([".ts", ".md", ".json", ".mjs"]);
const IGNORE = new Set(["dist", "node_modules", ".tmp", ".out", "generated", ".omx", ".bg-shell", ".gsd", "prds"]);

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (IGNORE.has(entry.name)) {
      continue;
    }

    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
      continue;
    }

    if (EXTS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files;
}

function findIssues(contents) {
  const issues = [];
  const lines = contents.split("\n");

  lines.forEach((line, index) => {
    if (/\t/.test(line)) {
      issues.push(`line ${index + 1}: tab character`);
    }
    if (/\s+$/.test(line)) {
      issues.push(`line ${index + 1}: trailing whitespace`);
    }
  });

  if (!contents.endsWith("\n")) {
    issues.push("missing trailing newline");
  }

  return issues;
}

const files = await collectFiles(ROOT);
const problems = [];

for (const file of files) {
  const contents = await fs.readFile(file, "utf8");
  const issues = findIssues(contents);
  if (issues.length > 0) {
    problems.push(`${path.relative(ROOT, file)}\n  ${issues.join("\n  ")}`);
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

console.log(`lint ok (${files.length} files checked)`);
