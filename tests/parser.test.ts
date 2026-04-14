import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { parsePrd } from "../src/lib/prd-parser.js";
import { normalizeSpec } from "../src/lib/spec-normalizer.js";

const FIXTURE_PATH = path.resolve(process.cwd(), "tests/fixtures/sample-spec.md");
const ENERGY_FIXTURE_PATH = path.resolve(process.cwd(), "tests/fixtures/energy-prd.md");

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

test("parsePrd recognizes OCR-style Chinese energy PRDs", async () => {
  const markdown = await readFile(ENERGY_FIXTURE_PATH, "utf8");
  const parsed = parsePrd(markdown);

  assert.equal(parsed.title, "能源管理系统");
  assert.match(parsed.summary, /双碳|能源的可视化管理/);
  assert.ok(parsed.screens.includes("能源三级管控"));
  assert.ok(parsed.screens.includes("能源计划"));
  assert.ok(parsed.screens.includes("报警管理"));
  assert.ok(parsed.screens.includes("统计报表"));
});

test("normalizeSpec infers energy domain structure from Chinese PRDs", async () => {
  const markdown = await readFile(ENERGY_FIXTURE_PATH, "utf8");
  const parsed = parsePrd(markdown);
  const normalized = normalizeSpec(parsed, markdown);

  assert.equal(normalized.appName, "能源管理系统");
  assert.equal(normalized.slug, "app");
  assert.equal(normalized.entities.length, 0);
  assert.equal(normalized.roles.length, 0);
  assert.ok(normalized.screens.some((screen) => screen.name === "能源三级管控"));
  assert.ok(normalized.screens.some((screen) => screen.name === "能源计划"));
  assert.ok(normalized.screens.some((screen) => screen.name === "报警管理"));
  assert.ok(normalized.screens.some((screen) => screen.route === "/planning"));
  assert.ok(normalized.screens.some((screen) => screen.route === "/alerts"));
  assert.ok(normalized.screens.some((screen) => screen.route === "/analysis"));
  assert.equal(normalized.defaultsApplied.length, 0);
  assert.ok(
    normalized.warnings.some((warning) => warning.includes("No structured data model was detected")),
  );
});
