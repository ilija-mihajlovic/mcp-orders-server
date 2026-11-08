import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const ordersPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "orders.json")
const initialOrders = JSON.parse(readFileSync(ordersPath, "utf8"))
const orders = structuredClone(initialOrders)
const auditLog = []
const statuses = ["processing", "shipped", "delivered", "cancelled"]
const protocolVersions = ["2025-06-18", "2025-03-26"]
const tones = ["friendly", "formal"]

const toolDefinitions = [
  { name: "list_orders", description: "List bookstore orders, optionally filtered by status and limited in size.", inputSchema: { type: "object", properties: { status: { type: "string", enum: statuses }, limit: { type: "integer", minimum: 1, maximum: 50 } }, additionalProperties: false } },
  { name: "get_order", description: "Get one bookstore order by its id.", inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 } }, required: ["id"], additionalProperties: false } },
  { name: "order_stats", description: "Return order counts grouped by status and total revenue.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "update_order_status", description: "Update an order status in memory when the transition is allowed.", inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, status: { type: "string", enum: statuses } }, required: ["id", "status"], additionalProperties: false } },
  { name: "search_orders", description: "Search customer names and item titles, with a bounded result limit.", inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["query"], additionalProperties: false } },
  { name: "draft_customer_reply", description: "Draft a customer reply from a fixed template. This never sends a message.", inputSchema: { type: "object", properties: { id: { type: "string", minLength: 1 }, tone: { type: "string", enum: tones } }, required: ["id", "tone"], additionalProperties: false } }
]
const promptDefinitions = [
  { name: "weekly_orders_report", description: "Ask for a concise weekly order performance report.", arguments: [] },
  { name: "investigate_order", description: "Ask an assistant to investigate one order.", arguments: [{ name: "order_id", description: "The order to investigate.", required: true }] }
]
const resourceDefinitions = [{ uri: "orders://summary", name: "Order summary", description: "Live JSON order counts and revenue.", mimeType: "application/json" }]
const resourceTemplateDefinitions = [{ uriTemplate: "orders://order/{id}", name: "Order by id", description: "A live JSON resource for one order.", mimeType: "application/json" }]

function rpcError(id, code, message, data) { const error = { code, message }; if (data !== undefined) error.data = data; return { jsonrpc: "2.0", id: id ?? null, error } }
function result(id, value) { return { jsonrpc: "2.0", id, result: value } }
function textResult(value, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) } }
function orderError(id) { return textResult({ error: "unknown_order_id", id, message: `No order exists with id ${id}` }, true) }

function validateArgs(toolName, args = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "Arguments must be a JSON object"
  const allowed = { list_orders: ["status", "limit"], get_order: ["id"], order_stats: [], update_order_status: ["id", "status"], search_orders: ["query", "limit"], draft_customer_reply: ["id", "tone"] }[toolName] || []
  for (const key of Object.keys(args)) if (!allowed.includes(key)) return `Unknown argument: ${key}`
  if (toolName === "list_orders" && args.status !== undefined && (typeof args.status !== "string" || !statuses.includes(args.status))) return "status must be one of processing, shipped, delivered, cancelled"
  if (["list_orders", "search_orders"].includes(toolName) && args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) return "limit must be an integer from 1 to 50"
  if (["get_order", "update_order_status", "draft_customer_reply"].includes(toolName) && (typeof args.id !== "string" || args.id.length === 0)) return "id must be a non-empty string"
  if (toolName === "update_order_status" && (typeof args.status !== "string" || !statuses.includes(args.status))) return "status must be one of processing, shipped, delivered, cancelled"
  if (toolName === "search_orders" && (typeof args.query !== "string" || args.query.trim().length === 0)) return "query must be a non-empty string"
  if (toolName === "draft_customer_reply" && (typeof args.tone !== "string" || !tones.includes(args.tone))) return "tone must be friendly or formal"
  return null
}
function summary() { const counts = Object.fromEntries(statuses.map(status => [status, 0])); for (const order of orders) counts[order.status] += 1; return { counts, totalOrders: orders.length, totalRevenue: Number(orders.reduce((sum, order) => sum + order.total, 0).toFixed(2)) } }
function audit(tool, args, ok) { auditLog.push({ time: new Date().toISOString(), tool, argumentKeys: Object.keys(args && typeof args === "object" && !Array.isArray(args) ? args : {}), ok }); if (auditLog.length > 200) auditLog.splice(0, auditLog.length - 200) }

