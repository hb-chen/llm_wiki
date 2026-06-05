#!/usr/bin/env node
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js"
import { LlmWikiApiClient, type ApiFileNode, type ApiGraphNode, type ApiSearchResult } from "./api-client.js"

const VERSION = "0.4.18"
const DEFAULT_PROJECT_ID = "current"
const MAX_TEXT_BYTES = 120_000
const MCP_PATH = "/api/v1/mcp"
const DEFAULT_HOST = "0.0.0.0"
const DEFAULT_PORT = 19829

const client = new LlmWikiApiClient()
const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>()

async function assertMcpEnabled(): Promise<void> {
  const health = await client.health()
  if (health.mcpEnabled === false) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "LLM Wiki MCP access is disabled. Enable Settings -> API + MCP -> Enable MCP access in the desktop app.",
    )
  }
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function projectId(args: Record<string, unknown>): string {
  return optionalStringArg(args.project_id) ?? DEFAULT_PROJECT_ID
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `${name} is required`)
  }
  return value
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function boolArg(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function enumArg<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback
}

function truncateText(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes <= maxBytes) return value
  let out = ""
  let used = 0
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8")
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return `${out}\n\n[truncated: ${bytes - used} bytes omitted]`
}

function formatFileTree(files: ApiFileNode[], truncated = false): string {
  if (files.length === 0) return "No files found."
  const lines: string[] = truncated
    ? ["[warning] File tree was truncated by the LLM Wiki API maxFiles limit.", ""]
    : []
  const walk = (nodes: ApiFileNode[], depth: number) => {
    for (const node of nodes) {
      const prefix = "  ".repeat(depth)
      lines.push(`${prefix}${node.isDir ? "📁" : "📄"} ${node.path}`)
      if (node.children) walk(node.children, depth + 1)
    }
  }
  walk(files, 0)
  return lines.join("\n")
}

function formatSearchResults(query: string, search: { results: ApiSearchResult[]; mode?: string; tokenHits?: number; vectorHits?: number }): string {
  const { results } = search
  if (results.length === 0) return `No results for "${query}".`
  const meta = [
    search.mode ? `Mode: ${search.mode}` : null,
    typeof search.tokenHits === "number" ? `Token hits: ${search.tokenHits}` : null,
    typeof search.vectorHits === "number" ? `Vector hits: ${search.vectorHits}` : null,
  ].filter(Boolean)
  const lines = [`# Search results for "${query}"`, ...(meta.length > 0 ? [meta.join(" | ")] : []), ""]
  results.forEach((result, index) => {
    lines.push(`## ${index + 1}. ${result.title}`)
    lines.push(`Path: ${result.path}`)
    lines.push(`Score: ${result.score.toFixed(6)}${typeof result.vectorScore === "number" ? ` | Vector score: ${result.vectorScore.toFixed(6)}` : ""}`)
    if (result.snippet) lines.push(`Snippet: ${result.snippet}`)
    if (result.images && result.images.length > 0) {
      lines.push(`Images: ${result.images.map((image) => image.url).join(", ")}`)
    }
    lines.push("")
  })
  return lines.join("\n")
}

function formatGraph(nodes: ApiGraphNode[], edges: Array<{ source: string; target: string; weight?: number }>): string {
  const typeCounts = new Map<string, number>()
  for (const node of nodes) typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1)
  const lines = [
    "# Knowledge graph",
    "",
    `Nodes: ${nodes.length}`,
    `Edges: ${edges.length}`,
    "",
    "## Node types",
    ...[...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## Top nodes",
    ...nodes
      .slice()
      .sort((a, b) => (b.linkCount ?? 0) - (a.linkCount ?? 0))
      .slice(0, 30)
      .map((node) => `- ${node.label} (${node.type}, ${node.linkCount ?? 0} links)${node.path ? ` — ${node.path}` : ""}`),
  ]
  return lines.join("\n")
}

