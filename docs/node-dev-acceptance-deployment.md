# oh-myimage dev 真实验收环境部署

本文用于部署一套专门给 `oh-myimage` 前端改版做真实生图验收的 dev 环境。目标是：

- 页面走远程 `dev-gen.fourj.space`
- 生图走真实 provider，不使用 preview 假数据
- 与生产 `gen.fourj.space` 完全隔离

## 架构

- 域名：`dev-gen.fourj.space`
- nginx 反代：`127.0.0.1:8789`
- API 容器：`oh-myimage-dev-api`
- Worker 容器：`oh-myimage-dev-worker`
- Postgres 容器：`oh-myimage-dev-postgres`
- Redis 容器：`oh-myimage-dev-redis`
- 环境文件：`/etc/oh-myimage-dev/oh-myimage-dev.env`
- 代码目录：`/opt/oh-myimage-dev/current`

## 先统一一个判断

对当前项目来说，`dev-gen.fourj.space` 的正式入口是：

`nginx -> 127.0.0.1:8789 -> oh-myimage-dev-api/worker -> /opt/oh-myimage-dev/current`

不是：

`/opt/oh-myimage-dev-preview/current`

如果你只更新了静态 preview 目录，页面可能会变，但真实 `/api`、worker、数据库迁移和 Node 侧逻辑不会一起更新，不能作为“dev 已推送完成”的依据。

## 隔离要求

必须独立：

- `DATABASE_URL`
- `REDIS_URL`
- `R2_BUCKET`
- `APP_ENCRYPTION_KEY`
- nginx 站点
- 容器名和本地端口
- compose project 名

可按实际情况复用的前提：

- 只能复用现成的 dev 资源，不能直接复用生产数据库、生产 Redis、生产 worker
- 如果复用现成 dev Postgres/Redis，请把 compose 里的对应服务删掉，改成外部连接串
- `R2_BUCKET` 仍建议单独用 `oh-myimage-dev-images`

当前推荐路径：

- 复用远程已有的 `oh-myimage:latest` 镜像
- 挂载当前 release 的 `dist/`、`src/`、`migrations/`
- 不在远端默认执行 `docker build`

原因：

- 当前仓库依赖的图标包在远端 `npm ci` 时需要 `CENTRAL_LICENSE_KEY`
- 本地已经能完成前端构建和代码校验，dev 验收更适合直接复用现成镜像运行当前 release

## 前端注意事项

当前仓库已移除 `dev-gen.fourj.space` 的默认 preview 假数据模式。只有显式加 `?preview=history`、`?preview=generating` 等参数，或本地存了 preview 模式时，才会拦截 `/api/*`。

如果曾经在浏览器里打开过 preview 模式，进入真实 dev 验收前先访问：

```text
https://dev-gen.fourj.space/?preview=off
```

## 日常把最新代码推到 dev 的稳定流程

适用场景：

- 用户说「推送 dev」
- 用户说「发布到远程 dev」
- 用户说「更新 `https://dev-gen.fourj.space/`」

推荐原则：

- 本地先完成构建和必要测试
- 发布完整 release，不只发 `dist/`
- 远端复用已有 `oh-myimage:latest` 镜像
- 切换 `/opt/oh-myimage-dev/current` 后再跑迁移和重启容器

### 1. 本地确认范围并验证

```bash
git status --short
npm run build
```

如果这次改动涉及 Node 侧、worker、preview 判定或存储逻辑，再补跑定向测试，例如：

```bash
npm exec vitest run src/node/r2-store.test.ts src/client/preview-api.test.ts
```

### 2. 打完整 release 包

```bash
tar -czf oh-myimage-dev-release.tar.gz \
  dist src migrations deploy package.json package-lock.json
```

不要只传 `dist/`。这个 dev 环境实际运行的是 Node/API/Worker，`src/`、`migrations/` 和 `deploy/` 也属于 release 的一部分。

### 3. 上传到远端新 release 目录

```bash
release_name="dev-$(date +%Y%m%d%H%M%S)"
ssh token-new "mkdir -p /opt/oh-myimage-dev/releases/${release_name}"
scp oh-myimage-dev-release.tar.gz token-new:/opt/oh-myimage-dev/releases/${release_name}/
ssh token-new "cd /opt/oh-myimage-dev/releases/${release_name} && tar -xzf oh-myimage-dev-release.tar.gz && rm -f oh-myimage-dev-release.tar.gz"
```

### 4. 切换 `current`

```bash
ssh token-new "ln -sfn /opt/oh-myimage-dev/releases/${release_name} /opt/oh-myimage-dev/current"
```

### 5. 跑迁移

```bash
ssh token-new "cd /opt/oh-myimage-dev/current && docker compose -p oh-myimage-dev --env-file /etc/oh-myimage-dev/oh-myimage-dev.env -f deploy/docker-compose.oh-myimage-dev.yml run --rm oh-myimage-dev-api npm run db:migrate:postgres"
```

