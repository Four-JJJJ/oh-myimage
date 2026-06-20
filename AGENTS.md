# AGENTS.md — oh-myimage 项目约定

## Dev 发布标准路径

适用目标：

- 用户明确说“推送 dev”“发布到远程 dev”“更新 `https://dev-gen.fourj.space/`”

自然语言触发约定：

- 后续在这个仓库里，用户说“推送 dev”“发布 dev”“更新 dev”“更新 `dev-gen.fourj.space`”“发到远程 dev”等同类表达时，默认等价为执行 `npm run push:dev`
- 除非用户明确说明“只预演”“先不要真的发布”“只给我命令”“只读查看”，否则按真实发布处理
- 如果用户明确说“先看流程”或“先 dry run”，则执行 `DRY_RUN=1 npm run push:dev`
- 如果用户在同一句里附带测试要求，例如“推 dev 前顺便跑这两个测试”，则通过 `TEST_ARGS="..." npm run push:dev` 一并执行
- 这个自然语言触发规则只适用于 `dev-gen.fourj.space` 这条标准 dev 发布链路，不适用于生产或其他环境

默认真相源：

- 远端机器：`ssh token-new`
- 远端主机：`204.44.101.202`
- 用户验收地址：`https://dev-gen.fourj.space/`

当前唯一默认路径：

1. `dev-gen.fourj.space` 真实 dev 验收环境
   - 这是默认路径。
   - 用户在浏览器里验收的通常就是这一条。
   - nginx 配置：`/etc/nginx/sites-available/dev-gen.fourj.space`
   - nginx 实际入口：`127.0.0.1:8789`
   - 当前 release symlink：`/opt/oh-myimage-dev/current`
   - release 目录：`/opt/oh-myimage-dev/releases/`
   - compose 文件：`/opt/oh-myimage-dev/current/deploy/docker-compose.oh-myimage-dev.yml`
   - 环境文件：`/etc/oh-myimage-dev/oh-myimage-dev.env`

2. `/opt/oh-myimage-dev-preview/*` 静态 preview 目录
   - 这不是 `dev-gen.fourj.space` 的正式发布入口。
   - 可以存在，但默认不作为真实生图验收结果的判断依据。
   - 不要把“preview 静态页面更新了”误判为“dev 真正更新完成”。

3. `/opt/oh-myimage/current` 生产或其他容器化目录
   - 这不是默认的 dev 验收入口。
   - 只有用户明确要求更新对应环境，才走这条。
   - 当前已知风险：远端直接重建可能缺 `CENTRAL_LICENSE_KEY`，不要默认在远端硬编译。

## 标准执行流程

当目标是 `dev-gen.fourj.space` 时，按下面步骤直接执行：

1. 本地确认代码范围
   - `git status --short`
   - 忽略无关未跟踪文件，如 `.DS_Store`、`.agents/skills/...`
   - 如需要，先确认目标提交已在当前分支 `dev`

2. 本地验证并构建
   - `npm run build`
   - 如涉及 Node 侧修复，优先补跑定向测试，例如 `npm exec vitest run ...`
   - 不要只验证前端；`dev-gen.fourj.space` 走的是整套 Node/API/Worker 环境

3. 本地打完整 release
   - release 名建议：`dev-YYYYMMDDHHMMSS`
   - release 内容至少包含：`dist/`、`src/`、`migrations/`、`deploy/`、`package.json`
   - 不要只上传 `dist/`，否则页面和真实 `/api` / worker 版本可能不一致

4. 远端创建新 dev release
   - 目标目录：`/opt/oh-myimage-dev/releases/<release-name>`
   - 上传后将 `/opt/oh-myimage-dev/current` 切到这个新 release

5. 运行数据库迁移
   - 在远端新 release 下执行 `db:migrate:postgres`
   - 不要跳过；前端变更可能依赖新的表结构或字段

