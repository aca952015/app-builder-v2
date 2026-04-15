# Full-Stack 模板包

这个目录现在表示一个 `deepagents` 模板包，而不是静态源码模板。

生成流程会先读取本目录下的 `template.json`，然后把模板内容直接复制到输出项目的 `.deepagents/` 中。这样生成出来的项目会保留模板提示词、参考文档，以及后续可扩展的模板资产，方便之后继续让 agent 基于同一套约束做增量生成。

当前默认执行模型是：

- 宿主先加载 `prompts/plan-system-prompt.md`，产出结构化 `plan-spec.json` 与配套 Markdown 分析稿
- 如果计划校验失败，宿主切换到 `prompts/plan-repair-system-prompt.md` 做定点修补
- 宿主验证 `plan-spec.json` 后，再加载 `prompts/generate-system-prompt.md`
- 如果生成校验失败，宿主切换到 `prompts/generate-repair-system-prompt.md` 做定点修补
- 生成阶段只读取已验证的 `planSpec`，把应用源码写到输出项目根目录
- `.deepagents/` 只保留模板上下文、分析过程和运行工件

## 当前内容

- `template.json`
  模板元数据与入口配置。
- `prompts/plan-system-prompt.md`
  计划阶段 prompt，负责结构化 spec 定义与计划工件落盘。
- `prompts/plan-repair-system-prompt.md`
  计划修复阶段 prompt，负责按校验失败项修补现有计划产物。
- `prompts/generate-system-prompt.md`
  生成阶段 prompt，负责基于已验证 `planSpec` 产出代码。
- `prompts/generate-repair-system-prompt.md`
  生成修复阶段 prompt，负责按校验失败项修补现有代码。
- `references/generated-app-architecture.md`
  当前 full-stack 模板生成结果的架构说明。

## 设计意图

这个模板包的目标不是直接拷贝应用源码，而是为 deepagents 提供一套可复制、可保留、可演进的生成上下文，包括：

- 模板身份与版本
- prompt 定义
- 可选的 skill 定义
- 可选的 starter 文件
- 参考架构和约束文档

## 约定

- 如果模板新增技能，放到 `skills/` 下。
- 如果模板新增 starter 文件，放到 `starter/` 下。
- 如果模板新增设计或架构参考，放到 `references/` 下。
- 修改模板 prompt 或参考资料后，应同步更新 `template.json` 描述，并确保生成器测试仍然通过。
