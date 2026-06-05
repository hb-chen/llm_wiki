# `mcp-server` 改造为 `mcp-http` 说明

本文记录本次基于现有 `mcp-server` 复制出 `mcp-http`，并将 MCP 通信方式从 `stdio` 改为 HTTP 的改动内容。

目标路径固定为：

- `POST /api/v1/mcp`

默认监听地址为：

- `http://0.0.0.0:19829/api/v1/mcp`

## 1. 改造目标

原有 `mcp-server` 是一个标准 `stdio` MCP 服务：

- MCP 客户端通过启动本地 Node 进程接入
- 双方通过 `stdin/stdout` 交换 MCP 消息

本次改造目标是新增一套 HTTP 版 MCP 服务 `mcp-http`：

- 保留原有 `mcp-server`，不覆盖
- 新增独立目录 `mcp-http`
- 对外通过 HTTP 暴露 MCP
- MCP 入口路径固定为 `/api/v1/mcp`

## 2. 改造范围

本次改造采用“复制后修改”的方式：

- 源目录：`mcp-server/`
- 新目录：`mcp-http/`

保留内容：

- MCP 工具定义
- `LlmWikiApiClient`
- 与桌面端 `LLM Wiki API` 的交互逻辑
- 现有工具返回格式

替换内容：

- 启动方式
- transport 类型
- 运行文档
- 根目录脚本入口

## 3. 目录与文件变更

新增目录：

- `mcp-http/`

主要文件：

- `mcp-http/src/index.ts`
- `mcp-http/src/api-client.ts`
- `mcp-http/package.json`
- `mcp-http/README.md`

根目录脚本补充：

- `package.json`
  - 新增 `mcp-http:build`
  - 新增 `mcp-http:test`
  - `test:mocks` 排除 `mcp-http/**`

## 4. 核心实现改动

### 4.1 transport 从 `stdio` 改为 HTTP

原 `mcp-server` 使用：

- `StdioServerTransport`

改造后的 `mcp-http` 使用：

- `StreamableHTTPServerTransport`

这意味着 MCP 服务不再依赖：

- `stdin`
- `stdout`

而是通过本地 HTTP 服务接收请求并返回 MCP 响应。

### 4.2 新增本地 HTTP Server

`mcp-http/src/index.ts` 中新增了 Node HTTP server，负责：

- 监听端口
- 校验请求路径
- 处理 `OPTIONS`
- 处理 `POST`
- 解析 JSON body
- 将请求转交给 MCP HTTP transport

当前路径约束为：

- 只有 `POST /api/v1/mcp` 会进入 MCP 处理逻辑
- 其他路径返回 `404`
- 非 `POST/OPTIONS` 返回 `405`

### 4.3 新增 HTTP 相关配置

新增环境变量：

- `MCP_HTTP_HOST`
  - 默认值：`0.0.0.0`
- `MCP_HTTP_PORT`
  - 默认值：`19829`

保留环境变量：

- `LLM_WIKI_API_BASE_URL`
  - 默认指向桌面端本地 API：`http://127.0.0.1:19828`
- `LLM_WIKI_API_TOKEN`
  - 当桌面端 API 开启鉴权时，由 `mcp-http` 进程自身携带该 token 去访问 LLM Wiki API

注意：

- 这里的 `LLM_WIKI_API_TOKEN` 是 `mcp-http` 用来访问桌面端 API 的，不是要求 MCP 客户端额外透传给 `mcp-http`

### 4.4 MCP 工具层未改

以下工具定义保持不变：

- `llm_wiki_status`
- `llm_wiki_projects`
- `llm_wiki_files`
- `llm_wiki_read_file`
- `llm_wiki_search`
- `llm_wiki_graph`
- `llm_wiki_rescan_sources`

也就是说，这次改造只改了“传输方式”，没有改“能力集合”。

## 5. 与原 `mcp-server` 的差异

### 原 `mcp-server`

- 接入方式：本地启动命令
- MCP client 配置方式：`command + args + env`
- 传输方式：`stdio`

典型配置形态：

```json
{
  "mcpServers": {
    "llm-wiki": {
      "command": "node",
      "args": ["/path/to/mcp-server/dist/src/index.js"]
    }
  }
}
```

### 新 `mcp-http`

- 接入方式：HTTP URL
- MCP client 配置方式：`url`
- 传输方式：HTTP

典型配置形态：

```json
{
  "mcpServers": {
    "llm-wiki": {
      "url": "http://<server-ip>:19829/api/v1/mcp"
    }
  }
}
```

## 6. 当前默认运行方式

在 `mcp-http/` 目录下：

```bash
npm install
npm run build
LLM_WIKI_API_TOKEN=your-token node dist/src/index.js
```

默认监听：

```text
http://0.0.0.0:19829/api/v1/mcp
```

如果桌面端 API 允许匿名访问，则可以不设置 `LLM_WIKI_API_TOKEN`。

## 7. 当前实现边界

本次改造是最小可用版本，重点是把 `stdio` 改成 HTTP，并让路径固定为 `/api/v1/mcp`。

当前实现特征：

- 单独运行一个本地 Node HTTP 服务
- `mcp-http` 自己持有访问桌面端 API 的 token
- 不改动桌面端 API 本身
- 不把 MCP 直接内嵌进现有 Tauri/Rust API 服务

这意味着当前架构仍然是两层：

1. `mcp-http`
2. `LLM Wiki desktop local API`

## 8. 当前未完成验证项

当前代码已完成改造，但还没有在本环境里完成最终构建验证。

原因是当前执行环境里：

- `node/npm` 默认不在 `PATH`
- 后续 `npm install` 访问 npm registry 时出现 `ENOTFOUND`

因此当前状态是：

- 代码已改完
- 文档已补
- 但 `mcp-http` 的实际 `install/build/test` 还未在本环境跑通

建议后续验证顺序：

1. `npm --prefix mcp-http install`
2. `npm run mcp-http:build`
3. 启动 `mcp-http`
4. 用 MCP client 指向 `http://<server-ip>:19829/api/v1/mcp`
5. 验证 `llm_wiki_status` 与 `llm_wiki_projects`

## 9. 相关文件

- [mcp-http/src/index.ts](./src/index.ts)
- [mcp-http/README.md](./README.md)
- [mcp-server/README.md](../mcp-server/README.md)
- [package.json](../package.json)
