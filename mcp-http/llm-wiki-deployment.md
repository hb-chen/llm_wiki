# `llm_wiki` + `mcp-http` 部署记录

本文记录在一台 Linux 服务器上安装、配置并运行 `nashsu/llm_wiki` 以及 `mcp-http` 的实际流程。

本文覆盖两部分：

- `llm_wiki` 桌面端在 Linux 服务器上的无头运行
- `mcp-http` 的编译、发布、安装依赖、启动与验证

## 环境信息

- 服务器：`<server-ip>`
- 系统：`Ubuntu 24.04.1 LTS`
- 架构：`x86_64`
- 运行账户：`<app-user>`
- root 账户：可用
- 应用数据目录：
  - `/home/<app-user>/.local/share/com.llmwiki.app`
- 工作目录：
  - `/home/<app-user>/workspace/llm-wiki`
- `mcp-http` 部署目录：
  - `/home/<app-user>/workspace/llm-wiki/mcp-http`

## 最终结果

- `llm_wiki` 本地 API：
  - `http://127.0.0.1:19828/api/v1`
- `mcp-http` 服务地址：
  - `http://<server-ip>:19829/api/v1/mcp`
- 服务器 Node 版本：
  - `v22.22.3`
- 服务器 npm 版本：
  - `10.9.8`

## 关键结论

1. `llm_wiki` 在 Linux 服务器上运行仍然依赖图形环境，需要借助 `Xvfb`。
2. `llm_wiki` 原生 API 固定监听 `127.0.0.1:19828`。
3. `mcp-http` 是独立的 Node 服务，不内嵌在 `llm_wiki` 进程内。
4. `mcp-http` 默认监听 `0.0.0.0:19829`，可直接对外提供 MCP HTTP endpoint。
5. `mcp-http` 不能只发布 `dist/`；运行时还需要 `package.json` 和生产依赖。

## 1. 安装 `llm_wiki`

使用官方 release：

- 仓库：`https://github.com/nashsu/llm_wiki`
- release：`v0.4.19`
- 包：`LLM.Wiki_0.4.19_amd64.deb`

安装命令：

```bash
curl -fL \
  https://github.com/nashsu/llm_wiki/releases/download/v0.4.19/LLM.Wiki_0.4.19_amd64.deb \
  -o /tmp/LLM.Wiki_0.4.19_amd64.deb

apt-get update
apt-get install -y /tmp/LLM.Wiki_0.4.19_amd64.deb
```

安装后可执行文件：

```bash
/usr/bin/llm-wiki
```

## 2. 解决无桌面环境问题

直接启动会失败：

```bash
llm-wiki
```

典型错误：

```text
Failed to initialize gtk backend
Failed to initialize GTK
```

需要安装并使用 `Xvfb`：

```bash
apt-get install -y xvfb
```

手动运行方式：

```bash
xvfb-run -a /usr/bin/llm-wiki
```

## 3. 打开 `llm_wiki` 本地 API

配置文件：

```bash
/home/<app-user>/.local/share/com.llmwiki.app/app-state.json
```

需要保证 `apiConfig` 至少包含：

```json
{
  "apiConfig": {
    "enabled": true,
    "mcpEnabled": true,
    "allowUnauthenticated": true,
    "token": ""
  }
}
```

含义：

- `enabled=true`：启用本地 HTTP API
- `mcpEnabled=true`：允许 MCP 相关能力
- `allowUnauthenticated=true`：允许无 token 访问本地 API
- `token=""`：当前未配置 API token

如果后续要开启鉴权，可以改为：

```json
{
  "apiConfig": {
    "enabled": true,
    "mcpEnabled": true,
    "allowUnauthenticated": false,
    "token": "your-random-token"
  }
}
```

## 4. 注册知识库项目

项目目录示例：

- `/home/<app-user>/workspace/llm-wiki/<wiki-project-a>`
- `/home/<app-user>/workspace/llm-wiki/<wiki-project-b>`

每个项目目录都需要存在：

```bash
.llm-wiki/project.json
```

示例：

```json
{"id":"<wiki-project-a>"}
```

`app-state.json` 中需要写入：

```json
{
  "projectRegistry": {
    "<wiki-project-a>": {
      "name": "<wiki-project-a>",
      "path": "/home/<app-user>/workspace/llm-wiki/<wiki-project-a>"
    },
    "<wiki-project-b>": {
      "name": "<wiki-project-b>",
      "path": "/home/<app-user>/workspace/llm-wiki/<wiki-project-b>"
    }
  },
  "recentProjects": [
    {
      "name": "<wiki-project-a>",
      "path": "/home/<app-user>/workspace/llm-wiki/<wiki-project-a>"
    },
    {
      "name": "<wiki-project-b>",
      "path": "/home/<app-user>/workspace/llm-wiki/<wiki-project-b>"
    }
  ]
}
```

