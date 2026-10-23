// Probe the running DBX MCP bridge (streamable HTTP) and print raw tool output.
// Usage: node scripts/probe-mcp-bridge.mjs <tool> [json-args]

const port = 65244
const url = `http://127.0.0.1:${port}/mcp`

let sessionId = null

async function rpc(method, params) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  })
  const sid = response.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await response.text()
  return { status: response.status, text }
}

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'probe', version: '0.0.1' },
})
console.error('initialize status', init.status)
const sid = sessionId
if (sid) {
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
}

const tool = process.argv[2] ?? 'dbx_list_connections'
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {}
const result = await rpc('tools/call', { name: tool, arguments: args })
console.log(result.text)
