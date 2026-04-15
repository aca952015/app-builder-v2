# Full-Stack 模板生成架构

这份文档描述当前 `full-stack` 模板 starter 的真实项目骨架。生成阶段必须把它当作 UI 壳、布局分层、路由分组和基础约定的权威参考，而不是沿用过时的通用 CRUD 想象。

## 技术栈

- Next.js 15 App Router
- React 19
- TypeScript
- Prisma 6
- SQLite
- Tailwind CSS v4
- TailAdmin 风格的管理台壳层
- 基于 signed cookie 的邮箱密码登录

## 生成结果总览

每次生成都会先复制一个可运行的 TailAdmin 风格 Next.js starter，然后再由生成阶段在这个骨架上填入业务内容。当前 starter 已经提供：

- 根级 `app/` 路由与全局样式
- `app/(admin)` 管理台路由组
- `app/(full-width-pages)` 全宽页面路由组
- 固定的 dashboard 首页占位内容
- 固定的 settings 页占位内容
- 登录页与登录 Server Action
- 健康检查接口
- Sidebar/Header/AdminShell 布局壳
- 主题切换与 sidebar 状态管理 context
- Prisma、session、seed、sidebar 配置等基础设施

生成阶段的主要工作不是重搭框架，而是在这个骨架上扩展业务页面、资源、接口、导航和报告。

## 当前目录结构

```text
app/
  layout.tsx
  globals.css
  not-found.tsx
  api/
    health/
      route.ts
  login/
    actions.ts
  (admin)/
    layout.tsx
    page.tsx
    settings/
      page.tsx
  (full-width-pages)/
    layout.tsx
    login/
      page.tsx

components/
  common/
    ThemeToggleButton.tsx

config/
  sidebar-menu.json
  sidebar-menu.ts

context/
  SidebarContext.tsx
  ThemeContext.tsx

layout/
  AdminShell.tsx
  AppHeader.tsx
  AppSidebar.tsx
  Backdrop.tsx

lib/
  prisma.ts
  session.ts

prisma/
  schema.prisma
  seed.ts

README.md
package.json
next.config.ts
postcss.config.js
tailwind.config.ts
tsconfig.json
svg.d.ts
.env.example
app-builder-report.md
```

## 路由分组与职责

### `app/layout.tsx`

- 根布局
- 注入 `globals.css`
- 挂载 Google `Outfit` 字体
- 在整个应用外层包裹 `ThemeProvider` 和 `SidebarProvider`
- 这里只负责全局 provider，不负责业务保护逻辑

### `app/(admin)/layout.tsx`

- 管理台受保护布局
- 通过 `requireUser()` 强制登录
- 通过 `logout()` 组装登出 Server Action
- 用 `AdminShell` 包裹所有管理台页面
- 这里是业务管理页面的主挂载点；后续生成的实体页面应优先接入这个路由组

### `app/(admin)/page.tsx`

- 当前 dashboard 首页占位
- 已经提供 TailAdmin 卡片节奏、网格布局和视觉语言
- 生成阶段应替换其占位文案与指标内容，但保留整体信息架构和卡片风格

### `app/(admin)/settings/page.tsx`

- 当前 settings 占位页
- 会显示当前登录用户
- 生成阶段应把环境说明、假设说明、工作区级设置等内容扩展到这里，而不是重新发明另一套设置页壳

### `app/(full-width-pages)/layout.tsx`

- 全宽页面路由组布局
- 当前仅做最小包裹，为登录页保留独立于 admin shell 的版式空间

### `app/(full-width-pages)/login/page.tsx`

- 登录页 UI
- 当前是 TailAdmin 风格双栏登录页
- 生成阶段不应把它改回通用居中卡片，也不应把登录页搬回 admin shell

### `app/login/actions.ts`

- 登录与登出 Server Action
- `authenticate()` 调用 `loginWithEmailPassword()` 后跳转 `/`
- `logout()` 清理 session 后跳转 `/login`

### `app/api/health/route.ts`

- 健康检查接口
- 固定返回 `{ ok: true }`
- 后续业务 API 应在保留它的同时扩展到 `app/api/...`

## 布局壳与 UI 架构

### `layout/AdminShell.tsx`