6. 重启 dev API 和 Worker
   - 使用 `docker compose -p oh-myimage-dev --env-file /etc/oh-myimage-dev/oh-myimage-dev.env -f deploy/docker-compose.oh-myimage-dev.yml up -d --force-recreate oh-myimage-dev-api oh-myimage-dev-worker`
   - 默认复用远端已有 `oh-myimage:latest` 镜像，不在远端重新 `docker build`

7. 线上校验
   - `curl -s https://dev-gen.fourj.space/`，确认首页引用了新的 `assets/index-*.js`
   - `curl -s https://dev-gen.fourj.space/api/config`，确认真实后端配置可达
   - 远端确认：
     - `readlink -f /opt/oh-myimage-dev/current`
     - `docker ps --format "table {{.Names}}\t{{.Status}}" | grep oh-myimage-dev`
     - `docker logs --tail=50 oh-myimage-dev-api`
     - `docker logs --tail=50 oh-myimage-dev-worker`
   - 浏览器验收固定使用 `https://dev-gen.fourj.space/?preview=off`
   - 必要时再 grep bundle 中的关键修复标记，确认不是旧包

## 推荐命令骨架

本地构建与定向验证：

```bash
npm run build
npm exec vitest run <target-test-files>
```

本地打包完整 release：

```bash
tar -czf oh-myimage-dev-release.tar.gz \
  dist dist-node src migrations deploy package.json package-lock.json
```

远端准备目录并上传：

```bash
ssh token-new "mkdir -p /opt/oh-myimage-dev/releases/<release-name>"
scp oh-myimage-dev-release.tar.gz token-new:/opt/oh-myimage-dev/releases/<release-name>/
ssh token-new "cd /opt/oh-myimage-dev/releases/<release-name> && tar -xzf oh-myimage-dev-release.tar.gz && rm -f oh-myimage-dev-release.tar.gz"
```

切换、迁移、重启：

```bash
ssh token-new "ln -sfn /opt/oh-myimage-dev/releases/<release-name> /opt/oh-myimage-dev/current"
ssh token-new "cd /opt/oh-myimage-dev/current && docker compose -p oh-myimage-dev --env-file /etc/oh-myimage-dev/oh-myimage-dev.env -f deploy/docker-compose.oh-myimage-dev.yml run --rm oh-myimage-dev-api npm run db:migrate:postgres"
ssh token-new "cd /opt/oh-myimage-dev/current && docker compose -p oh-myimage-dev --env-file /etc/oh-myimage-dev/oh-myimage-dev.env -f deploy/docker-compose.oh-myimage-dev.yml up -d --force-recreate oh-myimage-dev-api oh-myimage-dev-worker"
```

线上校验：

```bash
curl -s https://dev-gen.fourj.space/ | grep -o 'assets/index-[^\" ]*\.js' | head -n 1
curl -s https://dev-gen.fourj.space/api/config
ssh token-new "readlink -f /opt/oh-myimage-dev/current"
ssh token-new "docker ps --format 'table {{.Names}}\t{{.Status}}' | grep oh-myimage-dev"
```

## 交付要求

完成后默认要给用户这些信息：

- 已发布到哪个地址
- 当前远端 release 目录
- 当前页面引用的 bundle 文件名
- 当前 `api/config` 是否正常
- 做过哪些验证
- 如果用户仍看不到效果，先提示强刷 `Cmd + Shift + R`

## 禁止默认假设

- 不要把 `/opt/oh-myimage-dev-preview/current` 当成 `dev-gen.fourj.space` 的默认发布入口
- 不要只上传 `dist/` 就认为 `dev-gen.fourj.space` 已更新
- 不要把 `/opt/oh-myimage/current` 当成 `dev-gen.fourj.space` 的默认发布入口
- 不要默认在远端重新 `docker build`
- 不要因为代码已 push 到 `origin/dev` 就认为用户验收页面已更新
- 不要跳过 `api/config` / 容器状态 / symlink 校验
