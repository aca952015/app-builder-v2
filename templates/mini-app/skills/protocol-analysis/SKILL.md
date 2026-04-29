---
name: protocol-analysis
description: Analyze the PRD, identify product structure and constraints, and produce a design-ready requirement analysis.
---

# Protocol Analysis

## Objective

先对输入的 PRD 或需求文档做分析与设计，把原始描述整理成可继续细化的需求分析结果。

## Workflow

1. 提取产品目标、业务背景和要解决的核心问题。
2. 识别用户角色、系统边界、主要对象、关键流程和核心页面。
3. 抽取功能约束与非功能约束，尤其是性能、安全、兼容性、部署和外部依赖。
4. 标记原始 PRD 中的含糊点、缺口、默认假设和需要补全的设计决策。
5. 输出一份结构化分析结果，作为后续详细 spec 组装的输入。

## Notes

- 优先保留原文中的业务名词、边界条件和明确约束。
- 可以补充合理设计，但必须明确哪些内容是推断、默认或待确认项。
- 这一步的产物不是最终生成 spec，而是供下一步 `prd-assembly` 使用的分析稿。