## 5. 配置 `llm_wiki` systemd 服务

启动脚本：

```bash
# /home/<app-user>/bin/llmwiki-run.sh
#!/usr/bin/env bash
set -euo pipefail

exec xvfb-run -a /usr/bin/llm-wiki
```

赋权：

```bash
chmod +x /home/<app-user>/bin/llmwiki-run.sh
```

服务文件：

```ini
# /etc/systemd/system/llmwiki.service
[Unit]
Description=LLM Wiki headless service
After=network.target

[Service]
Type=simple
User=<app-user>
WorkingDirectory=/home/<app-user>
ExecStart=/home/<app-user>/bin/llmwiki-run.sh
Restart=always
RestartSec=5
Environment=HOME=/home/<app-user>

[Install]
WantedBy=multi-user.target
```

启用并启动：

```bash
systemctl daemon-reload
systemctl enable --now llmwiki.service
```

检查：

```bash
systemctl status llmwiki.service --no-pager
```

正常日志应包含：

```text
[API Server] Listening on http://127.0.0.1:19828/api/v1
```

## 6. 安装 Node.js 22.x

服务器最终使用的是 NodeSource 的 Node 22.x。

安装命令：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
```

验证：

```bash
node -v
npm -v
which node
which npm
```

实际结果：

```text
node -v -> v22.22.3
npm -v  -> 10.9.8
/usr/bin/node
/usr/bin/npm
```

## 7. 本地编译 `mcp-http`

源码目录：

```bash
<local-repo>/mcp-http
```

编译步骤：

```bash
cd <local-repo>/mcp-http
npm install
npm run build
```

构建完成后，核心产物是：

```text
dist/
package.json
package-lock.json
README.md
```

注意：

- 不能只发布 `dist/`
- 运行时依赖 `@modelcontextprotocol/sdk`
- 因此服务器上仍然要执行一次 `npm install --omit=dev`

## 8. `mcp-http` 发布目录结构

服务器目标目录：

```bash
/home/<app-user>/workspace/llm-wiki/mcp-http
```

建议最小发布内容：

```text
mcp-http/
├── dist/
├── package.json
├── package-lock.json
└── README.md
```

如果需要补充部署说明，也可以一并放入：

```text
mcp-http-change-notes.md
llm-wiki-deployment.md
```

## 9. 服务器安装 `mcp-http` 运行依赖

进入部署目录：

```bash
cd /home/<app-user>/workspace/llm-wiki/mcp-http
```

安装生产依赖：

```bash
npm install --omit=dev
```

注意：

- 如果目录中存在半安装残留，`npm install` 可能报 `ENOTEMPTY`
- 这时先清理冲突目录，必要时直接删除 `node_modules` 后重装

示例：

```bash
rm -rf node_modules
npm install --omit=dev
```

## 10. 启动 `mcp-http`

启动命令：

```bash
cd /home/<app-user>/workspace/llm-wiki/mcp-http
node dist/src/index.js
```

如果 `llm_wiki` 本地 API 开启了 token 鉴权，则需要：

```bash
LLM_WIKI_API_TOKEN=your-token node dist/src/index.js
```

可选环境变量：

```bash
MCP_HTTP_HOST=0.0.0.0
MCP_HTTP_PORT=19829
LLM_WIKI_API_BASE_URL=http://127.0.0.1:19828
```

完整示例：

```bash
MCP_HTTP_HOST=0.0.0.0 \
MCP_HTTP_PORT=19829 \
LLM_WIKI_API_BASE_URL=http://127.0.0.1:19828 \
node dist/src/index.js
```

当前版本默认监听：

```text
http://0.0.0.0:19829/api/v1/mcp
```

对外访问地址：

```text
http://<server-ip>:19829/api/v1/mcp
```

## 11. 配置 `mcp-http` systemd 服务

推荐不要手工常驻 `node dist/src/index.js`，而是交给 `systemd` 托管。

启动脚本不是必需的，`mcp-http` 可以直接由 `systemd` 调起 `node`。

服务文件示例：

```ini
# /etc/systemd/system/llmwiki-mcp.service
[Unit]
Description=LLM Wiki MCP service
After=network.target llmwiki.service
Requires=llmwiki.service

[Service]
Type=simple
User=<app-user>
WorkingDirectory=/home/<app-user>/workspace/llm-wiki/mcp-http
ExecStart=/usr/bin/node /home/<app-user>/workspace/llm-wiki/mcp-http/dist/src/index.js
Restart=always
RestartSec=5
Environment=HOME=/home/<app-user>
Environment=MCP_HTTP_HOST=0.0.0.0
Environment=MCP_HTTP_PORT=19829
Environment=LLM_WIKI_API_BASE_URL=http://127.0.0.1:19828

