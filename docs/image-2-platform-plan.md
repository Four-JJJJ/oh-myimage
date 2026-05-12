# Image-2 在线生图平台可执行方案

> 实施更新：当前仓库已按 Cloudflare 低成本方案落地，实际技术栈为 React + Vite + Cloudflare Worker + Hono + D1 + R2 + Queues。部署步骤见 `docs/cloudflare-deployment.md`。本文保留早期产品与接口方案背景。

## 1. 目标与范围

目标：构建一个在线图片生成平台，用户在网页中输入提示词并选择比例、质量、数量等参数，平台通过可配置的 `baseURL` 与 API Key 调用 `gpt-image-2` 图片生成接口，生成后在网页中浏览、下载、复用与管理图片。

MVP 必须交付：

- 生图工作台：提示词、比例/尺寸、质量、数量、输出格式、透明背景、压缩率等参数。
- 图片生成接口：后端代理请求，浏览器不直接接触 API Key。
- 图片结果展示：生成中、成功、失败、空态、历史记录、图片详情、下载。
- 存储闭环：将 API 返回的 base64 图片转成文件，上传对象存储或本地存储，并落库。
- 基础治理：登录、用户配额、请求频控、错误日志、任务状态追踪。
- 部署说明：环境变量、数据库迁移、存储配置、回滚方式。

后续增强：

- 图片编辑/局部重绘：接入 `/v1/images/edits`。
- 流式中间图预览：仅在目标模型和供应商实际支持时开启。
- 团队空间、计费、公开作品广场、收藏夹、提示词模板库。

## 2. 官方接口依据

截至 2026-05-12 的官方资料：

- `gpt-image-2` 是 OpenAI 的图片生成模型，输入支持文本与图片，输出图片，支持 `v1/images/generations` 与 `v1/images/edits`。
- 创建图片接口是 `POST /v1/images/generations`。
- GPT image 模型默认返回 `b64_json`，不返回可长期使用的公网 URL，因此平台需要自行存储图片。
- `n` 支持 1 到 10；`dall-e-3` 例外只支持 1。本方案默认按 `gpt-image-2` 处理。
- `quality` 对 GPT image 模型支持 `auto`、`low`、`medium`、`high`。
- `output_format` 支持 `png`、`jpeg`、`webp`；透明背景必须使用 `png` 或 `webp`。
- `gpt-image-2` 支持任意 `WIDTHxHEIGHT` 尺寸字符串，但宽高必须能被 16 整除，比例必须在 1:3 到 3:1 之间；高于 `2560x1440` 属实验范围，最大 `3840x2160`。

实现时保留 `IMAGE_MODEL=gpt-image-2` 配置项；如供应商 baseURL 暂未同步支持 `gpt-image-2`，后端应返回明确错误，或由管理员临时切到兼容模型。

## 3. 推荐技术栈

建议从单体全栈开始，避免过早拆微服务：

- 前端/后端：Next.js App Router + TypeScript。
- UI：Tailwind CSS + shadcn/ui 或项目既有组件库。
- 数据库：PostgreSQL + Prisma。
- 文件存储：S3 兼容对象存储，优先 Cloudflare R2 / AWS S3 / MinIO；本地开发可用 `public/uploads`。
- 队列：MVP 可同步请求；上线后使用 Redis + BullMQ 处理并发、重试和超时。
- 登录：NextAuth / Clerk / 自建邮箱登录均可；MVP 可先支持管理员单账号。
- 部署：Vercel / Railway / Fly.io / Docker Compose 均可。图片任务较长时优先选择可配置请求超时的平台。

## 4. 总体架构

```mermaid
flowchart LR
  Browser["浏览器 UI"] --> WebAPI["Next.js API Routes"]
  WebAPI --> Auth["认证/配额/频控"]
  WebAPI --> DB["PostgreSQL"]
  WebAPI --> Provider["OpenAI-compatible baseURL"]
  Provider --> WebAPI
  WebAPI --> Storage["S3/R2/MinIO"]
  Storage --> Browser
  DB --> Browser
```

关键原则：

- API Key 只在服务端环境变量或加密配置中保存。
- 前端只调用本平台 `/api/*`，不直连外部模型服务。
- `baseURL` 可配置，但只能由管理员或部署环境控制，避免用户输入任意 URL 造成 SSRF 风险。
- 图片落库保存元数据，文件保存到对象存储，前端通过签名 URL 或受控下载接口访问。

## 5. 环境变量

