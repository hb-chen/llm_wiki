# LLM Wiki MCP HTTP Server

中文改造说明见 [mcp-http-change-notes.md](./mcp-http-change-notes.md)。

This package exposes the running LLM Wiki desktop app as a Model Context Protocol server over HTTP.

It does **not** scan project folders directly and does **not** copy the app's search or graph logic. Every tool calls the local desktop API at `http://127.0.0.1:19828/api/v1`, so MCP clients use the same project registry, file permissions, search backend, graph backend, and Source Watch rules as the app.

## Requirements

- Node.js 20+
- LLM Wiki desktop app running
- Settings → API + MCP → "Enable local HTTP API"
- Settings → API + MCP → "Enable MCP access"
- Either:
  - Settings → API + MCP → "Allow access without a token", or
  - `LLM_WIKI_API_TOKEN` set to the configured API token

Optional:

- `LLM_WIKI_API_BASE_URL` to override the default API base URL.

## Build

```bash
cd mcp-http
npm install
npm run build
```

## Run

```bash
LLM_WIKI_API_TOKEN=your-token node dist/src/index.js
```

By default it listens on `http://0.0.0.0:19829/api/v1/mcp`.

- `MCP_HTTP_HOST` overrides the bind host. Default: `0.0.0.0`
- `MCP_HTTP_PORT` overrides the bind port. Default: `19829`

Example MCP client config:

```json
{
  "mcpServers": {
    "llm-wiki": {
      "url": "http://<server-ip>:19829/api/v1/mcp"
    }
  }
}
```

Set `LLM_WIKI_API_TOKEN` in the `mcp-http` server process itself when the desktop API requires authentication. When API unauthenticated mode is enabled, omit it. If MCP access is disabled in Settings, `llm_wiki_status` still works for diagnosis but other tools return an explicit disabled error.

## Tools

- `llm_wiki_status`: health and current project summary.
- `llm_wiki_projects`: known projects and active project.
- `llm_wiki_files`: list project files. `project_id` can be a project UUID, a project filesystem path, or `current`.
- `llm_wiki_read_file`: read an allowed text file such as `wiki/index.md`.
- `llm_wiki_search`: search with the app's shared keyword/vector backend.
- `llm_wiki_graph`: query the app's knowledge graph endpoint.
- `llm_wiki_rescan_sources`: trigger a Source Watch rescan using the user's configured rules.

## Security model

The MCP server inherits the desktop API's security model:

- It binds to `0.0.0.0` by default.
- It uses the same API token or unauthenticated setting as Settings → API + MCP.
- File reads go through the API path allow-list. Internal app state files are not exposed.
- Search and graph tools operate on projects known to the app; use `project_id: "current"` for the active project.

Do not pass API tokens via command-line arguments. Prefer environment variables so they do not appear in shell history.
