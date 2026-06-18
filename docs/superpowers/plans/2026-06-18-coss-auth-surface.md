# COSS 认证入口统一实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将开屏状态页与登录页统一替换为 coss 风格的认证入口，不再直接依赖旧的登录布局和旧按钮语义。

**架构：** 把开屏态与登录态抽到独立的认证展示组件中，由 `src/client/App.tsx` 只负责状态切换和登录提交。同步把本地 `Button` 原语调整为统一 coss 风格，让认证链路与共享 `CossButton` 封装共用同一套视觉和交互语义。

**技术栈：** React 18、TypeScript、Tailwind CSS、现有本地 `components/ui/*` 原语

---

### 任务 1：抽离认证入口展示层

**文件：**
- 创建：`src/client/features/auth/EntryScreens.tsx`
- 修改：`src/client/App.tsx`
- 测试：`npm run build`

- [ ] **步骤 1：新增认证展示组件**

```tsx
export function EntryStatusScreen({ label, detail }: { label: string; detail?: string }) {
  // 居中状态卡片，统一开屏和“正在加载会话消息”
}

export function EntryShell({ eyebrow, title, description, children }: Props) {
  // 统一登录页背景、面板和品牌区域
}
```

- [ ] **步骤 2：将 `App.tsx` 的 booting/login 分支切到新组件**

```tsx
if (booting) return <EntryStatusScreen label="正在打开创作台" />
if (!me || !currentSpaceId(me)) return <LoginScreen ... />
```

- [ ] **步骤 3：运行构建验证入口替换未破坏类型和 JSX**

运行：`npm run build`
预期：PASS，Vite 构建成功

### 任务 2：统一按钮与表单视觉语义

**文件：**
- 修改：`src/client/components/ui/button.tsx`
- 修改：`src/client/App.tsx`
- 测试：`npm run build`

- [ ] **步骤 1：将本地 `Button` 调整为统一 coss 风格实现**

```tsx
const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(...)
```

- [ ] **步骤 2：登录页只使用统一的按钮/输入/提示语义**

```tsx
<Button type="submit" loading={loading}>进入空间</Button>
```

- [ ] **步骤 3：再次运行构建，确认共享封装未被打断**

运行：`npm run build`
预期：PASS，认证页与共享 `CossButton` 均可编译
