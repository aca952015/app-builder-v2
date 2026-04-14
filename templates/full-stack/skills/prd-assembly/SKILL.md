---
name: prd-assembly
description: Assemble a detailed implementation-ready spec from the PRD analysis and design decisions.
---

# PRD Assembly

## Objective

把分析结果与设计决策组装成一份更详细、可直接用于生成应用的 spec。

## Requirements

- 生成的 spec 必须足够详细，能够直接指导页面、数据模型、流程和文案生成。
- 每个章节都应可被测试、评审或继续拆分。
- 功能需求要尽量写成清晰条目，并补全必要的默认设计。
- 非功能需求、边界约束、异常情况和权限要求不得遗漏。
- 风险、假设与待确认项要明确标出，而不是隐藏。

## Expected Sections

- 产品概述
- 用户角色与目标
- 信息架构与页面清单
- 数据模型与字段定义
- 核心流程与交互规则
- 权限与状态约束
- 非功能需求
- 默认假设、风险与待确认项

## Notes

- 这一步输出的是“生成用详细 spec”，后续生成应以这份 spec 作为唯一事实来源。
- 如果原始 PRD 信息不足，可以基于常见 SaaS/内部工具模式做保守补全，但要把补全内容显式写出。