### 6. 重启 API 和 Worker

```bash
ssh token-new "cd /opt/oh-myimage-dev/current && docker compose -p oh-myimage-dev --env-file /etc/oh-myimage-dev/oh-myimage-dev.env -f deploy/docker-compose.oh-myimage-dev.yml up -d --force-recreate oh-myimage-dev-api oh-myimage-dev-worker"
```

默认不要在远端执行 `docker build`。当前仓库在远端重新安装依赖或构建时，可能因为缺少 `CENTRAL_LICENSE_KEY` 而失败。

### 7. 四层校验

页面 bundle：

```bash
curl -s https://dev-gen.fourj.space/ | grep -o 'assets/index-[^\" ]*\.js' | head -n 1
```

真实后端：

```bash
curl -s https://dev-gen.fourj.space/api/config
```

远端 symlink：

```bash
ssh token-new "readlink -f /opt/oh-myimage-dev/current"
```

容器状态：

```bash
ssh token-new "docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep oh-myimage-dev"
```

必要时再看日志：

```bash
ssh token-new "docker logs --tail=50 oh-myimage-dev-api"
ssh token-new "docker logs --tail=50 oh-myimage-dev-worker"
```

### 8. 浏览器验收

固定先访问：

```text
https://dev-gen.fourj.space/?preview=off
```

然后再做真实生成验收，避免被浏览器里残留的 preview 模式误导。

## 部署步骤

1. 准备代码目录

```bash
mkdir -p /opt/oh-myimage-dev/releases /etc/oh-myimage-dev
tar -xzf oh-myimage-release.tar.gz -C /opt/oh-myimage-dev/releases/release-id/
ln -sfn /opt/oh-myimage-dev/releases/release-id /opt/oh-myimage-dev/current
cp deploy/oh-myimage-dev.env.example /etc/oh-myimage-dev/oh-myimage-dev.env
chmod 600 /etc/oh-myimage-dev/oh-myimage-dev.env
```

2. 填写 `/etc/oh-myimage-dev/oh-myimage-dev.env`

至少改掉：

- `OH_MYIMAGE_POSTGRES_PASSWORD`
- `DATABASE_URL`
- `REDIS_URL`
- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`
- `R2_BUCKET`
- `APP_ENCRYPTION_KEY`

3. 启动 dev 依赖和服务

```bash
cd /opt/oh-myimage-dev/current
docker compose -p oh-myimage-dev --env-file /etc/oh-myimage-dev/oh-myimage-dev.env -f deploy/docker-compose.oh-myimage-dev.yml up -d oh-myimage-dev-postgres oh-myimage-dev-redis
docker compose -p oh-myimage-dev --env-file /etc/oh-myimage-dev/oh-myimage-dev.env -f deploy/docker-compose.oh-myimage-dev.yml run --rm oh-myimage-dev-api npm run db:migrate:postgres
docker compose -p oh-myimage-dev --env-file /etc/oh-myimage-dev/oh-myimage-dev.env -f deploy/docker-compose.oh-myimage-dev.yml up -d oh-myimage-dev-api oh-myimage-dev-worker
```

如果 Postgres/Redis 已经是外部现成 dev 资源，只需保留 migrate 和 api/worker 启动步骤。

4. 安装 nginx 站点

```bash
cp deploy/nginx/dev-gen.fourj.space.conf /etc/nginx/sites-available/dev-gen.fourj.space
ln -sfn /etc/nginx/sites-available/dev-gen.fourj.space /etc/nginx/sites-enabled/dev-gen.fourj.space
nginx -t
systemctl reload nginx
```

5. DNS

```text
dev-gen.fourj.space -> 你的 dev 主机 IP
```

## 验证

服务侧：

```bash
curl -I http://127.0.0.1:8789/
curl http://127.0.0.1:8789/api/config
docker ps --filter "name=oh-myimage-dev"
docker logs --tail=100 oh-myimage-dev-api
docker logs --tail=100 oh-myimage-dev-worker
```

页面侧：

- 先访问 `https://dev-gen.fourj.space/?preview=off`
- 创建或登录 dev 空间
- 保存 dev provider
- 用低质量参数生成 1 张图片
- 确认状态经过 `queued -> waiting_provider -> completed` 或看到真实失败原因
- 图库可见结果图并可下载

## 回滚

```bash
cd /opt/oh-myimage-dev/current
docker compose -p oh-myimage-dev --env-file /etc/oh-myimage-dev/oh-myimage-dev.env -f deploy/docker-compose.oh-myimage-dev.yml stop oh-myimage-dev-worker oh-myimage-dev-api
rm -f /etc/nginx/sites-enabled/dev-gen.fourj.space
nginx -t
systemctl reload nginx
```

这只会下线 dev 验收环境，不影响生产 `gen.fourj.space`。
