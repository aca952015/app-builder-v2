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

test("normalizeSpec assembles external references from parsed PRD sections", () => {
  const markdown = [
    "# Weather Console",
    "",
    "## External APIs",
    "- QWeather realtime API docs: https://dev.qweather.com/docs/api/weather/weather-now/ for endpoint parameters and auth.",
    "",
  ].join("\n");
  const parsed = parsePrd(markdown);
  const normalized = normalizeSpec(parsed, markdown);

  assert.equal(normalized.externalReferences.length, 1);
  assert.equal(normalized.externalReferences[0]?.url, "https://dev.qweather.com/docs/api/weather/weather-now/");
  assert.equal(normalized.externalReferences[0]?.type, "external_api");
  assert.equal(normalized.externalReferences[0]?.required, true);
});

test("normalizeSpec skips image resources when extracting external references", () => {
  const markdown = [
    "# Visual Weather Console",
    "",
    "## References",
    "- API docs: https://docs.example.com/weather/current for endpoint parameters.",
    "- Screenshot: https://cdn.example.com/weather-dashboard.png",
    "- Architecture diagram: ![Architecture](https://assets.example.com/render?id=weather-dashboard)",
    "- Inline asset: [chart image](https://cdn.example.com/chart.webp).",
    "",
  ].join("\n");
  const parsed = parsePrd(markdown);
  const normalized = normalizeSpec(parsed, markdown);

  assert.deepEqual(
    normalized.externalReferences.map((reference) => reference.url),
    ["https://docs.example.com/weather/current"],
  );
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

test("parsePrd prefers a no-H1 product title over directory section headings", () => {
  const markdown = [
    "**YD-LIMS易达智检实验室管理系统**",
    "",
    "**用户手册**",
    "",
    "- 目录",
    "- [1. **编写目的**](#_Toc20629)",
    "- [2. 系统登录](#_Toc10643)",
    "",
    "# 1. **编写目的**",
    "",
    "**YD-LIMS易达智检实验室管理系统**用于实验室合同、样品、检测、报告和设备管理。",
    "",
  ].join("\n");

  const parsed = parsePrd(markdown);

  assert.equal(parsed.title, "YD-LIMS易达智检实验室管理系统");
  assert.equal(parsed.sections[1]?.heading, "1. 编写目的");
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
