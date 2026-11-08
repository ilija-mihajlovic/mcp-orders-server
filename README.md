# MCP Orders Server

This is a small, hand written Model Context Protocol server for a fictional bookstore. It shows what a custom MCP server for a company's own data can look like. It uses plain Node.js and has no runtime dependencies.

## Run it

```sh
node server.js
```

Open [http://127.0.0.1:8787](http://127.0.0.1:8787) for the browser inspector. The server accepts MCP JSON RPC requests at `http://127.0.0.1:8787/mcp` and exposes the audit log at `http://127.0.0.1:8787/audit`. Set `PORT` to use another port. It binds to `127.0.0.1` by default.

The inspector has tabs for tools, resources, prompts, and the audit log. It displays raw request and response traffic, supports copying that traffic, and its guided demo runs real calls against the running server.

## Tools

| Tool | What it does | Arguments |
| --- | --- | --- |
| `list_orders` | Lists orders, with optional filtering | `status`, `limit` |
| `get_order` | Gets one order by id | `id` |
| `order_stats` | Counts orders and totals revenue | none |
| `update_order_status` | Changes an allowed status in memory | `id`, `status` |
| `search_orders` | Searches customer names and item titles | `query`, `limit` |
| `draft_customer_reply` | Creates a fixed template draft and never sends it | `id`, `tone` |

Order status changes follow a small workflow. Processing orders may become shipped or cancelled. Shipped orders may become delivered. Delivered and cancelled orders cannot change.

## Resources and prompts

`resources/list` exposes `orders://summary`, which contains JSON counts, order count, and revenue. `resources/templates/list` exposes `orders://order/{id}`. `resources/read` reads either resource form.

`prompts/list` exposes `weekly_orders_report` and `investigate_order`. The latter accepts the required `order_id` argument. Both return user messages with text content.

The initialize response advertises `tools`, `resources`, and `prompts` capabilities.

## Security and limits

The server is open on localhost when `API_TOKEN` is not set. If it is set, every `/mcp` request needs `Authorization: Bearer <API_TOKEN>`. Token comparison uses a constant time comparison after hashing both values to equal length.

`RATE_LIMIT_PER_MINUTE` configures a simple in memory sliding window per client IP. It defaults to 60 and returns HTTP 429 when the limit is reached. The limit and audit data reset when the process stops. The audit ring buffer keeps the newest 200 tool calls and records time, tool name, argument keys, and success state. It never records argument values.

The inspector is intended for local use. It accepts only local browser origins for `/mcp`, limits request bodies to 100 kB, and does not provide persistence or an SSE transport. For production use, use the official MCP SDK where appropriate, add deployment specific authentication, review transport and validation needs, and decide exactly which data may be exposed.

## Sample data

The twelve orders in `data/orders.json` are fictional sample data. The server loads them at startup and status changes last only until the process stops. It does not write to the JSON file.

## What you get with this service

* Tools wired to your API or database
* Authentication and safe transport configuration
* Input validation and predictable error handling
* Tests for the protocol and business rules
* Deployment notes for your environment
* Documentation and a clear handover package

The plan is four steps. First map the data and actions your assistant needs. Then build the MCP surface around your existing systems. Next verify authentication, validation, edge cases, and observability. Finally document deployment and hand over the working integration.

This page is a minimal hand written demo. A real service uses the official MCP SDK where it is the right fit, together with your system's authentication, deployment, and data requirements.

## Tests

```sh
node --test
```

The test suite covers 43 protocol and HTTP cases including authentication, rate limiting, resources, resource templates, prompts, search, reply drafting, audit behavior, status transitions, validation errors, and a real HTTP smoke test.