```bash
APP_URL=http://localhost:3000
DATABASE_URL=postgresql://user:password@localhost:5432/image_platform

OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
IMAGE_MODEL=gpt-image-2
IMAGE_MODEL_SNAPSHOT=

STORAGE_DRIVER=s3
S3_ENDPOINT=
S3_REGION=auto
S3_BUCKET=image-platform
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PUBLIC_BASE_URL=

REDIS_URL=
MAX_IMAGES_PER_REQUEST=4
MAX_DAILY_IMAGES_PER_USER=100
MAX_PROMPT_LENGTH=32000
REQUEST_TIMEOUT_MS=120000
```

说明：

- `OPENAI_BASE_URL` 默认使用 OpenAI 官方地址，也可切换到兼容代理。
- `MAX_IMAGES_PER_REQUEST` 建议 MVP 先设为 4，降低单次成本和超时风险；后台仍按模型能力校验上限 10。
- `IMAGE_MODEL_SNAPSHOT` 可为空；如要锁定行为，可配置 `gpt-image-2-2026-04-21`。

## 6. 核心生图参数

前端表单字段：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `prompt` | string | 空 | 必填，最多 32000 字符 |
| `aspectRatio` | enum | `1:1` | `1:1`、`3:2`、`2:3`、`16:9`、`9:16`、`custom` |
| `width` | number | 1024 | `custom` 时启用，必须可被 16 整除 |
| `height` | number | 1024 | `custom` 时启用，必须可被 16 整除 |
| `quality` | enum | `auto` | `auto`、`low`、`medium`、`high` |
| `quantity` | number | 1 | MVP 限 1-4，上线可放宽到 10 |
| `outputFormat` | enum | `png` | `png`、`webp`、`jpeg` |
| `background` | enum | `auto` | `auto`、`opaque`、`transparent` |
| `compression` | number | 100 | 仅 `webp/jpeg` 生效，0-100 |
| `moderation` | enum | `auto` | `auto`、`low` |

尺寸映射：

```ts
const ratioToSize = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1536x864",
  "9:16": "864x1536",
} as const;
```

自定义尺寸校验：

- `width % 16 === 0 && height % 16 === 0`
- `width / height >= 1 / 3 && width / height <= 3`
- 默认禁止超过 `2560x1440`，管理员可开启实验高分辨率，硬上限 `3840x2160`。
- `background=transparent` 时，`outputFormat` 只能是 `png` 或 `webp`。

## 7. 后端 API 设计

### 7.1 创建生图任务

`POST /api/generations`

请求：

```json
{
  "prompt": "A clean product photo of a white sneaker on a reflective table",
  "aspectRatio": "1:1",
  "width": 1024,
  "height": 1024,
  "quality": "auto",
  "quantity": 2,
  "outputFormat": "png",
  "background": "auto",
  "compression": 100,
  "moderation": "auto"
}
```

响应：

```json
{
  "jobId": "gen_01H...",
  "status": "queued"
}
```

同步 MVP 也可直接返回：

```json
{
  "jobId": "gen_01H...",
  "status": "succeeded",
  "images": [
    {
      "id": "img_01H...",
      "url": "/api/images/img_01H...",
      "width": 1024,
      "height": 1024,
      "format": "png"
    }
  ]
}
```

### 7.2 查询任务

`GET /api/generations/:jobId`

返回任务状态、参数、错误、生成图片列表。

状态枚举：

- `queued`
- `running`
- `succeeded`
- `failed`
- `cancelled`

### 7.3 图片列表

`GET /api/images?cursor=&q=&favorite=&ratio=`

返回当前用户可见的图片历史，支持分页、搜索提示词、筛选收藏。

### 7.4 图片下载

`GET /api/images/:imageId/download`

服务端校验权限后返回文件或 302 到签名 URL。

### 7.5 前端安全配置

`GET /api/config`

只返回安全能力，不返回密钥：

```json
{
  "model": "gpt-image-2",
  "maxImagesPerRequest": 4,
  "ratios": ["1:1", "3:2", "2:3", "16:9", "9:16", "custom"],
  "qualities": ["auto", "low", "medium", "high"],
  "formats": ["png", "webp", "jpeg"]
}
```

## 8. 调用外部图片 API

推荐使用服务端 `fetch` 封装，而不是在早期强依赖 SDK 类型。原因是 `gpt-image-2` 参数更新可能快于 SDK 类型定义。