# 如果 llm_wiki 本地 API 开启了 token，再增加：
# Environment=LLM_WIKI_API_TOKEN=your-token

[Install]
WantedBy=multi-user.target
```

仓库里也放了一份模板：

- [llmwiki-mcp.service.example](./llmwiki-mcp.service.example)

启用并启动：

```bash
cp /home/<app-user>/workspace/llm-wiki/mcp-http/llmwiki-mcp.service.example /etc/systemd/system/llmwiki-mcp.service
systemctl daemon-reload
systemctl enable --now llmwiki-mcp.service
```

查看状态：

```bash
systemctl status llmwiki-mcp.service --no-pager
```

查看日志：

```bash
journalctl -u llmwiki-mcp.service -n 100 --no-pager
```

修改 `dist/` 或环境变量后重启：

```bash
systemctl restart llmwiki-mcp.service
```

如果修改了 service 文件本身：

```bash
systemctl daemon-reload
systemctl restart llmwiki-mcp.service
```

## 12. `mcp-http` 的 MCP client 配置

示例配置：

```json
{
  "mcpServers": {
    "llm-wiki-http": {
      "transport": "streamable_http",
      "url": "http://<server-ip>:19829/api/v1/mcp"
    }
  }
}
```

说明：

- 不要写空的 `Authorization` header
- 如果 `llm_wiki` API 本身启用了 token，优先让 `mcp-http` 进程通过 `LLM_WIKI_API_TOKEN` 去访问本地 API
- `mcp-http` 当前已经支持 `streamable_http` 所需的 `GET/POST/DELETE`

## 13. 验证方式

### 验证 `llm_wiki` 本地 API

健康检查：

```bash
curl http://127.0.0.1:19828/api/v1/health
```

项目列表：

```bash
curl http://127.0.0.1:19828/api/v1/projects
```

### 验证 `mcp-http` 监听

端口检查：

```bash
ss -ltnp | egrep '19828|19829'
```

预期：

- `127.0.0.1:19828` 由 `llm-wiki` 监听
- `0.0.0.0:19829` 或 `*:19829` 由 `node` / `mcp-http` 监听

### 验证 `mcp-http` 启动日志

启动后应出现类似日志：

```text
LLM Wiki MCP HTTP server v0.4.18 listening at http://0.0.0.0:19829/api/v1/mcp -> http://127.0.0.1:19828
```

### 验证 MCP 客户端接入

推荐最先验证：

- `llm_wiki_status`
- `llm_wiki_projects`

如果 MCP 客户端接入后报 `405`，通常说明服务端错误地只支持了 `POST`，而没有放行 `GET/DELETE`。当前版本已经修复该问题。

## 14. 常用运维命令

查看 `llm_wiki` 状态：

```bash
systemctl status llmwiki.service --no-pager
```

重启 `llm_wiki`：

```bash
systemctl restart llmwiki.service
```

查看 `llm_wiki` 健康检查：

```bash
curl http://127.0.0.1:19828/api/v1/health
```

查看 `mcp-http` 进程：

```bash
ps -ef | grep 'dist/src/index.js' | grep -v grep
```

查看 `mcp-http` 服务状态：

```bash
systemctl status llmwiki-mcp.service --no-pager
```

重启 `mcp-http`：

```bash
systemctl restart llmwiki-mcp.service
```

查看 `mcp-http` 日志：

```bash
journalctl -u llmwiki-mcp.service -n 100 --no-pager
```

查看 `mcp-http` 监听端口：

```bash
ss -ltnp | grep 19829
```

手动启动 `mcp-http`：

```bash
cd /home/<app-user>/workspace/llm-wiki/mcp-http
node dist/src/index.js
```

## 15. 当前已确认的限制

1. `llm_wiki` 不是原生 Linux 后台服务，必须依赖 `Xvfb`。
2. `llm_wiki` 原生 API 固定绑定 `127.0.0.1:19828`。
3. `mcp-http` 是额外的 Node 服务，不会替代 `llm_wiki` 本地 API。
4. `mcp-http` 运行时不能只有 `dist/`，还必须有运行依赖。
5. `mcp-http` 对外暴露的是 MCP endpoint，不是把 `/api/v1` 原生 API 直接改成公网 HTTP API。

## 16. 当前可用地址

- `llm_wiki` 健康检查：
  - `http://127.0.0.1:19828/api/v1/health`
- `llm_wiki` 项目列表：
  - `http://127.0.0.1:19828/api/v1/projects`
- `mcp-http` MCP endpoint：
  - `http://<server-ip>:19829/api/v1/mcp`
