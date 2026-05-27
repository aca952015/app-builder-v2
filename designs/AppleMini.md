# Apple Style Mini Program Design Specification

> 适用范围：用于指导 LLM / 设计工具 / 前端开发生成 **Apple 风格的小程序移动端页面设计稿**。
> 核心目标：输出干净、克制、可交付开发的 **平面 UI 页面**，而不是手机样机图、浏览器截图或带设备外框的展示图。

---

## 0. Non-Negotiable Rendering Rules

这一章是最高优先级规则，任何页面生成都必须遵守。

### 0.1 Must Do

- 只生成 **小程序页面 UI 本身**。
- 页面应是 **flat mobile UI deliverable**，即平面移动端界面稿。
- 内容直接铺满画布，不加手机壳、不加外部容器。
- 画布比例建议使用移动端页面比例，例如：
  - 390 × 844
  - 393 × 852
  - 375 × 812
  - 414 × 896
- 页面背景必须延展到整个画布边缘。
- 页面应表现为可直接交付开发的界面，而不是产品展示海报。
- 如果页面内容较长，可以通过底部内容被自然截断、卡片延展、布局节奏暗示可继续下滑。

### 0.2 Forbidden

禁止出现以下元素：

- 手机外框
- 黑色设备边框
- iPhone 机身
- 刘海、灵动岛、硬件扬声器、实体按键
- 手机屏幕外壳
- 外层展示底板
- 浏览器窗口
- macOS / Windows 窗口边框
- Web 页面滚动条
- 页面右侧全局滚动条
- 灰色浏览器滚动槽
- 设备样机阴影
- 设计稿外层白色包裹框
- “手机里嵌套页面”的展示效果

### 0.3 Scroll Rule

- 不要绘制全局纵向滚动条。
- 不要绘制浏览器滚动条。
- 不要绘制页面右侧灰色滚动条。
- 不要用滚动条表达页面可滚动。
- 如需表达横向滑动卡片，可使用内容露出一部分的方式暗示，不使用系统滚动条。
- 小程序底部 Tab Bar 固定在页面底部，不应因为页面滚动而被放入滚动内容内部。

### 0.4 Output Framing Instruction

每次生成界面时，都应默认遵守：

> Render only the app page itself.
> Do not include phone frames, device bezels, hardware outlines, browser chrome, desktop windows, external containers, or any global scrollbar.
> The result should look like a clean production-ready mobile UI screen, not a phone mockup.

---

## 1. Design Positioning

### 1.1 Style Keywords

- Apple-like
- Light
- Calm
- Minimal
- Premium
- Spacious
- Frosted glass
- Soft depth
- Rounded geometry
- High readability
- Low visual noise

### 1.2 Product Tone

整体气质应接近 Apple 原生应用：

- 克制，而不是炫技。
- 清爽，而不是拥挤。
- 轻盈，而不是厚重。
- 信息清楚，而不是装饰复杂。
- 交互自然，而不是过度设计。

### 1.3 Visual Metaphor

界面应像一个干净的 iOS 原生小程序页面：

- 背景柔和
- 层级清晰
- 卡片轻浮在背景之上
- 主信息被明显突出
- 次信息安静收敛
- 操作入口明确但不抢戏

---

## 2. Canvas

### 2.1 Canvas Size

推荐画布尺寸：

```text
Default: 390 × 844
Alternative: 393 × 852
Large: 414 × 896
Compact: 375 × 812
```

### 2.2 Safe Area

页面可模拟移动端安全区域，但不要绘制硬件结构。

建议安全间距：

```text
Top safe area: 24–32px
Horizontal margin: 20–24px
Bottom safe area: 20–34px
Tab bar height: 72–88px
```

### 2.3 Page Structure

标准页面结构：

```text
Page Background
└── Optional Navigation Area
└── Main Content Area
    ├── Hero Section
    ├── Primary Card
    ├── Secondary Cards
    └── Supporting Modules
└── Fixed Bottom Tab Bar
```

### 2.4 Full-Bleed Requirement

- 背景必须铺满整个画布。
- 不要在画布外侧留白。
- 不要给整个页面套一个大圆角容器。
- 不要让页面看起来像被放进某个手机屏幕里。

---

## 3. Color System

### 3.1 Apple Light Base

推荐主色系统：