```ts
async function generateImage(input: GenerateImageInput) {
  const response = await fetch(`${env.OPENAI_BASE_URL}/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: env.IMAGE_MODEL,
      prompt: input.prompt,
      n: input.quantity,
      size: input.size,
      quality: input.quality,
      output_format: input.outputFormat,
      background: input.background,
      output_compression:
        input.outputFormat === "png" ? undefined : input.compression,
      moderation: input.moderation,
      user: input.userId,
    }),
    signal: AbortSignal.timeout(env.REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new ProviderError(response.status, errorText);
  }

  return response.json() as Promise<{
    created: number;
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>;
    output_format?: string;
    quality?: string;
    size?: string;
    usage?: unknown;
  }>;
}
```

处理结果：

1. 遍历 `data[]`。
2. 读取 `b64_json` 并解码为 buffer。
3. 计算哈希、文件大小、宽高、MIME。
4. 上传到对象存储。
5. 写入 `ImageAsset`。
6. 更新任务状态与 token/usage 信息。

## 9. 数据模型

Prisma 草案：

```prisma
model User {
  id          String          @id @default(cuid())
  email       String          @unique
  name        String?
  role        UserRole        @default(USER)
  createdAt   DateTime        @default(now())
  jobs        GenerationJob[]
  images      ImageAsset[]
}

model GenerationJob {
  id              String        @id @default(cuid())
  userId          String
  user            User          @relation(fields: [userId], references: [id])
  status          JobStatus     @default(QUEUED)
  provider        String        @default("openai")
  baseUrlHash     String?
  model           String
  prompt          String
  revisedPrompt   String?
  size            String
  width           Int
  height          Int
  quality         String
  quantity        Int
  outputFormat    String
  background      String
  compression     Int?
  moderation      String
  usageJson       Json?
  errorCode       String?
  errorMessage    String?
  startedAt       DateTime?
  completedAt     DateTime?
  createdAt       DateTime      @default(now())
  images          ImageAsset[]

  @@index([userId, createdAt])
  @@index([status, createdAt])
}

model ImageAsset {
  id          String        @id @default(cuid())
  userId      String
  user        User          @relation(fields: [userId], references: [id])
  jobId       String
  job         GenerationJob @relation(fields: [jobId], references: [id])
  storageKey  String
  publicUrl   String?
  mimeType    String
  format      String
  width       Int
  height      Int
  byteSize    Int
  sha256      String
  favorite    Boolean       @default(false)
  createdAt   DateTime      @default(now())

  @@index([userId, createdAt])
  @@index([jobId])
}

enum UserRole {
  USER
  ADMIN
}

