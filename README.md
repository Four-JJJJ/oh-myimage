# oh-myimage

在线 Image-2 生图平台。第一版采用 Cloudflare 低成本架构：React + Vite + shadcn/ui + Cloudflare Worker + Hono + D1 + R2 + Queues。

## 功能

- 空间名 + 密码进入独立工作区
- 用户自填 `baseURL + API Key + model`
- API Key 服务端 AES-GCM 加密保存
- 支持 prompt、比例、尺寸、质量、数量、格式、透明背景、压缩率
- 使用 shadcn/ui + Tailwind 构建创作工作台界面
- D1 保存任务和图片元数据
- R2 保存生成图片
- Queues 异步处理生图任务
- 灵感库代码保留，但当前默认隐藏并暂停定时采集
- 基础配额、并发限制、SSRF 防护和日志脱敏

## 本地运行

```bash
npm install
npm run db:migrate:local
npm run dev
```

访问 Wrangler 输出的本地地址，默认通常是 `http://localhost:8787`。

本地需要 `.dev.vars`：

```bash
APP_ENCRYPTION_KEY="replace-with-local-secret"
TURNSTILE_REQUIRED="false"
TURNSTILE_SECRET_KEY=""
X_BEARER_TOKEN=""
```

灵感库会使用 D1 保存素材元数据，R2 缓存不超过 `INSPIRATION_THUMBNAIL_MAX_BYTES` 的缩略图。当前 `INSPIRATION_FEATURE_ENABLED=false`，前端入口隐藏且 Cron 不会采集；需要恢复时再开启。X 只使用官方 API 或手动粘贴提示词导入，不抓取网页。

## 验证

```bash
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

## 部署

部署到 Cloudflare 前需要创建 D1、R2、Queue、Turnstile，并把 D1 的 `database_id` 写入 `wrangler.toml`。

完整步骤见 [docs/cloudflare-deployment.md](docs/cloudflare-deployment.md)。
