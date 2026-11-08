import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { handleRequest, getAuditLog, resetOrdersForTests } from "../mcp.js"

const call = (method, params, id = 1) => handleRequest({ jsonrpc: "2.0", id, method, params })
const tool = (name, args, id = 1) => call("tools/call", { name, arguments: args }, id)
const value = response => JSON.parse(response.result.content[0].text)
const jsonRequest = (url, body, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

test.beforeEach(() => resetOrdersForTests())

test("initialize echoes supported protocol version", () => assert.equal(call("initialize", { protocolVersion: "2025-03-26" }).result.protocolVersion, "2025-03-26"))
test("initialize falls back for unknown protocol version", () => assert.equal(call("initialize", { protocolVersion: "1.0" }).result.protocolVersion, "2025-06-18"))
test("initialize advertises tools resources and prompts", () => assert.deepEqual(call("initialize", { protocolVersion: "2025-06-18" }).result.capabilities, { tools: {}, resources: {}, prompts: {} }))
test("initialized notification returns null", () => assert.equal(handleRequest({ jsonrpc: "2.0", method: "notifications/initialized" }), null))
test("ping returns empty result", () => assert.deepEqual(call("ping").result, {}))
test("tools list returns six schemas", () => assert.equal(call("tools/list").result.tools.length, 6))
test("tool schemas require expected fields", () => { const tools = call("tools/list").result.tools; assert.deepEqual(tools.find(t => t.name === "get_order").inputSchema.required, ["id"]); assert.deepEqual(tools.find(t => t.name === "search_orders").inputSchema.required, ["query"]); assert.deepEqual(tools.find(t => t.name === "draft_customer_reply").inputSchema.properties.tone.enum, ["friendly", "formal"]) })
test("list orders returns twelve records", () => assert.equal(value(tool("list_orders", {})).length, 12))
test("list orders filters and limits", () => assert.equal(value(tool("list_orders", { status: "processing", limit: 2 })).length, 2))
test("get order returns a matching order", () => assert.equal(value(tool("get_order", { id: "ord-1001" })).customer, "Ana Kovac"))
test("get order reports unknown id as tool error", () => { const response = tool("get_order", { id: "missing" }); assert.equal(response.result.isError, true); assert.equal(value(response).error, "unknown_order_id") })
test("order stats counts statuses and revenue", () => { const stats = value(tool("order_stats", {})); assert.deepEqual(stats.counts, { processing: 4, shipped: 2, delivered: 4, cancelled: 2 }); assert.equal(stats.totalRevenue, 400.25) })
test("search orders matches customer names", () => assert.equal(value(tool("search_orders", { query: "ana" }))[0].id, "ord-1001"))
test("search orders matches item titles and limits", () => { const results = value(tool("search_orders", { query: "the", limit: 2 })); assert.equal(results.length, 2); assert.ok(results.some(order => order.id === "ord-1001")) })
test("search orders rejects an empty query", () => assert.equal(value(tool("search_orders", { query: " " })).error, "invalid_arguments"))
test("friendly draft is plain template text", () => { const response = tool("draft_customer_reply", { id: "ord-1001", tone: "friendly" }); assert.equal(response.result.isError, undefined); assert.match(response.result.content[0].text, /^Hi Ana Kovac/) })
test("formal draft is plain template text", () => assert.match(tool("draft_customer_reply", { id: "ord-1001", tone: "formal" }).result.content[0].text, /^Dear Ana Kovac/))
test("draft reply never sends and unknown id is a tool error", () => assert.equal(tool("draft_customer_reply", { id: "missing", tone: "friendly" }).result.isError, true))
test("processing can become shipped", () => assert.equal(value(tool("update_order_status", { id: "ord-1003", status: "shipped" })).status, "shipped"))
test("processing can become cancelled", () => assert.equal(value(tool("update_order_status", { id: "ord-1006", status: "cancelled" })).status, "cancelled"))
test("shipped can become delivered", () => assert.equal(value(tool("update_order_status", { id: "ord-1002", status: "delivered" })).status, "delivered"))
test("delivered cannot change", () => assert.equal(tool("update_order_status", { id: "ord-1001", status: "shipped" }).result.isError, true))
test("cancelled cannot change", () => assert.equal(tool("update_order_status", { id: "ord-1004", status: "processing" }).result.isError, true))
test("invalid tool arguments return a tool error", () => { const response = call("tools/call", { name: "list_orders", arguments: { limit: 0 } }); assert.equal(response.result.isError, true); assert.equal(value(response).error, "invalid_arguments") })
test("unknown tool returns invalid params", () => assert.equal(call("tools/call", { name: "nope", arguments: {} }).error.code, -32602))
test("unknown method returns method not found", () => assert.equal(call("nope").error.code, -32601))
test("invalid request returns invalid request", () => assert.equal(handleRequest({ method: "ping" }).error.code, -32600))
test("resources list includes summary", () => assert.equal(call("resources/list").result.resources[0].uri, "orders://summary"))
test("resource templates list includes order template", () => assert.equal(call("resources/templates/list").result.resourceTemplates[0].uriTemplate, "orders://order/{id}"))
test("resources read summary returns JSON stats", () => { const response = call("resources/read", { uri: "orders://summary" }); const summary = JSON.parse(response.result.contents[0].text); assert.equal(summary.totalOrders, 12); assert.equal(summary.totalRevenue, 400.25) })
test("resources read order template returns an order", () => assert.equal(JSON.parse(call("resources/read", { uri: "orders://order/ord-1002" }).result.contents[0].text).customer, "Marko Jovanovic"))
test("resources read missing resource returns protocol error", () => assert.equal(call("resources/read", { uri: "orders://order/missing" }).error.code, -32002))
test("prompts list returns two prompts", () => assert.deepEqual(call("prompts/list").result.prompts.map(prompt => prompt.name), ["weekly_orders_report", "investigate_order"]))
test("weekly prompt returns user text", () => { const message = call("prompts/get", { name: "weekly_orders_report" }).result.messages[0]; assert.equal(message.role, "user"); assert.equal(message.content.type, "text") })
test("investigate prompt includes order id", () => assert.match(call("prompts/get", { name: "investigate_order", arguments: { order_id: "ord-1002" } }).result.messages[0].content.text, /ord-1002/))
test("investigate prompt requires order id", () => assert.equal(call("prompts/get", { name: "investigate_order", arguments: {} }).error.code, -32602))
test("tools calls append an audit entry with argument keys", () => { tool("search_orders", { query: "dune", limit: 1 }); const entry = getAuditLog()[0]; assert.deepEqual(entry.argumentKeys, ["query", "limit"]); assert.equal(entry.tool, "search_orders"); assert.equal(entry.ok, true); assert.ok(entry.time) })
test("audit records tool errors", () => { tool("get_order", { id: "missing" }); assert.equal(getAuditLog()[0].ok, false) })
test("audit log keeps a ring buffer of 200", () => { for (let index = 0; index < 205; index += 1) tool("order_stats", {}); assert.equal(getAuditLog().length, 200) })

async function startServer(env = {}) {
  const child = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: "0", ...env }, stdio: ["ignore", "pipe", "inherit"] })
  const address = await new Promise((resolve, reject) => { child.stdout.once("data", data => resolve(data.toString().match(/http:\/\/([^\n]+)/)[1])); child.once("error", reject) })
  return { child, base: `http://${address}` }
}
async function stopServer(child) { child.kill(); await new Promise(resolve => child.once("exit", resolve)) }