function callTool(name, args = {}) {
  const validation = validateArgs(name, args)
  if (validation) return textResult({ error: "invalid_arguments", message: validation }, true)
  if (name === "list_orders") return textResult(orders.filter(order => !args.status || order.status === args.status).slice(0, args.limit || 50))
  if (name === "get_order") { const order = orders.find(item => item.id === args.id); return order ? textResult(order) : orderError(args.id) }
  if (name === "order_stats") return textResult(summary())
  if (name === "search_orders") { const query = args.query.trim().toLocaleLowerCase(); const matches = orders.filter(order => order.customer.toLocaleLowerCase().includes(query) || order.items.some(item => item.title.toLocaleLowerCase().includes(query))); return textResult(matches.slice(0, args.limit || 50)) }
  if (name === "draft_customer_reply") { const order = orders.find(item => item.id === args.id); if (!order) return orderError(args.id); const itemNames = order.items.map(item => item.title).join(", "); const text = args.tone === "friendly" ? `Hi ${order.customer}, thanks for getting in touch about order ${order.id}. We are checking your order for ${itemNames}, which is currently ${order.status}. We will keep you updated.` : `Dear ${order.customer}, your order ${order.id} containing ${itemNames} is currently ${order.status}. We are reviewing it and will provide an update shortly.`; return { content: [{ type: "text", text }] } }
  if (name === "update_order_status") { const order = orders.find(item => item.id === args.id); if (!order) return orderError(args.id); const allowed = { processing: ["shipped", "cancelled"], shipped: ["delivered"], delivered: [], cancelled: [] }; if (!allowed[order.status].includes(args.status)) return textResult({ error: "invalid_transition", from: order.status, to: args.status, message: `Cannot change an order from ${order.status} to ${args.status}` }, true); order.status = args.status; return textResult(order) }
  return null
}
function resourceRead(uri) { if (uri === "orders://summary") return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(summary()) }] }; const match = /^orders:\/\/order\/(.+)$/.exec(uri || ""); if (match) { const order = orders.find(item => item.id === decodeURIComponent(match[1])); if (order) return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(order) }] } } return null }
function promptGet(name, args = {}) {
  if (name === "weekly_orders_report") return { description: "Weekly order report request", messages: [{ role: "user", content: { type: "text", text: "Prepare a concise weekly report using the current order summary. Include counts by status, total revenue, and notable follow up items." } }] }
  if (name === "investigate_order") {
    if (typeof args.order_id !== "string" || args.order_id.length === 0) return { error: "order_id is required" }
    return { description: "Order investigation request", messages: [{ role: "user", content: { type: "text", text: `Investigate order ${args.order_id}. Check its status, customer, items, total, and created date, then summarize any useful follow up.` } }] }
  }
  return null
}

export function handleRequest(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return rpcError(null, -32600, "Invalid Request")
  const id = Object.prototype.hasOwnProperty.call(message, "id") ? message.id : undefined
  const notification = id === undefined
  if (message.method === "notifications/initialized") return null
  if (message.method === "initialize") { if (!message.params || typeof message.params !== "object" || typeof message.params.protocolVersion !== "string") return notification ? null : rpcError(id, -32602, "Invalid params"); const protocolVersion = protocolVersions.includes(message.params.protocolVersion) ? message.params.protocolVersion : "2025-06-18"; return notification ? null : result(id, { protocolVersion, capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: "orders-demo", version: "0.2.0" } }) }
  if (message.method === "ping") return notification ? null : result(id, {})
  if (message.method === "tools/list") return notification ? null : result(id, { tools: toolDefinitions })
  if (message.method === "resources/list") return notification ? null : result(id, { resources: resourceDefinitions })
  if (message.method === "resources/templates/list") return notification ? null : result(id, { resourceTemplates: resourceTemplateDefinitions })
  if (message.method === "resources/read") { const value = message.params && resourceRead(message.params.uri); return notification ? null : value ? result(id, value) : rpcError(id, -32002, "Resource not found") }
  if (message.method === "prompts/list") return notification ? null : result(id, { prompts: promptDefinitions })
  if (message.method === "prompts/get") { const value = message.params && promptGet(message.params.name, message.params.arguments); return notification ? null : value && !value.error ? result(id, value) : rpcError(id, -32602, value?.error || "Unknown prompt") }
  if (message.method === "tools/call") { const params = message.params; const toolName = params?.name; const args = params?.arguments; if (typeof toolName === "string") audit(toolName, args, false); if (!params || typeof params !== "object" || typeof toolName !== "string" || (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args)))) return notification ? null : rpcError(id, -32602, "Invalid params"); if (!toolDefinitions.some(tool => tool.name === toolName)) return notification ? null : rpcError(id, -32602, "Unknown tool"); const toolResult = callTool(toolName, args); auditLog[auditLog.length - 1].ok = !toolResult.isError; return notification ? null : result(id, toolResult) }
  return notification ? null : rpcError(id, -32601, "Method not found")
}
export function getAuditLog() { return structuredClone(auditLog) }
export function resetOrdersForTests() { orders.splice(0, orders.length, ...structuredClone(initialOrders)); auditLog.splice(0) }