enum JobStatus {
  QUEUED
  RUNNING
  SUCCEEDED
  FAILED
  CANCELLED
}
```

## 10. 前端页面与交互

### 10.1 生图工作台 `/generate`

布局：

- 左侧参数面板：提示词输入、比例、质量、数量、格式、背景、压缩率、高级设置。
- 右侧结果区域：生成中的骨架屏、图片网格、失败卡片、空态。
- 底部历史胶片栏：最近任务，可快速回看。

交互要求：

- 修改比例时自动更新宽高。
- 自定义尺寸输入时实时校验，并明确提示原因。
- 透明背景与 `jpeg` 冲突时自动切换为 `png` 或提示用户。
- 提交后按钮进入 loading 状态，禁止重复提交。
- 失败时展示可读错误：配额不足、参数错误、外部服务超时、内容被拦截、API Key 无效。

### 10.2 图库 `/gallery`

功能：

- 瀑布流或规则网格浏览。
- 搜索提示词。
- 按比例、质量、格式、收藏筛选。
- 图片详情弹窗：大图、参数、生成时间、下载、复制提示词、用相同参数再生成。

### 10.3 设置 `/settings`

MVP 可只给管理员：

- 当前模型与 baseURL 显示，API Key 只显示是否已配置。
- 用户每日配额。
- 最大单次生成数量。
- 存储健康检查。

## 11. 安全、成本与稳定性

- 密钥安全：API Key 禁止下发到浏览器；日志中必须脱敏。
- baseURL 安全：只允许环境变量或管理员配置；保存前校验协议、域名 allowlist、禁止内网地址。
- 频控：按用户、IP、模型做限流，避免刷接口。
- 配额：记录每次图片数量、模型、usage，按日/月限制。
- 内容治理：保留 `moderation=auto` 默认值；必要时在提交前加文本审核。
- 任务幂等：创建任务时生成 `clientRequestId`，避免用户重复点击产生重复扣费。
- 存储权限：私有桶 + 签名 URL；公开分享单独生成分享 token。
- 错误恢复：外部 API 5xx/429 可重试 1-2 次；4xx 参数错误不重试。
- 超时策略：前端轮询任务，后端任务超时后标记失败，不让请求无限挂起。

## 12. 实施里程碑

### M1：项目骨架与配置

- 初始化 Next.js + TypeScript。
- 接入 Tailwind 和基础 UI 组件。
- 配置 `.env.example`。
- 建立 Prisma schema 与 PostgreSQL 连接。
- 完成登录或临时管理员访问控制。

验收：本地能启动，能访问 `/generate`、`/gallery`，数据库迁移成功。

### M2：生图后端闭环

- 实现参数校验。
- 实现 provider client，支持 `OPENAI_BASE_URL` 与 `OPENAI_API_KEY`。
- 实现 `POST /api/generations`。
- 解码 `b64_json`，上传存储，写入任务和图片记录。
- 实现 `GET /api/generations/:id` 与下载接口。

验收：使用真实或 mock API 可以完成一次生成，并在数据库和存储中看到结果。

### M3：生图工作台

- 实现参数表单。
- 实现提交、loading、错误、结果网格。
- 实现尺寸冲突校验和自动修正。
- 实现用相同参数再生成。

验收：用户可以在网页完成一次生成、预览和下载。

### M4：图库与管理能力

- 实现图片历史、分页、搜索、筛选、收藏。
- 实现详情弹窗。
- 实现用户配额、频控、基础管理页。

验收：用户可以回看历史图片，管理员可以限制每日数量。

### M5：上线准备

- 增加测试。
- 接入对象存储生产桶。
- 完成构建、部署、健康检查。
- 整理部署与回滚说明。

验收：生产环境可通过真实账号完成端到端生图。

## 13. 测试方案

单元测试：

- 尺寸映射和校验。
- 参数冲突处理。
- provider 错误归一化。
- base64 解码与 MIME 推断。

接口测试：

- `POST /api/generations` 成功路径。
- 参数非法返回 400。
- API Key 无效返回可读错误。
- 外部 429/5xx 的重试和失败状态。
- 未登录或超配额返回 401/403。

前端 E2E：

- 填写提示词并提交。
- 看到生成中状态。
- mock 成功后展示图片。
- 下载按钮可用。
- 失败时错误提示不遮挡表单。

构建验证：

- `npm run lint`
- `npm run typecheck`
- `npm run test`
- `npm run build`

## 14. 部署方案

最小 Docker Compose：

- `web`：Next.js 应用。
- `postgres`：数据库。
- `redis`：队列和频控，可选。
- `minio`：本地对象存储，可选；生产推荐外部 S3/R2。

上线步骤：

1. 配置生产环境变量。
2. 创建数据库并执行迁移。
3. 创建对象存储 bucket，配置 CORS 与私有访问。
4. 部署 web 服务。
5. 访问 `/api/health` 检查数据库、存储、外部 baseURL 连通性。
6. 用管理员账号生成 1 张低质量测试图。
7. 检查数据库任务、对象存储文件、前端图库。

回滚：

- 代码回滚到上一版本。
- 数据库迁移若只新增表/字段，可保留不回滚。
- 若涉及破坏性 schema 变更，必须提前准备反向迁移和备份。
- 生成中的任务可标记为 `FAILED`，不删除已生成图片。

## 15. 验收标准

功能验收：

- 用户可通过网页输入提示词并生成图片。
- 用户可选择比例/尺寸、质量、数量、格式、背景。
- 图片生成结果可浏览、详情查看、下载、历史回看。
- API Key 不出现在前端 bundle、网络请求或浏览器存储中。
- 任务失败时用户能看到明确原因。

工程验收：

- 数据库保存任务和图片元数据。
- 图片文件不依赖 OpenAI 临时 URL，平台自有存储可访问。
- 支持通过环境变量切换 `baseURL` 和模型。
- 有基础限流、配额、错误日志。
- 构建、类型检查、关键测试通过。

上线验收：

- 生产环境健康检查通过。
- 真实 API 调用成功。
- 存储桶权限正确。
- 管理员可调整最大单次生成数量和每日配额。

## 16. 推荐开发顺序

1. 先实现无队列同步 MVP，保证端到端可用。
2. 再接入队列，解决请求超时、并发和重试。
3. 再补图库、收藏、搜索和管理配置。
4. 最后做计费、公开分享、图片编辑等增值能力。

这条路径可以最快验证真实 API、图片存储、网页浏览三件核心事情，避免先做复杂平台能力却没有完成生图闭环。