async function main(): Promise<void> {
  const host = process.env.MCP_HTTP_HOST?.trim() || DEFAULT_HOST
  const port = parsePort(process.env.MCP_HTTP_PORT)

  const httpServer = createServer(async (req, res) => {
    try {
      if (!matchesMcpPath(req)) {
        sendText(res, 404, "Not Found")
        return
      }

      if (req.method === "OPTIONS") {
        sendOptions(res)
        return
      }

      if (req.method !== "GET" && req.method !== "POST" && req.method !== "DELETE") {
        sendMethodNotAllowed(res, "GET, POST, DELETE, OPTIONS")
        return
      }

      const sessionId = getSessionId(req)
      const parsedBody = req.method === "POST" ? await readJsonBody(req) : undefined
      const session = sessionId ? sessions.get(sessionId) : undefined
      if (!session) {
        if (req.method !== "POST" || !containsInitializeRequest(parsedBody)) {
          sendJson(res, sessionId ? 404 : 400, {
            jsonrpc: "2.0",
            error: {
              code: sessionId ? -32001 : -32000,
              message: sessionId ? "Session not found" : "Initialization required",
            },
            id: null,
          })
          return
        }
      }

      const transport = session?.transport ?? await createSessionTransport()
      const body = req.method === "POST" ? parsedBody : undefined
      await transport.handleRequest(req, res, body)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) {
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: {
            code: -32600,
            message,
          },
          id: null,
        })
      } else {
        res.end()
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject)
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject)
      resolve()
    })
  })

  console.error(
    `LLM Wiki MCP HTTP server v${VERSION} listening at http://${host}:${port}${MCP_PATH} -> ${process.env.LLM_WIKI_API_BASE_URL ?? "http://127.0.0.1:19828"}`,
  )
}

main().catch((err) => {
  console.error("Failed to start LLM Wiki MCP HTTP server:", err)
  process.exit(1)
})

