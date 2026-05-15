# oh-myimage

在线 Image-2 生图平台。第一版采用 Cloudflare 低成本架构：React + Vite + shadcn/ui + Cloudflare Worker + Hono + D1 + R2 + Queues；同时支持长期稳定的 Node 服务器部署：Hono + Postgres + Redis/BullMQ + R2。

## 功能

- 空间名 + 密码进入独立工作区
- 用户自填 `baseURL + API Key`，并配置生图模型与提示词优化模型
- API Key 服务端 AES-GCM 加密保存
- 提示词优化走 Responses API，图片生成走 Images API，二者复用同一套 `baseURL + API Key`
- 支持 prompt、比例、尺寸、质量、数量、格式、压缩率；PNG/WebP 下可由提示词自动触发透明背景
- 使用 shadcn/ui + Tailwind 构建创作工作台界面，生成页与图库共用生成记录状态，切换视图时直接保留记录卡片
- 界面统一为无阴影样式，依靠边框、间距和状态色表达层级
- 图库预览继续使用展示 URL，下载按钮走同源原始字节流，避免浏览器把原图打开到新标签页
- D1 保存任务和图片元数据
- R2 保存生成图片
- Queues 异步处理生图任务
- Node 部署模式使用 Postgres 保存元数据、Redis/BullMQ 异步处理长生图任务、R2 保存图片，避免 Cloudflare Worker 出站链路截断长请求
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

独立服务器部署见 [docs/node-server-deployment.md](docs/node-server-deployment.md)。该模式用于长时间 Image-2 请求，默认监听 `127.0.0.1:8788`，通过独立 nginx server block 暴露，不影响现有 NewAPI。
