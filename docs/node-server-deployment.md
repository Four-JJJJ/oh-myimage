# Node 服务器部署手册

本文用于把 `oh-myimage` 部署到独立服务器，移除生图链路中的 Cloudflare Worker，同时继续使用 Cloudflare R2/S3 兼容对象存储。

## 隔离原则

- 代码目录：`/opt/oh-myimage/current`
- 环境文件：`/etc/oh-myimage/oh-myimage.env`
- API 容器：`oh-myimage-api`
- Worker 容器：`oh-myimage-worker`
- 本地监听：`127.0.0.1:8788`
- Postgres：独立容器 `oh-myimage-postgres`，端口 `127.0.0.1:15432`
- Redis：独立容器 `oh-myimage-redis`，端口 `127.0.0.1:16379`

不要修改现有 NewAPI 容器、NewAPI 数据库、`image.fourj.space` nginx 配置或 3000/3014 相关端口。

## 环境变量

`/etc/oh-myimage/oh-myimage.env` 至少需要：

```bash
HOST=0.0.0.0
PORT=8788
NODE_REQUEST_TIMEOUT_MS=700000
NODE_GENERATION_WORKER_CONCURRENCY=10

OH_MYIMAGE_POSTGRES_PASSWORD=replace-password
DATABASE_URL=postgres://oh_myimage:replace-password@oh-myimage-postgres:5432/oh_myimage
REDIS_URL=redis://oh-myimage-redis:6379

R2_ACCOUNT_ID=replace-cloudflare-account-id
R2_ACCESS_KEY_ID=replace-r2-access-key-id
R2_SECRET_ACCESS_KEY=replace-r2-secret-access-key
R2_BUCKET=image-2-images

APP_ENCRYPTION_KEY=replace-with-existing-or-new-strong-key
TURNSTILE_REQUIRED=false
TURNSTILE_SECRET_KEY=
TURNSTILE_SITE_KEY=

DEFAULT_IMAGE_MODEL=gpt-image-2
PROMPT_OPTIMIZER_MODEL=gpt-5.5
MAX_IMAGES_PER_REQUEST=4
MAX_DAILY_IMAGES_PER_SPACE=50
MAX_RUNNING_JOBS_PER_SPACE=12
REQUEST_TIMEOUT_MS=600000
PROVIDER_IMAGE_BATCH_SIZE=1
PROVIDER_IMAGE_CONCURRENCY=2
PROVIDER_RETRY_ATTEMPTS=2
PROVIDER_RETRY_DELAY_SECONDS=120
IMAGE_RETENTION_DAYS=90
INSPIRATION_FEATURE_ENABLED=false
```

该配置允许最多 10 个生图任务同时被 worker 处理。单任务最多 4 张图，`PROVIDER_IMAGE_CONCURRENCY=2` 会让 4 张图按 `2 + 2` 分批请求上游，因此真实上游图片请求峰值约为 20。

如果迁移旧 D1 数据，`APP_ENCRYPTION_KEY` 必须使用原来的值，否则旧 API Key 密文无法解密。

## 部署步骤

1. 创建环境文件和独立容器：

```bash
mkdir -p /etc/oh-myimage /opt/oh-myimage/releases
install -m 600 /path/to/oh-myimage.env /etc/oh-myimage/oh-myimage.env
```

2. 安装代码并启动：

```bash
mkdir -p /opt/oh-myimage/releases
tar -xzf oh-myimage-release.tar.gz -C /opt/oh-myimage/releases/release-id/
ln -sfn /opt/oh-myimage/releases/release-id /opt/oh-myimage/current
cd /opt/oh-myimage/current
docker compose --env-file /etc/oh-myimage/oh-myimage.env -f deploy/docker-compose.oh-myimage.yml up -d --build oh-myimage-postgres oh-myimage-redis
docker compose --env-file /etc/oh-myimage/oh-myimage.env -f deploy/docker-compose.oh-myimage.yml run --rm oh-myimage-api npm run db:migrate:postgres
docker compose --env-file /etc/oh-myimage/oh-myimage.env -f deploy/docker-compose.oh-myimage.yml up -d --build oh-myimage-api oh-myimage-worker
```

灵感库默认关闭时无需定时任务；需要定时采集时可以使用宿主机 cron 定期执行：

```bash
cd /opt/oh-myimage/current
docker compose --env-file /etc/oh-myimage/oh-myimage.env -f deploy/docker-compose.oh-myimage.yml run --rm oh-myimage-api npm run cron:node
```

3. 安装 nginx 独立站点：

```bash
cp deploy/nginx/ohmyimage.fourj.space.conf /etc/nginx/sites-available/gen.fourj.space
ln -sfn /etc/nginx/sites-available/gen.fourj.space /etc/nginx/sites-enabled/gen.fourj.space
nginx -t
systemctl reload nginx
```

4. 腾讯云 DNS 新增 A 记录：

```text
gen.fourj.space -> 47.90.135.219
```

## 验证

```bash
curl -I http://127.0.0.1:8788/
curl http://127.0.0.1:8788/api/config
docker ps --filter "name=oh-myimage"
docker logs --tail=100 oh-myimage-api
docker logs --tail=100 oh-myimage-worker
```

页面验证：

- 创建/登录空间成功。
- Provider 保存后不回显完整 API Key。
- 上传参考图可写入 R2。
- 生图任务进入队列并成功完成。
- 超过 120 秒的生图请求不会再被 Cloudflare Worker 链路截断。
- 图库下载接口返回 302 到 R2 presigned URL。

## 回滚

```bash
cd /opt/oh-myimage/current
docker compose --env-file /etc/oh-myimage/oh-myimage.env -f deploy/docker-compose.oh-myimage.yml stop oh-myimage-worker oh-myimage-api
rm -f /etc/nginx/sites-enabled/gen.fourj.space
nginx -t
systemctl reload nginx
```

回滚只会停止新项目，不影响 NewAPI、`image.fourj.space` 或现有 3000/3014 链路。