- 管理台主壳
- 组合 `AppSidebar`、`Backdrop`、`AppHeader`
- 根据 sidebar 展开/悬停/移动端打开状态动态调整主内容左边距
- 这是所有管理台业务页应复用的统一壳层

### `layout/AppSidebar.tsx`

- 读取 `config/sidebar-menu.json`
- 支持最多两级菜单
- 根据当前 pathname 自动高亮激活项
- 保留 TailAdmin 风格的品牌区、分组标题、折叠态和底部说明卡
- 未识别 `icon` 键时回退到通用图标

### `layout/AppHeader.tsx`

- 提供 sidebar toggle、搜索输入、主题切换、用户信息和登出按钮
- 搜索框自带 `Cmd/Ctrl + K` 聚焦行为
- 这是管理台顶部导航的事实来源，不应被业务页面各自复制一套 header

### `components/common/ThemeToggleButton.tsx`

- 主题切换按钮组件
- 与 `ThemeContext` 协作控制亮暗主题

### `app/globals.css`

- 全局 Tailwind v4 样式入口
- 含 TailAdmin 风格的 utility/token 约定
- 生成阶段应优先复用现有 class 体系，不要引入另一套 UI 框架或大面积自定义设计系统

## Context 层

### `context/SidebarContext.tsx`

- 管理 sidebar 展开、移动端打开、hover、submenu 等状态
- `AdminShell`、`AppSidebar`、`AppHeader` 都依赖它
- 生成阶段不应绕开它另写一套 sidebar 状态系统

### `context/ThemeContext.tsx`

- 管理 light/dark 主题
- 使用 `localStorage` 持久化主题偏好
- 通过给 `document.documentElement` 切换 `dark` class 控制主题

## 配置层

### `config/sidebar-menu.json`

- 侧边栏导航的唯一事实来源
- starter 默认包含：
  - `Dashboard -> /`
  - `Workspace -> Settings -> /settings`
- 生成阶段新增业务导航时，应优先扩展这个文件，而不是把菜单硬编码在组件里

### `config/sidebar-menu.ts`

- 负责 `sidebar-menu.json` 的运行时校验与类型收敛
- 限制最多两级菜单
- 生成阶段应遵守这里的结构约束

## 数据层与鉴权

### `lib/prisma.ts`

- Prisma Client 单例出口
- 开发环境通过全局复用避免热更新时重复实例化

### `prisma/schema.prisma`

- 当前 starter 使用 SQLite
- 预置 `User` 模型：
  - `id`
  - `email`
  - `name`
  - `passwordHash`
  - `createdAt`
  - `updatedAt`
- 生成阶段应在保留 `User` 和 datasource 基础上扩展业务模型

### `prisma/seed.ts`

- starter 的 seed 入口
- 生成阶段应把 demo 用户和业务样例数据放在这里，而不是额外发明第二套 seed 路径

### `lib/session.ts`

- 负责邮箱密码登录、session 读写、当前用户读取与登录保护
- 使用 `scryptSync` 做密码 hash
- 使用 HMAC-SHA256 签名 cookie
- session cookie 名称固定为 `app_builder_session`
- `requireUser()` 是管理台页面保护入口

## 生成阶段应如何扩展这个 starter

- 保留路由分组结构：管理台业务页放在 `app/(admin)`，全宽认证页放在 `app/(full-width-pages)`
- 保留 `AdminShell`、`AppHeader`、`AppSidebar` 的整体布局关系
- 保留 `config/sidebar-menu.json` 作为导航事实来源
- 在现有 TailAdmin 卡片、表格、表单、间距和主题类之上扩展业务界面
- 保留 Prisma + SQLite + session 基础设施，按 `planSpec` 扩展业务模型和 API
- 把占位 dashboard、settings、登录文案替换为业务内容时，优先复用现有页面骨架

## 生成阶段不应做的事

- 不要把应用重新改回没有 route groups 的单层 `app/` 结构
- 不要删除或绕过 `AdminShell`，再自己拼一套侧边栏和 header
- 不要把 sidebar 菜单硬编码到 `AppSidebar.tsx`
- 不要把登录页塞回 admin shell
- 不要把数据库、鉴权或 UI 框架整体替换成另一套实现，除非 `planSpec` 明确要求且宿主规则允许
- 不要忽略 `generated-app-architecture.md` 中记录的 starter 现实结构
