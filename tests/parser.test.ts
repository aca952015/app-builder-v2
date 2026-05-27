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

test("parsePrd ignores PRD document structure headings as screens", () => {
  const markdown = [
    "这是一份为您构思的天气预报单页应用（SPA）的产品需求文档（PRD）。",
    "",
    "# 产品需求文档：极简天气 (WeatherOne)",
    "",
    "## 1. 项目概述",
    "本项目旨在开发一款轻量级、响应式的天气预报单页应用（SPA）。",
    "",
    "## 2. 核心目标",
    "* **简洁高效**：用户进入页面后在 3 秒内获取核心天气信息。",
    "* **跨设备兼容**：完美适配移动端和桌面端浏览器。",
    "* **低延迟**：通过轻量化架构减少加载耗时。",
    "",
    "## 3. 用户流程",
    "1. **自动定位**：用户打开页面，应用自动请求地理位置权限并显示当前城市天气。",
    "2. **搜索查询**：用户可通过搜索框输入城市名称查询其他城市天气。",
    "3. **信息查看**：展示当前天气概况、未来小时趋势及未来 5 天预报。",
    "4. **历史记录**：自动保存最近查询的 3 个城市，方便快速切换。",
    "",
    "## 4. 功能需求列表",
    "",
    "| 功能模块 | 优先级 | 功能描述 |",
    "| :--- | :--- | :--- |",
    "| **实时天气** | P0 | 显示当前温度、天气状况、体感温度、湿度、风向及风速。 |",
    "| **小时趋势** | P1 | 以水平滚动条形式显示未来 24 小时气温变化趋势。 |",
    "| **多日预报** | P1 | 显示未来 5 天的日期、天气情况及最高/最低气温。 |",
    "",
    "## 5. 非功能性需求",
    "* **性能**：页面加载时间 < 1.5s，交互响应 < 100ms。",
    "* **设计原则**：采用卡片式 UI 设计，背景随天气情况自动变换。",
    "* **适配性**：兼容主流现代浏览器。",
    "",
  ].join("\n");
  const parsed = parsePrd(markdown);
  const normalized = normalizeSpec(parsed, markdown);

  assert.deepEqual(parsed.screens, []);
  assert.ok(normalized.screens.some((screen) => screen.name === "Dashboard"));
  assert.ok(normalized.screens.some((screen) => screen.name === "Settings"));
  assert.ok(!normalized.screens.some((screen) => screen.route === "/module-1"));
  assert.ok(!normalized.screens.some((screen) => screen.route === "/module-2"));
});

test("parsePrd preserves concrete monitoring dashboards but not non-functional requirement headings", () => {
  const markdown = [
    "# 性能平台",
    "",
    "## 性能监控看板",
    "- 展示接口延迟、首屏加载时间和错误率趋势。",
    "",
    "## 非功能性需求",
    "* **性能**：页面加载时间 < 1.5s，交互响应 < 100ms。",
    "",
  ].join("\n");
  const parsed = parsePrd(markdown);

  assert.ok(parsed.screens.includes("性能监控看板"));
  assert.ok(!parsed.screens.includes("非功能性需求"));
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
