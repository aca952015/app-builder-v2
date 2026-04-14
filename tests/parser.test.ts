import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parsePrd } from "../src/lib/prd-parser.js";
import { normalizeSpec } from "../src/lib/spec-normalizer.js";

const FIXTURE_PATH = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");

test("parsePrd extracts the main product ingredients from markdown", async () => {
  const markdown = await readFile(FIXTURE_PATH, "utf8");
  const parsed = parsePrd(markdown);

  assert.equal(parsed.title, "Field Ops Planner");
  assert.equal(parsed.entities.length, 2);
  assert.deepEqual(parsed.roles, ["Operations manager", "Field technician"]);
  assert.ok(parsed.flows.length >= 3);
});

test("normalizeSpec adds routes and default CRUD screens", async () => {
  const markdown = await readFile(FIXTURE_PATH, "utf8");
  const parsed = parsePrd(markdown);
  const normalized = normalizeSpec(parsed, markdown);

  assert.equal(normalized.entities[0]?.name, "Work Order");
  assert.equal(normalized.entities[0]?.routeSegment, "work-orders");
  assert.ok(normalized.screens.some((screen) => screen.route === "/work-orders"));
  assert.equal(normalized.defaultsApplied.length, 0);
});