function parsePort(value: string | undefined): number {
  if (!value) return DEFAULT_PORT
  const port = Number.parseInt(value, 10)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid MCP_HTTP_PORT: ${value}`)
  }
  return port
}

function matchesMcpPath(req: IncomingMessage): boolean {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${DEFAULT_HOST}:${DEFAULT_PORT}`}`)
  return url.pathname === MCP_PATH
}

function getSessionId(req: IncomingMessage): string | undefined {
  const value = req.headers["mcp-session-id"]
  if (Array.isArray(value)) return value[0]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
  }
  if (chunks.length === 0) {
    throw new Error("Request body is required")
  }
  const raw = Buffer.concat(chunks).toString("utf8")
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader("Allow", allow)
  sendText(res, 405, "Method Not Allowed")
}

function sendOptions(res: ServerResponse): void {
  res.statusCode = 204
  res.setHeader("Allow", "GET, POST, DELETE, OPTIONS")
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Headers", "content-type, mcp-session-id")
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
  res.end()
}

function sendText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status
  res.setHeader("Content-Type", "text/plain; charset=utf-8")
  res.end(body)
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

function containsInitializeRequest(body: unknown): boolean {
  const messages = Array.isArray(body) ? body : [body]
  return messages.some((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return false
    return (message as { method?: unknown }).method === "initialize"
  })
}

async function createSessionTransport(): Promise<StreamableHTTPServerTransport> {
  const server = createMcpServer()
  let transport: StreamableHTTPServerTransport
  transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, { server, transport })
    },
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId)
    },
  })
  transport.onclose = () => {
    const sessionId = transport.sessionId
    if (sessionId) sessions.delete(sessionId)
  }
  await server.connect(transport)
  return transport
}

function createMcpServer(): Server {
  const server = new Server(
    { name: "llm-wiki", version: VERSION },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "llm_wiki_status",
        description: "Check whether the LLM Wiki desktop local API is reachable and list the current project.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "llm_wiki_projects",
        description: "List known LLM Wiki projects. The response includes currentProject when the desktop app has an active project.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      {
        name: "llm_wiki_files",
        description: "List files from a project using the desktop app's API permissions. project_id may be a UUID, filesystem path, or 'current'.",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
            root: { type: "string", enum: ["wiki", "sources", "all"], description: "Tree root to list. Defaults to wiki." },
            recursive: { type: "boolean", description: "Whether to list recursively. Defaults to true." },
            max_files: { type: "number", description: "Maximum files returned by the local API. Max 10000." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "llm_wiki_read_file",
        description: "Read a text file from a project through the desktop app API. Only public project paths such as wiki/ and raw/sources/ are allowed by the API.",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
            path: { type: "string", description: "Project-relative file path, for example wiki/index.md." },
          },
          required: ["path"],
          additionalProperties: false,
        },
      },
      {
        name: "llm_wiki_search",
        description: "Search a project using the same backend keyword/vector retrieval used by the desktop API.",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
            query: { type: "string", description: "Search query." },
            top_k: { type: "number", description: "Maximum results. The local API clamps to its configured maximum." },
            include_content: { type: "boolean", description: "Include full page content in results when supported by the API." },
          },
          required: ["query"],
          additionalProperties: false,
        },
      },
      {
        name: "llm_wiki_graph",
        description: "Query the project knowledge graph through the desktop app API.",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
            q: { type: "string", description: "Optional text filter." },
            node_type: { type: "string", description: "Optional node type filter." },
            limit: { type: "number", description: "Maximum nodes. The local API clamps to its configured maximum." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "llm_wiki_rescan_sources",
        description: "Trigger the desktop app's source folder rescan for a project, using the user's Source Watch rules.",
        inputSchema: {
          type: "object",
          properties: {
            project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          },
          additionalProperties: false,
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = asObject(request.params.arguments ?? {})
    try {
      switch (request.params.name) {
        case "llm_wiki_status": {
          const [health, projects] = await Promise.all([
            client.health(),
            client.projects().catch(() => ({ projects: [], currentProject: null })),
          ])
          return textResult(JSON.stringify({ ...health, ...projects }, null, 2))
        }
        case "llm_wiki_projects": {
          await assertMcpEnabled()
          return textResult(JSON.stringify(await client.projects(), null, 2))
        }
        case "llm_wiki_files": {
          await assertMcpEnabled()
          const response = await client.files(projectId(args), {
            root: enumArg(args.root, ["wiki", "sources", "all"] as const, "wiki"),
            recursive: boolArg(args.recursive, true),
            maxFiles: numberArg(args.max_files),
          })
          return textResult(formatFileTree(response.files, response.truncated))
        }
        case "llm_wiki_read_file": {
          await assertMcpEnabled()
          const relPath = stringArg(args.path, "path")
          const { path, content } = await client.fileContent(projectId(args), relPath)
          return textResult(`# ${path}\n\n${truncateText(content, MAX_TEXT_BYTES)}`)
        }
        case "llm_wiki_search": {
          await assertMcpEnabled()
          const query = stringArg(args.query, "query")
          const search = await client.search(projectId(args), query, {
            topK: numberArg(args.top_k),
            includeContent: boolArg(args.include_content, false),
          })
          return textResult(formatSearchResults(query, search))
        }
        case "llm_wiki_graph": {
          await assertMcpEnabled()
          const graph = await client.graph(projectId(args), {
            q: optionalStringArg(args.q),
            nodeType: optionalStringArg(args.node_type),
            limit: numberArg(args.limit),
          })
          return textResult(formatGraph(graph.nodes, graph.edges))
        }
        case "llm_wiki_rescan_sources": {
          await assertMcpEnabled()
          return textResult(JSON.stringify(await client.rescan(projectId(args)), null, 2))
        }
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`)
      }
    } catch (err) {
      if (err instanceof McpError) throw err
      throw new McpError(
        ErrorCode.InternalError,
        err instanceof Error ? err.message : String(err),
      )
    }
  })

  return server
}