```text
Page Background: #F5F7FA
Primary Surface: rgba(255, 255, 255, 0.72)
Secondary Surface: rgba(255, 255, 255, 0.48)
Elevated Surface: rgba(255, 255, 255, 0.86)

Primary Text: #0B1220
Secondary Text: #5F6B7A
Tertiary Text: #8A94A6
Disabled Text: #B8C0CC

Primary Blue: #007AFF
Soft Blue: #EAF4FF
Sky Blue: #BFE7FF
Apple Green: #34C759
Apple Orange: #FF9500
Apple Red: #FF3B30
Apple Purple: #AF52DE
```

### 3.2 Background Gradient

页面背景可以使用极轻的渐变：

```css
background:
  radial-gradient(circle at 20% 0%, rgba(191, 231, 255, 0.55), transparent 32%),
  linear-gradient(180deg, #F7FBFF 0%, #EEF4FA 100%);
```

天气、数据看板、健康类页面可使用更明显但仍然柔和的渐变：

```css
background:
  linear-gradient(180deg, #BFE7FF 0%, #EAF4FF 42%, #F7FBFF 100%);
```

### 3.3 Color Usage Rules

- 蓝色用于主操作、选中态、关键数据。
- 红色只用于危险、异常、失败。
- 绿色用于成功、健康、正常。
- 橙色用于提醒、轻风险、趋势变化。
- 背景色要低饱和。
- 不要使用大面积高纯度颜色。
- 不要使用荧光色。
- 不要使用厚重黑色背景，除非明确要求深色模式。

### 3.4 Glass Surface

Apple 风格卡片可使用半透明玻璃质感：

```css
background: rgba(255, 255, 255, 0.68);
backdrop-filter: blur(24px);
border: 1px solid rgba(255, 255, 255, 0.52);
box-shadow:
  0 12px 32px rgba(31, 45, 61, 0.08),
  inset 0 1px 0 rgba(255, 255, 255, 0.65);
```

注意：

- 玻璃质感要轻，不要像厚塑料。
- 边框必须非常淡。
- 阴影必须柔和。
- 不要使用强烈黑色投影。

---

## 4. Typography

### 4.1 Font Family

优先使用系统字体：

```css
font-family:
  -apple-system,
  BlinkMacSystemFont,
  "SF Pro Display",
  "SF Pro Text",
  "PingFang SC",
  "Helvetica Neue",
  Arial,
  sans-serif;
```

### 4.2 Type Scale

推荐字号：

```text
Page Title: 30–34px / 700–800
Section Title: 18–22px / 650–700
Card Title: 16–18px / 600–700
Primary Number: 56–88px / 700–800
Body Text: 15–17px / 400–500
Meta Text: 12–14px / 400–500
Tab Label: 11–12px / 500–600
Button Text: 15–17px / 600–700
```

### 4.3 Typography Rules

- 大数字要大胆、清晰、居中或左对齐突出。
- 中文标题使用较高字重，但不要全部加粗。
- 次要说明用灰色，不要与主标题竞争。
- 文字行高建议为字号的 1.25–1.45 倍。
- 避免过多字体大小混杂。
- 一个页面内最多使用 4–5 个字号层级。

### 4.4 Numeric Display

数据类页面应突出数字：

```text
Temperature: 31°C
Progress: 86%
Score: 92
Amount: ¥12,680
```

数字规则：

- 数字主体大，单位小。
- 单位与数字基线自然对齐。
- 不要把单位做得和数字一样大。
- 关键数字周围保留足够留白。

---

## 5. Layout System

### 5.1 Spacing Tokens

推荐间距：

```text
4px  - micro gap
8px  - tight gap
12px - small gap
16px - normal gap
20px - section gap
24px - page gap
32px - large gap
40px - hero gap
```

### 5.2 Page Padding

```text
Horizontal padding: 20–24px
Top content padding: 24–32px
Section vertical gap: 20–28px
Card inner padding: 18–24px
```

### 5.3 Alignment

- 页面主轴应清晰。
- 卡片宽度尽量统一。
- 左右边距保持一致。
- 内容不要贴边。
- 图标、文字、数字的垂直对齐要精确。
- 横向卡片列表可以露出下一张卡片的一部分，暗示横滑。

### 5.4 Density

Apple 风格更强调呼吸感：

- 不要把页面塞满。
- 不要让模块之间没有间距。
- 不要使用复杂网格堆砌信息。
- 每个卡片只表达一个主要信息目标。
- 复杂信息应分层展示。

---

## 6. Shape System

### 6.1 Radius Tokens

```text
Small Control: 10–12px
Input Field: 16–20px
Card: 24–32px
Large Panel: 28–36px
Bottom Tab Bar: 0px top-level container, 20–28px internal item
Pill: 999px
```

