// Local stdio MCP server that bots load as `fyso-biz` (extensions/biz/mcp.json).
// It relays JSON-RPC to Fyso Biz with this project's current credential (the
// OAuth grant, refreshed as needed, or the personal token) and exposes only the
// tools in ALLOWED. Biz has no per-tool scopes: the same grant could otherwise
// approve palancas or accept deliveries, which are human decisions.
const biz = require('./biz.cjs');

/**
 * The only Biz tools bots may see or call. Everything else is hidden from
 * tools/list and refused on tools/call. Add a tool here only when it reads, or
 * when it is part of the agent work cycle on a request (ADR 0104/0110/0116).
 */
const ALLOWED = new Set([
  // Reads.
  'contexto', 'buscar_contexto', 'como_trabajar_en_fyso', 'explicar_kpi', 'obtener_alineacion', 'vision_objetivo',
  'listar_objetivos', 'listar_solicitudes', 'listar_checkins', 'listar_historial_kpi', 'listar_equipos',
  'ver_solicitud', 'ver_entrega', 'ver_nota',
  // Agent work cycle: pull, take, report, prove, close.
  'solicitudes_disponibles', 'tomar_solicitud', 'soltar_solicitud', 'registrar_avance', 'subir_evidencia',
  'cerrar_solicitud', 'crear_nota',
]);
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
// JSON-RPC: method not found, invalid params, internal error.
const NOT_FOUND = -32601, INVALID = -32602, INTERNAL = -32603;

/** Relay to Biz, rebuilding the client when the credential changes; retry once after a 401. */
function upstream({env = process.env, credential = () => biz.token(env), connect = (origin, c) => biz.client(origin, c.token, fetch, {oauth: c.oauth})} = {}) {
  let current = null;
  async function open() {
    const c = await credential();
    if (current?.token !== c.token) {
      const mcp = connect(env.FYSO_BIZ_URL || '', c);
      const entry = current = {token: c.token, ready: mcp.initialize().then(() => mcp)};
      entry.ready.catch(() => { if (current === entry) current = null; });
    }
    return current.ready;
  }
  return async (method, params) => {
    try { return await (await open()).request(method, params); } catch (error) {
      if (error.message !== 'access_denied') throw error;
      // A revoked or rotated access token: Biz rejected it before running anything.
      current = null;
      return (await open()).request(method, params);
    }
  };
}

async function listTools(relay, params) {
  const result = await relay('tools/list', params || {});
  return {...result, tools: (Array.isArray(result.tools) ? result.tools : []).filter(tool => ALLOWED.has(tool?.name))};
}

/** Handle one JSON-RPC message; returns the response, or null for notifications. */
async function handle(message, relay) {
  const {id, method, params} = message || {};
  if (id === undefined || id === null) return null;
  const reply = result => ({jsonrpc: '2.0', id, result});
  const fail = (code, text, data) => ({jsonrpc: '2.0', id, error: {code, message: text, ...(data && {data})}});
  try {
    if (method === 'initialize') {
      const asked = params?.protocolVersion;
      return reply({protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0], capabilities: {tools: {}},
        serverInfo: {name: 'fyso-biz', version: '0.3.0'},
        instructions: 'Fyso Business, under this project\'s agent identity. Read tools and the request work cycle only.'});
    }
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply(await listTools(relay, params?.cursor ? {cursor: params.cursor} : {}));
    if (method === 'tools/call') {
      const name = params?.name;
      if (typeof name !== 'string' || !ALLOWED.has(name)) {
        return fail(INVALID, `Tool not available to project bots: ${String(name).slice(0, 100)}. This proxy allows only reads and the request work cycle; decisions stay with a person in Fyso Business.`);
      }
      return reply(await relay('tools/call', {name, arguments: params.arguments || {}}));
    }
    return fail(NOT_FOUND, `Method not supported: ${String(method).slice(0, 100)}`);
  } catch (error) {
    if (error.rpc) return {jsonrpc: '2.0', id, error: error.rpc};
    const code = biz.ERRORS.includes(error.message) ? error.message : 'connection_failed';
    return fail(INTERNAL, `Fyso Biz: ${code}`);
  }
}

/** Newline-delimited JSON-RPC over stdio (the MCP stdio transport). */
function serve({input = process.stdin, output = process.stdout, relay = upstream()} = {}) {
  let buffer = '';
  const write = message => message && output.write(`${JSON.stringify(message)}\n`);
  input.setEncoding('utf8');
  input.on('data', chunk => {
    buffer += chunk;
    let line;
    while ((line = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, line).trim(); buffer = buffer.slice(line + 1);
      if (!text) continue;
      let message;
      try { message = JSON.parse(text); } catch { write({jsonrpc: '2.0', id: null, error: {code: -32700, message: 'Parse error'}}); continue; }
      handle(message, relay).then(write, () => {});
    }
  });
}

module.exports = {ALLOWED, handle, listTools, upstream, serve};
if (require.main === module) serve();
