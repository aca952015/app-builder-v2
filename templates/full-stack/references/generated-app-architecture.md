# Full-Stack 模板生成架构

这份文档描述当前 `full-stack` 模板实际生成的 Web 应用架构。

当前模板描述的是目标应用结构与约定，不依赖任何外部仓库路径。这里记录的是这个模板当前会产出的项目结构，便于模板提示词、技能和后续 agent 扩展保持一致。

## 技术栈

- Next.js 15 App Router
- React 19
- TypeScript
- Prisma
- PostgreSQL
- Tailwind CSS
- 基于 signed cookie 的邮箱密码登录

## 生成结果概览

每次生成会输出一个可直接启动的 Next.js 全栈项目，核心内容包括：

- 一个受保护的仪表盘首页
- 一个登录页
- 一个设置页
- 一个健康检查接口
- 每个实体一组完整的 CRUD 页面
- Prisma schema 和 seed 脚本
- 项目级 README 与生成报告

## 目录结构

```text
app/
  layout.tsx
  page.tsx
  not-found.tsx
  login/
    actions.ts
    page.tsx
  settings/
    page.tsx
  api/
    health/
      route.ts
  <entity-route>/
    actions.ts
    page.tsx
    new/
      page.tsx
    [id]/
      page.tsx

lib/
  prisma.ts
  session.ts

prisma/
  schema.prisma
  seed.ts

README.md
app-builder-report.md
package.json
tsconfig.json
next.config.ts
postcss.config.js
tailwind.config.ts
.env.example
```

## 页面与职责

### `app/layout.tsx`

- 提供全局页面壳
- 渲染顶部导航
- 通过 `getCurrentUser()` 读取当前登录用户
- 根据登录态显示 `Sign in` 或 `Sign out`

### `app/page.tsx`

- 作为受保护的 dashboard 首页
- 通过 `requireUser()` 强制登录
- 读取每个实体的 Prisma `count()` 结果
- 用卡片方式展示各实体入口

### `app/login/page.tsx` + `app/login/actions.ts`

- 提供邮箱密码登录表单
- 通过 Server Action 调用 `loginWithEmailPassword()`
- 登录成功后跳转到 `/`
- 登出动作会清除 session 并跳转到 `/login`

### `app/settings/page.tsx`

- 受保护页面
- 展示当前登录邮箱
- 展示生成时自动补全的默认假设 `defaultsApplied`

### `app/api/health/route.ts`

- 提供最小健康检查接口
- 返回 `{ ok: true }`

### `app/<entity-route>/`

每个实体都会生成以下页面：

- `page.tsx`：列表页，读取该实体全部记录
- `new/page.tsx`：新建页，提交到 Server Action
- `[id]/page.tsx`：详情/编辑页，支持更新和删除
- `actions.ts`：封装 create/update/delete 三个 Server Action

## 数据层架构

### `lib/prisma.ts`

- 统一导出 Prisma Client
- 在开发环境通过 `globalThis` 复用实例，避免热更新时重复创建连接

### `prisma/schema.prisma`

默认包含：

- `User` 模型
- 用户在 PRD/spec 中定义的业务实体模型

所有生成的业务实体都会自动带上以下基础字段：

- `id`
- `createdAt`
- `updatedAt`

字段类型映射规则当前为：

- `number -> Int`
- `boolean -> Boolean`
- `date -> DateTime`
- `datetime -> DateTime`
- 其他默认映射为 `String`

### `prisma/seed.ts`

会生成：

- 一个默认演示账号
- 每个实体至少一条示例记录

默认演示账号为：

- 邮箱：`demo@example.com`
- 密码：`demo12345`

## 鉴权架构

### `lib/session.ts`

当前登录系统采用“数据库用户 + 签名 cookie session”的简单实现：

- 用户名密码存储在 `User.passwordHash`
- 密码使用 `scryptSync` 做 hash
- session 写入 `app_builder_session` cookie
- cookie 内容包含 `userId` 和过期时间
- cookie 通过 HMAC-SHA256 签名
- `requireUser()` 作为页面保护入口，未登录时重定向到 `/login`

这是一个偏演示和脚手架取向的鉴权方案，适合生成后快速启动，不是完整的企业级身份系统。

## CRUD 请求流

当前生成应用的典型读写链路如下：

1. 页面作为 Server Component 渲染。
2. 受保护页面先调用 `requireUser()`。
3. 页面直接通过 Prisma 读取数据库。
4. 表单提交到 `app/<entity-route>/actions.ts` 中的 Server Action。
5. Server Action 再次调用 `requireUser()`。
6. 写入数据库后通过 `revalidatePath()` 刷新页面缓存。
7. 创建和删除操作会 `redirect()`，更新操作会留在当前详情页。

## UI 架构

当前 UI 约定比较轻量：

- 不生成独立的 `components/` 目录
- 页面直接内联使用 Tailwind class
- 列表页默认展示每个实体前 3 个字段和更新时间
- 表单控件根据字段类型自动映射
- 布局、登录页、设置页和实体页共用同一套浅色视觉风格

## 环境变量

生成项目默认提供 `.env.example`，要求以下变量：

- `DATABASE_URL`
- `APP_URL`
- `SESSION_SECRET`