### 6.2 Shape Rules

- 大卡片使用大圆角。
- 小按钮使用胶囊形。
- 输入框使用中等圆角。
- 选中标签使用 pill。
- 不要给整个页面加大圆角。
- 不要给最外层画布加边框。
- 不要让所有元素圆角完全一样。

---

## 7. Elevation & Shadow

### 7.1 Shadow Tokens

```css
--shadow-soft:
  0 8px 24px rgba(31, 45, 61, 0.08);

--shadow-card:
  0 12px 32px rgba(31, 45, 61, 0.10);

--shadow-floating:
  0 18px 44px rgba(31, 45, 61, 0.12);
```

### 7.2 Shadow Rules

- 阴影要轻、散、柔。
- 不要使用硬边阴影。
- 不要使用深黑色大投影。
- 卡片阴影只用于区分层级，不用于制造强烈 3D 效果。
- 底部 Tab Bar 可以有非常轻的顶部阴影。

---

## 8. Component Guidelines

## 8.1 Navigation Area

适合小程序页面顶部：

```text
[Small Brand / Page Label]
[Large Page Title]        [Optional Icon Button]
```

规则：

- 顶部不要绘制手机状态栏。
- 可以保留小程序页面自己的标题区。
- 标题左对齐更符合内容型应用。
- 右侧图标按钮要轻量，不要过大。
- 不要画系统时间、电量、信号等硬件状态信息，除非用户明确要求。

## 8.2 Search Input

推荐样式：

```text
Height: 56–64px
Radius: 18–22px
Background: rgba(255,255,255,0.72)
Placeholder: #8A94A6
Icon: 18–22px
Padding: 18–22px
```

规则：

- 输入框应有轻微内阴影或外阴影。
- Placeholder 文案要具体。
- 不要使用厚重描边。
- 不要使用纯白硬边矩形。

## 8.3 Primary Card

用于展示页面最重要内容。

推荐结构：

```text
[Context Label]
[Large Number / Main Result]
[Status / Description]
[Meta Info]
[Divider]
[3-column metrics]
```

规则：

- 主信息必须一眼可见。
- 卡片内部有明确视觉中心。
- 指标区可以使用 2–3 列。
- 分割线要非常淡。
- 不要把主卡片拆成过多小块。

## 8.4 Secondary Card

用于趋势、列表、辅助信息。

规则：

- 标题区左对齐。
- 内容区留白充足。
- 图标只做辅助，不抢主信息。
- 卡片高度根据内容自然变化。
- 不要在同一张卡片里放太多不同类型信息。

## 8.5 Tag / Pill

推荐用于筛选、最近记录、状态标签。

```text
Height: 36–44px
Radius: 999px
Padding: 12–18px
Selected Background: #007AFF
Selected Text: #FFFFFF
Default Background: rgba(255,255,255,0.72)
Default Text: #324055
```

规则：

- 选中态要明显。
- 默认态要轻。
- 删除图标要小，不要喧宾夺主。
- 标签之间保持 8–12px 间距。

## 8.6 Button

### Primary Button

```text
Background: #007AFF
Text: #FFFFFF
Radius: 16–20px
Height: 48–56px
```

### Secondary Button

```text
Background: rgba(255,255,255,0.72)
Text: #0B1220
Border: rgba(255,255,255,0.56)
Radius: 16–20px
Height: 44–52px
```

规则：

- 每个页面最多一个强主按钮。
- 次按钮不应比主按钮更醒目。
- 禁止使用过多渐变按钮。
- 禁止使用强烈外发光。

## 8.7 Bottom Tab Bar

底部导航应固定在画布底部。

推荐样式：

```text
Height: 76–88px
Background: rgba(255,255,255,0.86)
Backdrop blur: 20–28px
Top border: rgba(0,0,0,0.06)
```

规则：

- Tab Bar 横向等分。
- 图标在上，文字在下。
- 选中项使用蓝色。
- 未选中项使用灰色。
- Tab Bar 不参与页面滚动。
- 不要画成浏览器底部工具栏。
- 不要在 Tab Bar 外再加设备安全区外壳。

---

## 9. Iconography

### 9.1 Icon Style

推荐：

- 线性图标
- 2px 左右描边
- 圆角端点
- 简洁轮廓
- 与 SF Symbols 气质接近

### 9.2 Icon Rules