test("real HTTP smoke test serves MCP", async () => { const { child, base } = await startServer(); try { const response = await jsonRequest(`${base}/mcp`, { jsonrpc: "2.0", id: 7, method: "ping" }); assert.equal(response.status, 200); assert.deepEqual((await response.json()).result, {}) } finally { await stopServer(child) } })
test("HTTP bearer auth rejects missing and accepts correct token", async () => { const { child, base } = await startServer({ API_TOKEN: "demo-token" }); try { assert.equal((await jsonRequest(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401); assert.equal((await jsonRequest(`${base}/mcp`, { jsonrpc: "2.0", id: 2, method: "ping" }, { authorization: "Bearer demo-token" })).status, 200) } finally { await stopServer(child) } })
test("HTTP rate limit returns 429", async () => { const { child, base } = await startServer({ RATE_LIMIT_PER_MINUTE: "2" }); try { const statuses = []; for (let index = 0; index < 3; index += 1) statuses.push((await jsonRequest(`${base}/mcp`, { jsonrpc: "2.0", id: index, method: "ping" })).status); assert.deepEqual(statuses, [200, 200, 429]) } finally { await stopServer(child) } })
test("HTTP audit endpoint exposes tool calls", async () => { const { child, base } = await startServer(); try { await jsonRequest(`${base}/mcp`, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "order_stats", arguments: {} } }); const response = await fetch(`${base}/audit`); assert.equal(response.status, 200); assert.equal((await response.json()).entries[0].tool, "order_stats") } finally { await stopServer(child) } })
