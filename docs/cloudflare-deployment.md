# Cloudflare 部署手册

## 当前部署

- Worker URL: `https://image-2-platform.fourjjjjci.workers.dev`
- Cloudflare account: `909a6b863d75fd896d98e647a884581e`
- D1 database: `image-2-platform` / `038dabd7-a970-454a-b0a4-a9f7c8ed73df`
- R2 bucket: `image-2-images`
- Queues: `image-2-generation`, `image-2-inspiration`
- Turnstile: 第一版暂未启用，`TURNSTILE_REQUIRED = "false"`

不要把 Cloudflare API Token、OpenAI/兼容服务 API Key、`APP_ENCRYPTION_KEY` 写入仓库。

## 1. 创建资源

先注册 Cloudflare 免费账号，暂时不迁移腾讯云域名。第一版使用 `workers.dev` 默认域名。

```bash
npm install
npx wrangler login
npx wrangler d1 create image-2-platform
npx wrangler r2 bucket create image-2-images
npx wrangler queues create image-2-generation
npx wrangler queues create image-2-inspiration
```

把 `d1 create` 返回的 `database_id` 写入 `wrangler.toml`。

## 2. 配置密钥

```bash
npx wrangler secret put APP_ENCRYPTION_KEY
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put X_BEARER_TOKEN
```

本地开发可创建 `.dev.vars`：

```bash
APP_ENCRYPTION_KEY="replace-with-strong-random-secret"
TURNSTILE_SECRET_KEY=""
TURNSTILE_REQUIRED="false"
X_BEARER_TOKEN=""
```

如果不采集 X，可跳过 `X_BEARER_TOKEN`。X 来源只使用官方 API 或用户手动粘贴提示词导入，不做网页抓取。

如果启用 Turnstile，需要在 Cloudflare 控制台创建 Turnstile site，并把 site key 填到 `wrangler.toml` 的 `TURNSTILE_SITE_KEY`。

## 3. 数据库迁移

```bash
npm run db:migrate:local
npm run db:migrate:remote
```

## 4. 本地验证

```bash
npm run typecheck
npm run test
npm run build
npm run dev
```

打开 Wrangler 输出的本地地址，创建空间，进入设置页，保存用户自己的 `baseURL + API Key + model`。

## 5. 部署

```bash
npm run deploy
```

部署完成后使用 `*.workers.dev` 访问。第一版不修改腾讯云 DNS，不绑定自定义域名。

## 6. 上线验收

- 登录空间成功。
- 设置页保存 provider 后不会回显完整 API Key。
- 测试连接返回成功或明确失败原因。
- 使用低质量参数生成 1 张图片。
- 任务状态从 `queued/running` 变为 `succeeded`。
- 图库能看到图片，并可以下载。
- D1 中有任务和图片元数据。
- R2 中有对应图片文件。
- 灵感页可以看到 Civitai 定时采集或手动导入的素材，收藏后能在生成页套用提示词。
- 本地可用 Wrangler 的 scheduled handler 冒烟触发 Cron：`curl "http://localhost:8787/cdn-cgi/handler/scheduled"`。

## 7. 成本保护默认值

- 单空间每日任务：50
- 单次生成数量：4
- 单空间同时运行任务：2
- 图片保留期：90 天，当前版本只记录配置，清理任务后续实现
- 灵感单次采集：12 条
- 灵感缩略图缓存上限：1MB，超过则只保存来源和图片外链

超过每日 1000 个任务、R2 超过 50GB 或 Workers 请求接近免费层上限时，再升级 Workers Paid 或拆分服务。