- 图标尺寸常用 18、20、22、24px。
- Tab 图标可用 24–28px。
- 图标颜色跟随文字层级。
- 不要混用 3D 图标、拟物图标和线性图标。
- 天气、情绪等场景可少量使用柔和 emoji 或彩色符号，但不能破坏整体一致性。

---

## 10. Motion & Interaction

用于动效描述时遵守：

```text
Duration: 180–320ms
Easing: ease-out / spring-like
Scale on tap: 0.97–0.99
Opacity transition: 0.85–1
```

规则：

- 动效要轻。
- 不要使用夸张弹跳。
- 不要使用复杂转场。
- 卡片出现可以轻微上浮与淡入。
- 按钮点击可以轻微缩放。

---

## 11. Page Archetypes

## 11.1 Dashboard Page

适合天气、数据、设备、经营概览。

结构：

```text
Top Title
Search / Filter
Primary Summary Card
Metric Grid
Trend Card
Bottom Tab Bar
```

设计重点：

- 一个最强主指标。
- 2–4 个辅助指标。
- 信息分层清楚。
- 避免堆满图表。

## 11.2 List Page

适合消息、任务、城市、设备、报表列表。

结构：

```text
Top Title
Search Input
Filter Pills
List Cards
Bottom Tab Bar
```

设计重点：

- 列表卡片高度统一。
- 主标题、状态、时间层级明确。
- 不要使用过重分割线。

## 11.3 Detail Page

适合城市天气详情、设备详情、报表详情。

结构：

```text
Top Navigation
Hero Data
Segmented Control
Detail Cards
Action Area
```

设计重点：

- 详情页顶部要有明确返回或上下文。
- 主数据居上。
- 次级数据卡片化。
- 操作按钮不要过多。

## 11.4 Settings Page

适合偏好设置、账号、系统参数。

结构：

```text
Top Title
Profile / Summary Card
Grouped Setting Cells
About / Version
Bottom Tab Bar
```

设计重点：

- 设置项分组。
- 每一行高度 52–64px。
- 使用细箭头或开关。
- 不要过度装饰。

---

## 12. Mini Program Specific Rules

### 12.1 小程序页面边界

- 不要绘制微信 / 支付宝 / 浏览器外壳。
- 不要绘制小程序右上角胶囊菜单，除非明确要求。
- 不要绘制系统状态栏。
- 不要绘制浏览器地址栏。
- 页面应像小程序内部页面，不是运行环境截图。

### 12.2 底部导航

- 若有 3–5 个一级模块，使用底部 Tab Bar。
- Tab Bar 固定在底部。
- 不要让 Tab Bar 被主内容覆盖。
- 不要让 Tab Bar 出现外层设备安全区黑边。

### 12.3 内容滚动

- 页面可以是纵向内容流。
- 主内容在视觉上从上到下自然延展。
- 不显示全局滚动条。
- 不显示右侧滚动槽。
- 不显示浏览器默认 scrollbar。

---

## 13. Do / Don't

### Do

- 使用纯页面画布。
- 使用柔和背景。
- 使用大圆角玻璃卡片。
- 使用充足留白。
- 让主信息足够大。
- 用蓝色表达主操作或选中态。
- 用淡分割线组织信息。
- 保持模块宽度一致。
- 保持底部 Tab Bar 固定。
- 通过内容布局暗示滚动。

### Don't

- 不要生成手机壳。
- 不要生成黑色设备边框。
- 不要生成全局滚动条。
- 不要生成浏览器窗口。
- 不要生成外层展示框。
- 不要使用强烈厚重阴影。
- 不要使用高饱和渐变铺满卡片。
- 不要把所有文字都加粗。
- 不要把页面设计成海报。
- 不要在一屏内塞入过多模块。
- 不要让底部导航随着内容滚动。
- 不要让 UI 看起来像网页截图。

---

## 14. Prompt Template for LLM UI Generation

当使用 LLM 生成界面时，可以直接使用以下模板。

```text
请生成一个 Apple 风格的小程序移动端页面设计稿。

设计要求：
- 只输出页面 UI 本身，不要手机外框、设备边框、手机壳或样机图。
- 不要出现任何浏览器窗口、桌面窗口、外层展示容器。
- 不要出现任何全局滚动条、右侧滚动槽或浏览器 scrollbar。
- 页面背景需要铺满整个画布。
- 使用 Apple-like 的轻盈、克制、清爽风格。
- 使用柔和渐变背景、半透明玻璃卡片、大圆角、轻阴影。
- 信息层级清晰，主信息突出，次级信息收敛。
- 底部 Tab Bar 固定在页面底部。
- 如果内容较长，只通过内容延展暗示可滚动，不画滚动条。
- 输出应像可直接交付开发的平面 UI 设计稿，而不是手机展示图。

画布建议：390 × 844。
```

