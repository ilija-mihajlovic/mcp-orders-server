import { createServer } from "node:http"
import { readFile, stat } from "node:fs/promises"
import { createHash, timingSafeEqual } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { getAuditLog, handleRequest } from "./mcp.js"

const root = path.dirname(fileURLToPath(import.meta.url))
const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || "127.0.0.1"
const maxBodySize = 100 * 1024
const rateLimit = Math.max(1, Number(process.env.RATE_LIMIT_PER_MINUTE || 60))
const requestWindows = new Map()

function isAllowedOrigin(origin, activeServer) {
  if (!origin) return true
  try { const url = new URL(origin); const address = activeServer.address(); const actualPort = address && typeof address === "object" ? address.port : port; return url.protocol === "http:" && [`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`].includes(origin) } catch { return false }
}
function sendJson(response, status, body) { response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(body === null ? "" : JSON.stringify(body)) }
async function readBody(request) { let size = 0; const chunks = []; for await (const chunk of request) { size += chunk.length; if (size > maxBodySize) throw new Error("body_too_large"); chunks.push(chunk) } return Buffer.concat(chunks).toString("utf8") }
function authorized(request) { const expected = process.env.API_TOKEN; if (!expected) return true; const supplied = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : ""; const expectedHash = createHash("sha256").update(expected).digest(); const suppliedHash = createHash("sha256").update(supplied).digest(); return timingSafeEqual(expectedHash, suppliedHash) }
function withinRateLimit(request) { const ip = request.socket.remoteAddress || "unknown"; const now = Date.now(); const recent = (requestWindows.get(ip) || []).filter(time => now - time < 60_000); if (recent.length >= rateLimit) { requestWindows.set(ip, recent); return false } recent.push(now); requestWindows.set(ip, recent); return true }
async function serveStatic(request, response) { const requested = request.url === "/" ? "/index.html" : request.url; const file = path.normalize(path.join(root, requested)); if (!file.startsWith(root)) return sendJson(response, 404, { error: "Not found" }); try { const info = await stat(file); if (!info.isFile()) throw new Error("not_file"); const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }; response.writeHead(200, { "content-type": `${types[path.extname(file)] || "application/octet-stream"}; charset=utf-8` }); response.end(await readFile(file)) } catch { sendJson(response, 404, { error: "Not found" }) } }

export const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/audit") return sendJson(response, 200, { entries: getAuditLog() })
  if (request.method === "POST" && request.url === "/mcp") {
    if (!withinRateLimit(request)) return sendJson(response, 429, { error: "Rate limit exceeded", retryAfterSeconds: 60 })
    if (!authorized(request)) return sendJson(response, 401, { error: "Unauthorized" })
    if (!isAllowedOrigin(request.headers.origin, server)) return sendJson(response, 403, { error: "Origin not allowed" })
    response.setHeader("access-control-allow-origin", request.headers.origin || `http://${host}:${port}`)
    response.setHeader("vary", "Origin")
    try { const body = await readBody(request); let message; try { message = JSON.parse(body) } catch { return sendJson(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) }; const responseBody = handleRequest(message); if (responseBody === null) return sendJson(response, 202, null); return sendJson(response, 200, responseBody) } catch (error) { if (error.message === "body_too_large") return sendJson(response, 413, { error: "Request body exceeds 100 kB" }); return sendJson(response, 400, { error: "Bad request" }) }
  }
  if (request.method === "GET") return serveStatic(request, response)
  sendJson(response, 405, { error: "Method not allowed" })
})

if (process.argv[1] === fileURLToPath(import.meta.url)) server.listen(port, host, () => { const address = server.address(); console.log(`MCP Orders Server listening at http://${host}:${address.port}`) })