---

## 15. Negative Prompt

用于图像生成或 UI 生成时，可附加：

```text
No phone frame, no iPhone mockup, no device bezel, no black border, no hardware outline, no browser chrome, no desktop window, no external container, no presentation board, no global scrollbar, no right-side scrollbar, no scroll track, no web page screenshot, no status bar, no address bar, no thick shadow, no poster layout.
```

中文版本：

```text
不要手机外框，不要 iPhone 样机，不要设备边框，不要黑色外轮廓，不要硬件外壳，不要浏览器窗口，不要桌面窗口，不要外层展示容器，不要全局滚动条，不要右侧滚动条，不要滚动槽，不要网页截图，不要状态栏，不要地址栏，不要厚重阴影，不要海报式构图。
```

---

## 16. Weather Mini Program Example Rules

如果生成天气类小程序页面，推荐如下结构：

```text
Top Brand / Title
Location Button
Search Input
Recent City Pills
Current Weather Card
Hourly Forecast Horizontal Cards
Daily Forecast Card
Air Quality / Comfort Index
Bottom Tab Bar
```

设计要求：

- 当前温度是视觉中心。
- 天气状态在温度下方。
- 城市名、更新时间作为次级信息。
- 体感、湿度、风向等指标放在主卡底部。
- 小时预报可以横向卡片化，但不要画横向滚动条。
- 页面不要出现右侧纵向滚动条。
- 不要使用手机外框展示天气页面。

---

## 17. Quality Checklist

生成后检查：

```text
[ ] 是否只有页面本身？
[ ] 是否没有手机外框？
[ ] 是否没有黑色设备边框？
[ ] 是否没有浏览器窗口？
[ ] 是否没有全局滚动条？
[ ] 是否没有右侧滚动槽？
[ ] 背景是否铺满画布？
[ ] 底部 Tab Bar 是否固定在底部？
[ ] 主信息是否足够突出？
[ ] 卡片是否轻盈而不是厚重？
[ ] 圆角、阴影、字体是否统一？
[ ] 是否像可交付开发的 UI，而不是样机展示图？
```

---

## 18. Implementation Notes

### 18.1 CSS Base

```css
:root {
  --color-bg: #F5F7FA;
  --color-text-primary: #0B1220;
  --color-text-secondary: #5F6B7A;
  --color-text-tertiary: #8A94A6;
  --color-primary: #007AFF;

  --surface-primary: rgba(255, 255, 255, 0.72);
  --surface-secondary: rgba(255, 255, 255, 0.48);
  --border-light: rgba(255, 255, 255, 0.52);

  --radius-card: 28px;
  --radius-control: 18px;
  --radius-pill: 999px;

  --shadow-card: 0 12px 32px rgba(31, 45, 61, 0.10);
  --shadow-soft: 0 8px 24px rgba(31, 45, 61, 0.08);
}
```

### 18.2 Page Container

```css
.page {
  width: 390px;
  min-height: 844px;
  overflow: hidden;
  background:
    radial-gradient(circle at 20% 0%, rgba(191, 231, 255, 0.55), transparent 32%),
    linear-gradient(180deg, #F7FBFF 0%, #EEF4FA 100%);
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", sans-serif;
  color: var(--color-text-primary);
}
```

注意：

- `overflow: hidden` 用于避免生成全局滚动条视觉。
- 实际开发中页面可以滚动，但设计稿不要显示 scrollbar。
- 不要给 `.page` 添加 border。
- 不要给 `.page` 添加 device-frame 风格 box-shadow。
- 不要给 `.page` 添加外层 wrapper 来模拟手机。

### 18.3 Card

```css
.card {
  background: var(--surface-primary);
  backdrop-filter: blur(24px);
  border: 1px solid var(--border-light);
  border-radius: var(--radius-card);
  box-shadow: var(--shadow-card);
  padding: 22px;
}
```

### 18.4 Fixed Tab Bar

```css
.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  height: 82px;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(24px);
  border-top: 1px solid rgba(0, 0, 0, 0.06);
}
```

---

## 19. Final Rule

无论生成什么页面，都必须优先满足：

```text
Only the app page. No phone frame. No device mockup. No global scrollbar.
```
