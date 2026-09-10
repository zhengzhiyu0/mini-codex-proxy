'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const crypto = require('node:crypto');

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

const FAILOVER_STATUS_CODES = new Set([502, 503, 520, 524]);

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  clearLine: '\x1b[2K',
};

function color(text, code, enabled) {
  return enabled ? `${code}${text}${ANSI.reset}` : text;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
}

function elapsedSeconds(startedAt, endedAt = process.hrtime.bigint()) {
  return Number(endedAt - startedAt) / 1e9;
}

function formatDuration(seconds) {
  return seconds === null || seconds === undefined ? '--' : `${seconds.toFixed(2)}s`;
}

function formatTime(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function cloneHeadersWithoutHopByHop(headers) {
  const connectionTokens = new Set(
    String(headers.connection || '')
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const result = {};

  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lowerName) || connectionTokens.has(lowerName)) {
      continue;
    }
    result[lowerName] = value;
  }

  return result;
}

function normalizeBaseUrl(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Missing ${fieldName}`);
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${fieldName} must use http:// or https://`);
  }

  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

function normalizeModels(models, fieldName) {
  const value = models === undefined ? {} : models;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${fieldName}: expected an object`);
  }
  for (const [alias, target] of Object.entries(value)) {
    if (!alias || typeof target !== 'string' || !target) {
      throw new Error(`Invalid model mapping for ${alias || '<empty>'} in ${fieldName}`);
    }
  }
  return { ...value };
}

const ENDPOINT_NAMES = ['responses', 'messages', 'chat', 'models'];

function normalizeEndpoints(input, fieldName) {
  if (input === undefined) return new Set(ENDPOINT_NAMES);
  // Accepts an array from config.json or a Set when an already-normalized config is re-validated.
  const values = input instanceof Set ? [...input] : input;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`Invalid ${fieldName}: expected a non-empty array`);
  }
  const result = new Set();
  for (const value of values) {
    const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!ENDPOINT_NAMES.includes(name)) {
      throw new Error(`Invalid ${fieldName} entry: ${value}`);
    }
    result.add(name);
  }
  return result;
}

function normalizeAuthStyle(value, fieldName) {
  if (value === undefined) return 'bearer';
  const style = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (style !== 'bearer' && style !== 'x-api-key') {
    throw new Error(`Invalid ${fieldName}: expected "bearer" or "x-api-key"`);
  }
  return style;
}

function normalizeUpstreams(input, fieldPrefix) {
  if (Array.isArray(input.upstreams) && input.upstreams.length > 0) {
    return input.upstreams.map((upstream, index) => {
      if (!upstream || typeof upstream !== 'object') {
        throw new Error(`Invalid ${fieldPrefix}upstreams[${index}]`);
      }
      return {
        name: typeof upstream.name === 'string' && upstream.name.trim()
          ? upstream.name.trim()
          : `upstream-${index + 1}`,
        baseUrl: normalizeBaseUrl(upstream.baseUrl, `${fieldPrefix}upstreams[${index}].baseUrl`),
        apiKey: typeof upstream.apiKey === 'string' ? upstream.apiKey : '',
        authStyle: normalizeAuthStyle(upstream.authStyle, `${fieldPrefix}upstreams[${index}].authStyle`),
        priority: Number.isFinite(upstream.priority) ? upstream.priority : 0,
      };
    }).sort((a, b) => b.priority - a.priority);
  }

  const upstream = input.upstream;
  if (!upstream || typeof upstream !== 'object') {
    throw new Error(`Missing ${fieldPrefix}upstream.baseUrl`);
  }
  return [{
    name: typeof upstream.name === 'string' && upstream.name.trim() ? upstream.name.trim() : 'upstream',
    baseUrl: normalizeBaseUrl(upstream.baseUrl, `${fieldPrefix}upstream.baseUrl`),
    apiKey: typeof upstream.apiKey === 'string' ? upstream.apiKey : '',
    authStyle: normalizeAuthStyle(upstream.authStyle, `${fieldPrefix}upstream.authStyle`),
    priority: 0,
  }];
}

function normalizeGroup(input, name, fieldPrefix) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error(`Invalid ${fieldPrefix.replace(/\.$/, '') || 'group'}`);
  }
  return {
    name,
    upstreams: normalizeUpstreams(input, fieldPrefix),
    models: normalizeModels(input.models, `${fieldPrefix}models`),
    endpoints: normalizeEndpoints(input.endpoints, `${fieldPrefix}endpoints`),
    priority: Number.isFinite(input.priority) ? input.priority : 0,
    injectMappedModels: input.injectMappedModels === true,
    overrideModelList: input.overrideModelList === true,
  };
}

function parseGroupNameList(value) {
  if (typeof value === 'string') {
    return value.split(',').map((item) => item.trim()).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean);
  }
  return [];
}

function resolveGroups(input) {
  if (input.groups === undefined) {
    return {
      groups: { default: normalizeGroup(input, 'default', '') },
      activeGroups: ['default'],
    };
  }

  if (!input.groups || typeof input.groups !== 'object' || Array.isArray(input.groups)) {
    throw new Error('Invalid groups: expected an object');
  }

  const names = Object.keys(input.groups);
  if (names.length === 0) {
    throw new Error('groups must contain at least one group');
  }

  const groups = {};
  for (const name of names) {
    if (!name.trim()) {
      throw new Error('Invalid group name');
    }
    groups[name] = normalizeGroup(input.groups[name], name, `groups.${name}.`);
  }

  const fromEnv = [
    ...parseGroupNameList(process.env.MINI_CODEX_PROXY_GROUPS),
    ...parseGroupNameList(process.env.MINI_CODEX_PROXY_GROUP),
  ];
  let requested;
  if (fromEnv.length > 0) requested = fromEnv;
  else if (input.activeGroups !== undefined) requested = parseGroupNameList(input.activeGroups);
  else if (input.activeGroup !== undefined) requested = parseGroupNameList(input.activeGroup);
  else requested = [names[0]];

  if (requested.length === 1 && requested[0].toLowerCase() === 'all') {
    requested = [...names];
  }

  const activeGroups = [];
  for (const name of requested) {
    if (!Object.prototype.hasOwnProperty.call(groups, name)) {
      throw new Error(`Unknown active group: ${name}`);
    }
    if (!activeGroups.includes(name)) activeGroups.push(name);
  }
  if (activeGroups.length === 0) {
    throw new Error('No active group selected');
  }
  activeGroups.sort((a, b) => groups[b].priority - groups[a].priority);

  return { groups, activeGroups };
}

function buildRouteTable(groups, activeGroups) {
  const routes = new Map();
  for (const name of activeGroups) {
    const group = groups[name];
    for (const [alias, targetModel] of Object.entries(group.models)) {
      let entries = routes.get(alias);
      if (!entries) {
        entries = [];
        routes.set(alias, entries);
      }
      entries.push({ group, targetModel });
    }
  }
  return routes;
}

function expandCandidates(entries) {
  const candidates = [];
  for (const entry of entries) {
    for (const upstream of entry.group.upstreams) {
      candidates.push({ group: entry.group, upstream, targetModel: entry.targetModel });
    }
  }
  return candidates;
}

function resolveRoute(config, endpointName, requestedModel) {
  if (typeof requestedModel === 'string') {
    const separator = requestedModel.indexOf('/');
    if (separator > 0) {
      const groupName = requestedModel.slice(0, separator);
      const alias = requestedModel.slice(separator + 1);
      if (alias && config.activeGroups.includes(groupName)) {
        const group = config.groups[groupName];
        if (!group.endpoints.has(endpointName)) return [];
        const targetModel = Object.prototype.hasOwnProperty.call(group.models, alias)
          ? group.models[alias]
          : alias;
        return expandCandidates([{ group, targetModel }]);
      }
    }

    const entries = config.routes.get(requestedModel);
    if (entries) {
      const usable = entries.filter((entry) => entry.group.endpoints.has(endpointName));
      if (usable.length > 0) return expandCandidates(usable);
    }
  }

  return expandCandidates(config.activeGroups
    .filter((name) => config.groups[name].endpoints.has(endpointName))
    .map((name) => ({ group: config.groups[name], targetModel: requestedModel })));
}

function collectModelAliases(config) {
  const owners = new Map();
  for (const name of config.activeGroups) {
    const group = config.groups[name];
    if (!group.endpoints.has('models')) continue;
    for (const alias of Object.keys(group.models)) {
      let list = owners.get(alias);
      if (!list) {
        list = [];
        owners.set(alias, list);
      }
      list.push(name);
    }
  }

  const ids = [...owners.keys()];
  for (const [alias, list] of owners) {
    if (list.length < 2) continue;
    for (const name of list) ids.push(`${name}/${alias}`);
  }
  return ids;
}

function validateAndNormalizeConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('config.json must contain a JSON object');
  }

  const host = input.host === undefined ? '127.0.0.1' : input.host;
  if (typeof host !== 'string' || !host.trim()) {
    throw new Error('Invalid host');
  }

  const port = input.port === undefined ? 8317 : input.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid port');
  }

  const { groups, activeGroups } = resolveGroups(input);
  const routes = buildRouteTable(groups, activeGroups);

  const connectTimeoutMs = input.timeouts?.connectTimeoutMs === undefined
    ? 30000
    : input.timeouts.connectTimeoutMs;
  if (!Number.isInteger(connectTimeoutMs) || connectTimeoutMs <= 0) {
    throw new Error('Invalid timeouts.connectTimeoutMs');
  }

  const refreshIntervalMs = input.progress?.refreshIntervalMs === undefined
    ? 100
    : input.progress.refreshIntervalMs;
  if (!Number.isInteger(refreshIntervalMs) || refreshIntervalMs < 50 || refreshIntervalMs > 5000) {
    throw new Error('Invalid progress.refreshIntervalMs');
  }

  const requestLogLimit = input.requestLog?.limit === undefined ? 500 : input.requestLog.limit;
  if (!Number.isInteger(requestLogLimit) || requestLogLimit < 1 || requestLogLimit > 100000) {
    throw new Error('Invalid requestLog.limit');
  }

  let requestLogFile = null;
  if (input.requestLog?.enabled !== false) {
    if (input.requestLog?.file === null) {
      requestLogFile = null;
    } else if (input.requestLog?.file !== undefined) {
      if (typeof input.requestLog.file !== 'string' || !input.requestLog.file.trim()) {
        throw new Error('Invalid requestLog.file');
      }
      requestLogFile = path.resolve(__dirname, input.requestLog.file.trim());
    } else {
      requestLogFile = path.resolve(__dirname, 'logs', 'requests.jsonl');
    }
  }

  const config = {
    host: host.trim(),
    port,
    groups,
    activeGroups,
    routes,
    clientApiKey: typeof input.clientApiKey === 'string' ? input.clientApiKey : '',
    forwardClientAuthorization: input.forwardClientAuthorization === true,
    logging: { enabled: input.logging?.enabled !== false },
    progress: {
      enabled: input.progress?.enabled === true,
      color: input.progress?.color !== false,
      refreshIntervalMs,
    },
    monitor: {
      enabled: input.monitor?.enabled !== false,
    },
    requestLog: {
      enabled: input.requestLog?.enabled !== false,
      limit: requestLogLimit,
      file: requestLogFile,
    },
    webui: {
      enabled: input.webui?.enabled !== false,
    },
    debug: input.debug === true,
    timeouts: { connectTimeoutMs },
  };

  const modelsGroups = activeGroups.filter((name) => groups[name].endpoints.has('models'));
  config.modelListIds = collectModelAliases(config);
  config.injectMappedModels = modelsGroups.some((name) => groups[name].injectMappedModels);
  // A single channel may still proxy the upstream catalog. With several channels no single
  // upstream list describes what the proxy serves, so the merged alias list is authoritative.
  config.overrideModelList = modelsGroups.length > 1
    || modelsGroups.some((name) => groups[name].overrideModelList);
  return config;
}

function loadConfig(configPath = path.join(__dirname, 'config.json')) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found: ${configPath}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid config.json: ${error.message}`);
  }
  return validateAndNormalizeConfig(parsed);
}

function endpointForPath(pathname) {
  if (pathname === '/v1/responses' || pathname === '/responses') {
    return { name: 'responses', canonicalPath: '/responses' };
  }
  if (pathname === '/v1/messages' || pathname === '/messages') {
    return { name: 'messages', canonicalPath: '/messages' };
  }
  if (pathname === '/v1/chat/completions' || pathname === '/chat/completions') {
    return { name: 'chat', canonicalPath: '/chat/completions' };
  }
  if (pathname === '/v1/models' || pathname === '/models') {
    return { name: 'models', canonicalPath: '/models' };
  }
  return null;
}

function buildUpstreamUrl(baseUrl, canonicalPath, search) {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${canonicalPath}`.replace(/\/{2,}/g, '/');
  url.search = search;
  return url;
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('aborted', () => reject(new Error('Client aborted the request')));
    request.on('error', reject);
  });
}

function inspectRequestBody(body, contentEncoding) {
  const result = {
    parsed: null,
    rewritable: false,
    requestedModel: undefined,
    stream: false,
  };

  if (body.length === 0 || (contentEncoding && contentEncoding !== 'identity')) {
    return result;
  }

  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return result;
    }

    result.parsed = parsed;
    result.rewritable = true;
    result.stream = parsed.stream === true;
    if (typeof parsed.model === 'string') {
      result.requestedModel = parsed.model;
    }
  } catch {
    // Preserve malformed JSON so the upstream can return its native error response.
  }

  return result;
}

function bodyWithModel(originalBody, info, targetModel) {
  if (!info.rewritable
    || info.requestedModel === undefined
    || typeof targetModel !== 'string'
    || targetModel === info.requestedModel) {
    return originalBody;
  }
  // Spread keeps the original key order; `model` already exists so only its value changes.
  return Buffer.from(JSON.stringify({ ...info.parsed, model: targetModel }));
}

function prepareRequestHeaders(clientHeaders, upstream, config, body, forceIdentityEncoding) {
  const headers = cloneHeadersWithoutHopByHop(clientHeaders);
  delete headers.host;
  delete headers['content-length'];
  delete headers.expect;
  // Client credentials never reach the upstream; each upstream supplies its own below.
  delete headers.authorization;
  delete headers['x-api-key'];

  if (forceIdentityEncoding) {
    headers['accept-encoding'] = 'identity';
  }

  if (!config.clientApiKey && config.forwardClientAuthorization && clientHeaders.authorization) {
    headers.authorization = clientHeaders.authorization;
  } else if (upstream.apiKey) {
    if (upstream.authStyle === 'x-api-key') headers['x-api-key'] = upstream.apiKey;
    else headers.authorization = `Bearer ${upstream.apiKey}`;
  }

  if (body !== null) {
    headers['content-length'] = String(body.length);
  }

  return headers;
}

function extractBearerToken(authorization) {
  if (typeof authorization !== 'string') return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function safeTokenEqual(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualHash = crypto.createHash('sha256').update(actual).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(actualHash, expectedHash);
}

function isClientAuthorized(request, config) {
  if (!config.clientApiKey) return true;
  // Codex / OpenAI clients send Authorization: Bearer <key>;
  // Claude Code / Anthropic clients send x-api-key: <key>.
  const bearer = extractBearerToken(request.headers.authorization);
  if (safeTokenEqual(bearer, config.clientApiKey)) return true;
  const apiKeyHeader = request.headers['x-api-key'];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  return safeTokenEqual(typeof apiKey === 'string' ? apiKey.trim() : apiKey, config.clientApiKey);
}

function prepareResponseHeaders(upstreamHeaders) {
  return cloneHeadersWithoutHopByHop(upstreamHeaders);
}

function sendJson(response, statusCode, value) {
  if (response.headersSent || response.destroyed) {
    return;
  }
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
  });
  response.end(body);
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  return address === '::1'
    || address.startsWith('127.')
    || address.startsWith('::ffff:127.');
}

function serializeMonitorRequest(metrics, now = process.hrtime.bigint()) {
  const endedAt = metrics.endedAt || now;
  const elapsedMs = Math.round(elapsedSeconds(metrics.startedAt, endedAt) * 1000);
  const firstByteMs = metrics.firstByteAt
    ? Math.round(elapsedSeconds(metrics.startedAt, metrics.firstByteAt) * 1000)
    : null;
  const firstOutputTextMs = metrics.firstOutputTextAt
    ? Math.round(elapsedSeconds(metrics.startedAt, metrics.firstOutputTextAt) * 1000)
    : null;
  let state = 'connecting';
  if (metrics.endedAt) state = metrics.status >= 200 && metrics.status < 400 ? 'completed' : 'failed';
  else if (metrics.firstByteAt) state = 'streaming';
  else if (metrics.status) state = 'waiting';

  return {
    id: metrics.id,
    method: metrics.method,
    path: metrics.path,
    model: metrics.originalModel || null,
    mappedModel: metrics.mappedModel || null,
    group: metrics.group || null,
    upstream: metrics.upstream || null,
    status: metrics.status || null,
    usage: metrics.usage || null,
    cacheHitRate: cacheHitRate(metrics.usage),
    state,
    stream: metrics.stream === true,
    requestBytes: metrics.requestBytes,
    responseBytes: metrics.responseBytes,
    firstByteMs,
    firstOutputTextMs,
    elapsedMs,
    completed: metrics.completed === true,
    failed: metrics.failed === true,
  };
}

function createMonitorState(config) {
  const active = new Map();
  const history = [];
  let latest = null;
  const startedAt = Date.now();

  return {
    start(metrics) {
      active.set(metrics.id, metrics);
    },
    finish(metrics) {
      active.delete(metrics.id);
      latest = { ...metrics };
      history.unshift(serializeMonitorRequest(latest));
      if (history.length > 100) history.length = 100;
    },
    snapshot() {
      const now = process.hrtime.bigint();
      const activeRequests = Array.from(active.values()).map((metrics) => (
        serializeMonitorRequest(metrics, now)
      ));
      return {
        service: 'mini-codex-proxy',
        online: true,
        group: config.activeGroups[0],
        activeGroups: [...config.activeGroups],
        groups: Object.keys(config.groups),
        uptimeMs: Date.now() - startedAt,
        activeCount: activeRequests.length,
        activeRequests,
        latest: activeRequests.at(-1)
          || (latest ? serializeMonitorRequest(latest, now) : null),
        history: history.map((item) => ({ ...item })),
      };
    },
  };
}

// Carries both the OpenAI fields (object/created/owned_by) and the Anthropic ones
// (type/display_name/created_at) so a single list satisfies either client's discovery.
function buildModelEntry(alias) {
  return {
    id: alias,
    object: 'model',
    type: 'model',
    created: 0,
    created_at: '1970-01-01T00:00:00Z',
    display_name: alias,
    owned_by: 'mini-codex-proxy',
  };
}

function buildLocalModelList(ids) {
  return {
    object: 'list',
    data: ids.map(buildModelEntry),
    has_more: false,
    first_id: ids.length > 0 ? ids[0] : null,
    last_id: ids.length > 0 ? ids[ids.length - 1] : null,
  };
}

function injectMappedModels(body, headers, ids) {
  const encoding = String(headers['content-encoding'] || '').toLowerCase();
  if (encoding && encoding !== 'identity') {
    return null;
  }

  try {
    const parsed = JSON.parse(body.toString('utf8'));
    if (!parsed || !Array.isArray(parsed.data)) {
      return null;
    }

    const existingIds = new Set(parsed.data.map((item) => item?.id).filter(Boolean));
    for (const alias of ids) {
      if (!existingIds.has(alias)) {
        parsed.data.push(buildModelEntry(alias));
      }
    }
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return null;
  }
}

// Normalizes the three upstream usage shapes into one record.
// OpenAI counts cached tokens INSIDE prompt_tokens/input_tokens; Anthropic reports them
// alongside input_tokens. Both are folded into `promptTokens` (total prompt incl. cache)
// so a single cache-hit ratio is comparable across channels.
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;

  const num = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const openAiCached = num(usage.prompt_tokens_details?.cached_tokens)
    || num(usage.input_tokens_details?.cached_tokens);
  const rawInput = num(usage.prompt_tokens) || num(usage.input_tokens);
  const outputTokens = num(usage.completion_tokens) || num(usage.output_tokens);

  const anthropicStyle = cacheRead > 0 || cacheWrite > 0;
  const promptTokens = anthropicStyle ? rawInput + cacheRead + cacheWrite : rawInput;
  const cacheReadTokens = anthropicStyle ? cacheRead : openAiCached;

  if (promptTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWrite === 0) {
    return null;
  }

  return {
    promptTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: anthropicStyle ? cacheWrite : 0,
  };
}

function usageFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return normalizeUsage(payload.usage)
    || normalizeUsage(payload.response?.usage)
    || normalizeUsage(payload.message?.usage);
}

// Anthropic splits usage across `message_start` (prompt + cache) and `message_delta`
// (output), so fields are merged instead of replaced.
function mergeUsage(target, next) {
  if (!next) return target;
  if (!target) return { ...next };
  for (const key of Object.keys(next)) {
    if (next[key] > 0) target[key] = next[key];
  }
  return target;
}

function cacheHitRate(usage) {
  if (!usage || usage.promptTokens <= 0) return null;
  return usage.cacheReadTokens / usage.promptTokens;
}

const SSE_TEXT_DELTA = /"type"\s*:\s*"(?:response\.output_text\.delta|text_delta)"/;

function createSseObserver() {
  let pending = '';
  const state = {
    completed: false,
    failed: false,
    done: false,
    firstOutputTextAt: null,
    usage: null,
  };

  const scanLine = (line, observedAt) => {
    if (!line) return;
    if (line.startsWith('event:')) {
      const name = line.slice(6).trim();
      if (name === 'message_stop') state.completed = true;
      else if (name === 'error') state.failed = true;
      return;
    }
    if (!line.startsWith('data:')) return;

    const payloadText = line.slice(5).trim();
    if (payloadText === '[DONE]') {
      state.done = true;
      return;
    }
    // Cheap string probes first: parsing every delta frame of a long stream would
    // dominate proxy CPU time for no gain.
    if (state.firstOutputTextAt === null && SSE_TEXT_DELTA.test(payloadText)) {
      state.firstOutputTextAt = observedAt;
    }
    if (payloadText.includes('response.completed')) state.completed = true;
    if (payloadText.includes('response.failed')) state.failed = true;
    if (!payloadText.includes('"usage"') || !payloadText.startsWith('{')) return;

    try {
      state.usage = mergeUsage(state.usage, usageFromPayload(JSON.parse(payloadText)));
    } catch {
      // A truncated frame simply contributes no usage.
    }
  };

  return {
    observe(chunk, observedAt = process.hrtime.bigint()) {
      pending += chunk.toString('utf8');
      let newlineAt = pending.indexOf('\n');
      while (newlineAt !== -1) {
        scanLine(pending.slice(0, newlineAt).trim(), observedAt);
        pending = pending.slice(newlineAt + 1);
        newlineAt = pending.indexOf('\n');
      }
      // Guard against an upstream that never emits a newline.
      if (pending.length > 65536) pending = pending.slice(-1024);
    },
    state,
  };
}

function summarizeUsage(entries) {
  const totals = {
    requests: 0,
    promptTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const entry of entries) {
    if (!entry.usage) continue;
    totals.requests += 1;
    totals.promptTokens += entry.usage.promptTokens;
    totals.outputTokens += entry.usage.outputTokens;
    totals.cacheReadTokens += entry.usage.cacheReadTokens;
    totals.cacheWriteTokens += entry.usage.cacheWriteTokens;
  }
  return {
    ...totals,
    cacheHitRate: totals.promptTokens > 0 ? totals.cacheReadTokens / totals.promptTokens : null,
  };
}

function loadRequestLogFile(file, limit) {
  if (!file) return [];
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    // Missing or unreadable history must not prevent the proxy from starting.
    return [];
  }

  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return [];
    // Read from the end so a multi-month jsonl does not get slurped into RAM.
    const chunkSize = Math.min(size, Math.max(64 * 1024, limit * 2048));
    const buffer = Buffer.alloc(chunkSize);
    fs.readSync(fd, buffer, 0, chunkSize, size - chunkSize);
    const lines = buffer.toString('utf8').split('\n');
    if (size > chunkSize) lines.shift();

    const loaded = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed);
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) loaded.push(entry);
      } catch {
        // Skip a truncated last line from a crash mid-append.
      }
    }
    return loaded.length > limit ? loaded.slice(-limit) : loaded;
  } finally {
    fs.closeSync(fd);
  }
}

function createRequestLog(config) {
  const limit = config.requestLog.limit;
  const file = config.requestLog.file;
  const loaded = loadRequestLogFile(file, limit);
  // File is append-only (oldest first); memory is newest-first for the dashboard.
  const entries = loaded.slice().reverse();
  let sequence = 0;
  for (const entry of loaded) {
    if (Number.isInteger(entry.seq) && entry.seq > sequence) sequence = entry.seq;
  }
  let pendingWrite = null;

  const appendToFile = (entry) => {
    if (!file) return;
    const line = `${JSON.stringify(entry)}\n`;
    pendingWrite = (pendingWrite || Promise.resolve())
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.appendFile(file, line);
      })
      .catch(() => {});
  };

  return {
    record(metrics, extra) {
      if (!config.requestLog.enabled) return null;
      sequence += 1;
      const entry = {
        seq: sequence,
        id: metrics.id,
        at: new Date().toISOString(),
        method: metrics.method,
        path: metrics.path,
        model: metrics.originalModel || null,
        mappedModel: metrics.mappedModel || null,
        group: metrics.group || null,
        upstream: metrics.upstream || null,
        status: metrics.status || null,
        stream: metrics.stream === true,
        requestBytes: metrics.requestBytes || 0,
        responseBytes: metrics.responseBytes || 0,
        durationMs: Math.round(elapsedSeconds(metrics.startedAt, metrics.endedAt) * 1000),
        firstByteMs: metrics.firstByteAt
          ? Math.round(elapsedSeconds(metrics.startedAt, metrics.firstByteAt) * 1000)
          : null,
        attempts: extra.attempts,
        usage: metrics.usage || null,
        cacheHitRate: cacheHitRate(metrics.usage),
        failed: metrics.failed === true,
      };
      entries.unshift(entry);
      if (entries.length > limit) entries.length = limit;
      appendToFile(entry);
      return entry;
    },
    query({ limit: max = 100, group, model, status, cached } = {}) {
      let result = entries;
      if (group) result = result.filter((entry) => entry.group === group);
      if (model) result = result.filter((entry) => entry.model === model || entry.mappedModel === model);
      if (status === 'ok') result = result.filter((entry) => !entry.failed);
      else if (status === 'failed') result = result.filter((entry) => entry.failed);
      if (cached === 'hit') result = result.filter((entry) => (entry.usage?.cacheReadTokens || 0) > 0);
      else if (cached === 'miss') result = result.filter((entry) => entry.usage && !entry.usage.cacheReadTokens);
      return {
        total: entries.length,
        matched: result.length,
        totals: summarizeUsage(result),
        entries: result.slice(0, max),
      };
    },
    stats() {
      const byGroup = {};
      const byModel = {};
      for (const entry of entries) {
        const groupKey = entry.group || 'unknown';
        const modelKey = entry.model || entry.mappedModel || 'unknown';
        (byGroup[groupKey] ||= []).push(entry);
        (byModel[modelKey] ||= []).push(entry);
      }
      const shape = (source) => Object.fromEntries(
        Object.entries(source).map(([key, list]) => [key, {
          requests: list.length,
          failed: list.filter((entry) => entry.failed).length,
          ...summarizeUsage(list),
        }]),
      );
      return {
        overall: { requests: entries.length, ...summarizeUsage(entries) },
        byGroup: shape(byGroup),
        byModel: shape(byModel),
      };
    },
    flush() {
      return pendingWrite || Promise.resolve();
    },
  };
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mini-codex-proxy</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#252a34;--fg:#e6e9ef;--dim:#8b93a5;
--ok:#3fb950;--bad:#f85149;--warm:#d29922;--cool:#58a6ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
header{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;
padding:14px 18px;border-bottom:1px solid var(--line)}
h1{margin:0;font-size:14px;letter-spacing:.5px}
#groups{color:var(--dim)}
#dot{color:var(--bad)}#dot.on{color:var(--ok)}
main{padding:18px;display:grid;gap:18px}
.cards{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.card b{display:block;font-size:11px;color:var(--dim);font-weight:400;text-transform:uppercase;
letter-spacing:.6px;margin-bottom:6px}
.card span{font-size:20px;font-variant-numeric:tabular-nums}
.bar{height:6px;border-radius:3px;background:var(--line);margin-top:8px;overflow:hidden}
.bar i{display:block;height:100%;background:var(--cool)}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
h2{margin:0;padding:10px 14px;font-size:12px;color:var(--dim);font-weight:400;
border-bottom:1px solid var(--line);display:flex;gap:10px;align-items:center}
h2 select{margin-left:auto;background:var(--bg);color:var(--fg);border:1px solid var(--line);
border-radius:5px;padding:3px 6px;font:inherit;font-size:11px}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
th{color:var(--dim);font-weight:400;font-size:11px}
tbody tr:last-child td{border-bottom:0}
td.n{text-align:right}
.s-ok{color:var(--ok)}.s-bad{color:var(--bad)}.s-run{color:var(--warm)}
.hit{color:var(--cool)}.dim{color:var(--dim)}
.wrap{max-height:420px;overflow:auto}
.empty{padding:16px;color:var(--dim)}
</style>
</head>
<body>
<header>
<h1><span id="dot">&#9679;</span> mini-codex-proxy</h1>
<span id="groups">connecting…</span>
<span id="uptime" class="dim"></span>
</header>
<main>
<div class="cards" id="cards"></div>
<section>
<h2>活动请求 <span id="activeCount" class="dim"></span></h2>
<div class="wrap"><table><thead><tr>
<th>ID</th><th>模型</th><th>渠道</th><th>状态</th><th class="n">已用</th><th class="n">首包</th><th class="n">下行</th>
</tr></thead><tbody id="active"></tbody></table></div>
</section>
<section>
<h2>渠道统计
<select id="statsMode"><option value="byGroup">按渠道</option><option value="byModel">按模型</option></select>
</h2>
<div class="wrap"><table><thead><tr>
<th>名称</th><th class="n">请求</th><th class="n">失败</th><th class="n">输入</th><th class="n">输出</th>
<th class="n">缓存读</th><th class="n">命中率</th>
</tr></thead><tbody id="stats"></tbody></table></div>
</section>
<section>
<h2>请求日志
<select id="filter">
<option value="">全部</option>
<option value="cached=hit">仅缓存命中</option>
<option value="cached=miss">仅缓存未命中</option>
<option value="status=failed">仅失败</option>
<option value="status=ok">仅成功</option>
</select>
</h2>
<div class="wrap"><table><thead><tr>
<th>时间</th><th>模型</th><th>渠道</th><th class="n">状态</th><th class="n">耗时</th>
<th class="n">输入</th><th class="n">输出</th><th class="n">缓存读</th><th class="n">命中率</th><th class="n">尝试</th>
</tr></thead><tbody id="log"></tbody></table></div>
</section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const num = (v) => (v == null ? '-' : v.toLocaleString());
const ms = (v) => (v == null ? '-' : v < 1000 ? v + 'ms' : (v / 1000).toFixed(2) + 's');
const bytes = (v) => {
  if (!v) return '0';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0; let n = v;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
  return n.toFixed(i ? 1 : 0) + ' ' + u[i];
};
const pct = (v) => (v == null ? '-' : (v * 100).toFixed(1) + '%');
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

function statusClass(entry) {
  if (entry.failed || (entry.status && entry.status >= 400)) return 's-bad';
  if (!entry.status) return 's-run';
  return 's-ok';
}

function renderCards(stats, status) {
  const o = stats.overall;
  const cards = [
    ['总请求', num(o.requests)],
    ['缓存命中率', pct(o.cacheHitRate), o.cacheHitRate],
    ['缓存读取 tokens', num(o.cacheReadTokens)],
    ['输入 tokens', num(o.promptTokens)],
    ['输出 tokens', num(o.outputTokens)],
    ['进行中', num(status ? status.activeCount : 0)],
  ];
  $('cards').innerHTML = cards.map(([label, value, ratio]) => (
    '<div class="card"><b>' + label + '</b><span>' + value + '</span>'
    + (ratio == null ? '' : '<div class="bar"><i style="width:' + (ratio * 100).toFixed(1) + '%"></i></div>')
    + '</div>'
  )).join('');
}

function renderActive(status) {
  const rows = status.activeRequests || [];
  $('activeCount').textContent = rows.length ? '(' + rows.length + ')' : '';
  $('active').innerHTML = rows.length ? rows.map((r) => '<tr>'
    + '<td class="dim">' + esc(r.id) + '</td>'
    + '<td>' + esc(r.model || r.mappedModel || '-') + '</td>'
    + '<td>' + esc(r.group || '-') + '</td>'
    + '<td class="' + statusClass(r) + '">' + esc(r.state) + '</td>'
    + '<td class="n">' + ms(r.elapsedMs) + '</td>'
    + '<td class="n">' + ms(r.firstByteMs) + '</td>'
    + '<td class="n">' + bytes(r.responseBytes) + '</td>'
    + '</tr>').join('') : '<tr><td colspan="7" class="empty">暂无进行中的请求</td></tr>';
}

function renderStats(stats) {
  const table = stats[$('statsMode').value] || {};
  const rows = Object.entries(table).sort((a, b) => b[1].requests - a[1].requests);
  $('stats').innerHTML = rows.length ? rows.map(([name, s]) => '<tr>'
    + '<td>' + esc(name) + '</td>'
    + '<td class="n">' + num(s.requests) + '</td>'
    + '<td class="n ' + (s.failed ? 's-bad' : 'dim') + '">' + num(s.failed) + '</td>'
    + '<td class="n">' + num(s.promptTokens) + '</td>'
    + '<td class="n">' + num(s.outputTokens) + '</td>'
    + '<td class="n hit">' + num(s.cacheReadTokens) + '</td>'
    + '<td class="n">' + pct(s.cacheHitRate) + '</td>'
    + '</tr>').join('') : '<tr><td colspan="7" class="empty">暂无数据</td></tr>';
}

function renderLog(data) {
  const rows = data.entries || [];
  $('log').innerHTML = rows.length ? rows.map((e) => {
    const u = e.usage || {};
    return '<tr>'
      + '<td class="dim">' + esc(e.at.slice(11, 19)) + '</td>'
      + '<td>' + esc(e.model || e.mappedModel || '-') + '</td>'
      + '<td>' + esc(e.group || '-') + '</td>'
      + '<td class="n ' + statusClass(e) + '">' + esc(e.status || '-') + '</td>'
      + '<td class="n">' + ms(e.durationMs) + '</td>'
      + '<td class="n">' + num(u.promptTokens) + '</td>'
      + '<td class="n">' + num(u.outputTokens) + '</td>'
      + '<td class="n hit">' + num(u.cacheReadTokens) + '</td>'
      + '<td class="n">' + pct(e.cacheHitRate) + '</td>'
      + '<td class="n ' + (e.attempts > 1 ? 's-run' : 'dim') + '">' + num(e.attempts) + '</td>'
      + '</tr>';
  }).join('') : '<tr><td colspan="10" class="empty">暂无请求记录</td></tr>';
}

async function get(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(url + ' -> ' + res.status);
  return res.json();
}

let timer = null;
async function refresh() {
  try {
    const query = $('filter').value;
    const [status, stats, log] = await Promise.all([
      get('/_mini/status').catch(() => null),
      get('/_mini/stats'),
      get('/_mini/requests?limit=200' + (query ? '&' + query : '')),
    ]);
    $('dot').className = 'on';
    if (status) {
      $('groups').textContent = '启用渠道: ' + (status.activeGroups || []).join(', ');
      $('uptime').textContent = '运行 ' + Math.floor(status.uptimeMs / 1000) + 's';
      renderActive(status);
    }
    renderCards(stats, status);
    renderStats(stats);
    renderLog(log);
  } catch (error) {
    $('dot').className = '';
    $('groups').textContent = '连接失败: ' + error.message;
  }
}

for (const id of ['filter', 'statsMode']) $(id).addEventListener('change', refresh);
function loop() {
  clearInterval(timer);
  timer = setInterval(refresh, 2000);
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) clearInterval(timer);
  else { refresh(); loop(); }
});
refresh();
loop();
</script>
</body>
</html>
`;

function renderDashboardHtml() {
  return DASHBOARD_HTML;
}

function defaultLog(line) {
  process.stdout.write(`${line}\n`);
}

function createTerminalProgress(config, options = {}) {
  const output = options.output || process.stdout;
  const isInteractive = config.progress.enabled && (options.isTTY ?? output.isTTY) === true;
  const colorsEnabled = isInteractive && config.progress.color && process.env.NO_COLOR === undefined;
  const active = new Map();
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;
  let timer = null;

  function statusColor(status) {
    if (!status) return ANSI.dim;
    if (status >= 200 && status < 400) return ANSI.green;
    if (status === 429 || status >= 500) return ANSI.yellow;
    return ANSI.red;
  }

  function modelLabel(metrics) {
    if (!metrics.originalModel) return '';
    if (metrics.originalModel === metrics.mappedModel) return metrics.originalModel;
    return `${metrics.originalModel}→${metrics.mappedModel}`;
  }

  function renderLine(metrics, completed = false) {
    const now = metrics.endedAt || process.hrtime.bigint();
    const total = elapsedSeconds(metrics.startedAt, now);
    const firstByte = metrics.firstByteAt
      ? elapsedSeconds(metrics.startedAt, metrics.firstByteAt)
      : null;
    const firstOutput = metrics.firstOutputTextAt
      ? elapsedSeconds(metrics.startedAt, metrics.firstOutputTextAt)
      : null;
    const stateIcon = completed
      ? (metrics.status >= 200 && metrics.status < 400 ? '✓' : '✗')
      : frames[frameIndex % frames.length];
    const iconCode = completed ? statusColor(metrics.status) : ANSI.cyan;
    const parts = [
      color(stateIcon, iconCode, colorsEnabled),
      color(`#${metrics.id}`, ANSI.dim, colorsEnabled),
      color(metrics.method, ANSI.bold, colorsEnabled),
      metrics.path,
    ];
    const model = modelLabel(metrics);
    if (model) parts.push(color(model, ANSI.magenta, colorsEnabled));
    const channel = metrics.group && metrics.group !== metrics.upstream
      ? `${metrics.group}/${metrics.upstream}`
      : metrics.upstream;
    if (channel) parts.push(color(channel, ANSI.blue, colorsEnabled));
    if (metrics.status) parts.push(color(String(metrics.status), statusColor(metrics.status), colorsEnabled));
    parts.push(color(`↑ ${formatBytes(metrics.requestBytes)}`, ANSI.green, colorsEnabled));
    parts.push(color(`↓ ${formatBytes(metrics.responseBytes)}`, ANSI.cyan, colorsEnabled));
    parts.push(`首包 ${color(formatDuration(firstByte), ANSI.yellow, colorsEnabled)}`);
    parts.push(`首字 ${color(formatDuration(firstOutput), ANSI.magenta, colorsEnabled)}`);
    parts.push(`${completed ? '总耗时' : '已用'} ${color(formatDuration(total), ANSI.bold, colorsEnabled)}`);
    if (!completed && active.size > 1) parts.push(color(`[${active.size} 个请求]`, ANSI.dim, colorsEnabled));
    return parts.join(' | ');
  }

  function clearCurrentLine() {
    if (isInteractive) output.write(`\r${ANSI.clearLine}`);
  }

  function render() {
    if (!isInteractive || active.size === 0) return;
    frameIndex += 1;
    const metrics = Array.from(active.values()).at(-1);
    clearCurrentLine();
    output.write(renderLine(metrics));
  }

  function ensureTimer() {
    if (!isInteractive || timer) return;
    timer = setInterval(render, config.progress.refreshIntervalMs);
    timer.unref();
  }

  function stopTimerIfIdle() {
    if (active.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    isInteractive,
    start(metrics) {
      if (!isInteractive) return;
      active.set(metrics.id, metrics);
      ensureTimer();
      render();
    },
    update(metrics) {
      if (!isInteractive || !active.has(metrics.id)) return;
      active.set(metrics.id, metrics);
    },
    finish(metrics) {
      if (!isInteractive || !active.has(metrics.id)) return false;
      active.delete(metrics.id);
      clearCurrentLine();
      output.write(`${renderLine(metrics, true)}\n`);
      stopTimerIfIdle();
      render();
      return true;
    },
    print(line) {
      if (!isInteractive) {
        output.write(`${line}\n`);
        return;
      }
      clearCurrentLine();
      output.write(`${line}\n`);
      render();
    },
    close() {
      if (timer) clearInterval(timer);
      timer = null;
      if (active.size > 0) clearCurrentLine();
      active.clear();
    },
  };
}

function createProxyServer(rawConfig, options = {}) {
  const config = validateAndNormalizeConfig(rawConfig);
  const logOutput = options.log || defaultLog;
  const progress = createTerminalProgress(config, options.progress);
  const monitor = createMonitorState(config);
  const requestLog = createRequestLog(config);
  const clientSockets = new Set();

  function log(line) {
    if (config.logging.enabled) logOutput(line);
  }

  function debug(line) {
    if (!config.debug || !config.logging.enabled) return;
    const message = `${formatTime()} DEBUG ${line}`;
    if (progress.isInteractive) progress.print(message);
    else logOutput(message);
  }

  const server = http.createServer(async (request, response) => {
    const startedAt = process.hrtime.bigint();
    const requestId = String(request.headers['x-request-id'] || crypto.randomUUID());
    const clientUrl = new URL(request.url, 'http://localhost');

    // Local dashboard surface: loopback-only, never proxied upstream.
    if (clientUrl.pathname === '/_mini/status'
      || clientUrl.pathname.startsWith('/_mini/')
      || clientUrl.pathname === '/_mini') {
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        sendJson(response, 403, { error: { message: 'Local access only', type: 'forbidden' } });
        return;
      }
      if (request.method !== 'GET') {
        sendJson(response, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
        return;
      }
      response.setHeader('cache-control', 'no-store');

      if (clientUrl.pathname === '/_mini/status') {
        if (!config.monitor.enabled) {
          sendJson(response, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
          return;
        }
        sendJson(response, 200, monitor.snapshot());
        return;
      }

      if (clientUrl.pathname === '/_mini/requests') {
        const params = clientUrl.searchParams;
        const rawLimit = Number.parseInt(params.get('limit') || '100', 10);
        sendJson(response, 200, requestLog.query({
          limit: Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 100,
          group: params.get('group') || undefined,
          model: params.get('model') || undefined,
          status: params.get('status') || undefined,
          cached: params.get('cached') || undefined,
        }));
        return;
      }

      if (clientUrl.pathname === '/_mini/stats') {
        sendJson(response, 200, requestLog.stats());
        return;
      }

      if (clientUrl.pathname === '/_mini' || clientUrl.pathname === '/_mini/' || clientUrl.pathname === '/_mini/ui') {
        if (!config.webui.enabled) {
          sendJson(response, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
          return;
        }
        const html = renderDashboardHtml();
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(Buffer.byteLength(html)),
          'cache-control': 'no-store',
        });
        response.end(html);
        return;
      }

      sendJson(response, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
      return;
    }

    const endpoint = endpointForPath(clientUrl.pathname);

    if (!endpoint
      || (endpoint.name === 'responses' && request.method !== 'POST')
      || (endpoint.name === 'messages' && request.method !== 'POST')
      || (endpoint.name === 'chat' && request.method !== 'POST')
      || (endpoint.name === 'models' && request.method !== 'GET')) {
      sendJson(response, 404, { error: { message: 'Not found', type: 'invalid_request_error' } });
      return;
    }

    if (!isClientAuthorized(request, config)) {
      response.setHeader('www-authenticate', 'Bearer');
      sendJson(response, 401, {
        error: { message: 'Invalid API key', type: 'authentication_error' },
      });
      return;
    }

    if (endpoint.name === 'models' && config.overrideModelList) {
      sendJson(response, 200, buildLocalModelList(config.modelListIds));
      return;
    }

    let rawRequestBody = null;
    let rawRequestBytes = 0;
    let bodyInfo = { parsed: null, rewritable: false, requestedModel: undefined, stream: false };
    try {
      if (request.method === 'POST') {
        rawRequestBody = await readRequestBody(request);
        rawRequestBytes = rawRequestBody.length;
        bodyInfo = inspectRequestBody(
          rawRequestBody,
          String(request.headers['content-encoding'] || '').toLowerCase(),
        );
      }
    } catch (error) {
      sendJson(response, 400, { error: { message: error.message, type: 'invalid_request_error' } });
      return;
    }

    const candidates = resolveRoute(config, endpoint.name, bodyInfo.requestedModel);
    if (candidates.length === 0) {
      sendJson(response, 404, {
        error: {
          message: bodyInfo.requestedModel
            ? `No active channel serves model ${bodyInfo.requestedModel} on this endpoint`
            : 'No active channel serves this endpoint',
          type: 'invalid_request_error',
        },
      });
      return;
    }

    let finalStatus = 502;
    let current = candidates[0];
    let currentBody = null;
    const progressMetrics = {
      id: requestId.slice(0, 8),
      method: request.method,
      path: clientUrl.pathname,
      originalModel: bodyInfo.requestedModel,
      mappedModel: current.targetModel,
      group: current.group.name,
      upstream: current.upstream.name,
      status: null,
      requestBytes: rawRequestBytes,
      responseBytes: 0,
      firstByteAt: null,
      firstOutputTextAt: null,
      startedAt,
      endedAt: null,
      stream: bodyInfo.stream,
      completed: false,
      failed: false,
      usage: null,
    };
    monitor.start(progressMetrics);
    progress.start(progressMetrics);
    let attempts = 0;
    let logged = false;
    const finishLog = () => {
      if (logged) return;
      logged = true;
      progressMetrics.status = finalStatus;
      progressMetrics.endedAt = process.hrtime.bigint();
      progressMetrics.failed = finalStatus < 200 || finalStatus >= 400;
      monitor.finish(progressMetrics);
      const durationSeconds = elapsedSeconds(startedAt, progressMetrics.endedAt);
      const modelPart = progressMetrics.originalModel
        ? ` model=${progressMetrics.originalModel}->${progressMetrics.mappedModel}`
        : '';
      const bytePart = rawRequestBody === null ? '' : ` bytes=${rawRequestBytes}`;
      const streamPart = endpoint.name === 'models' ? '' : ` stream=${bodyInfo.stream}`;
      const rate = cacheHitRate(progressMetrics.usage);
      const cachePart = rate === null ? '' : ` cache=${(rate * 100).toFixed(1)}%`;
      const tokenPart = progressMetrics.usage
        ? ` tokens=${progressMetrics.usage.promptTokens}/${progressMetrics.usage.outputTokens}`
        : '';
      requestLog.record(progressMetrics, { attempts });
      if (!progress.finish(progressMetrics)) {
        log(`${formatTime()} ${request.method} ${clientUrl.pathname}${modelPart}`
          + ` group=${progressMetrics.group} upstream=${progressMetrics.upstream}:${finalStatus}`
          + ` duration=${durationSeconds.toFixed(2)}s`
          + `${bytePart} responseBytes=${progressMetrics.responseBytes}${streamPart}`
          + `${tokenPart}${cachePart}`);
      }
    };
    response.once('finish', finishLog);
    response.once('close', finishLog);

    const tryCandidate = (index) => {
      if (index >= candidates.length) {
        finalStatus = 502;
        sendJson(response, 502, {
          error: { message: 'Unable to connect to upstream', type: 'upstream_connection_error' },
        });
        return;
      }

      attempts += 1;
      current = candidates[index];
      const { group, upstream, targetModel } = current;
      currentBody = rawRequestBody === null
        ? null
        : bodyWithModel(rawRequestBody, bodyInfo, targetModel);
      progressMetrics.group = group.name;
      progressMetrics.upstream = upstream.name;
      progressMetrics.mappedModel = targetModel;
      progress.update(progressMetrics);
      const upstreamUrl = buildUpstreamUrl(upstream.baseUrl, endpoint.canonicalPath, clientUrl.search);
      const transport = upstreamUrl.protocol === 'https:' ? https : http;
      const forceIdentityEncoding = endpoint.name === 'models' && config.injectMappedModels;
      const headers = prepareRequestHeaders(
        request.headers,
        upstream,
        config,
        currentBody,
        forceIdentityEncoding,
      );

      debug(`request_id=${requestId} group=${group.name} upstream=${upstream.name}`
        + ` target=${upstreamUrl.origin}${upstreamUrl.pathname}`);
      let receivedResponse = false;
      let connectTimer;
      const upstreamRequest = transport.request(upstreamUrl, {
        method: request.method,
        headers,
        agent: (endpoint.name === 'responses' || endpoint.name === 'messages' || endpoint.name === 'chat') ? false : undefined,
      });

      upstreamRequest.once('socket', (socket) => {
        const clearConnectTimer = () => {
          if (connectTimer) clearTimeout(connectTimer);
        };
        if (socket.connecting) {
          const connectedEvent = upstreamUrl.protocol === 'https:' ? 'secureConnect' : 'connect';
          socket.once(connectedEvent, clearConnectTimer);
          connectTimer = setTimeout(() => {
            const error = new Error(`Upstream connect timeout after ${config.timeouts.connectTimeoutMs}ms`);
            error.code = 'ETIMEDOUT';
            upstreamRequest.destroy(error);
          }, config.timeouts.connectTimeoutMs);
          connectTimer.unref();
        }
      });

      upstreamRequest.once('response', (upstreamResponse) => {
        receivedResponse = true;
        if (connectTimer) clearTimeout(connectTimer);
        finalStatus = upstreamResponse.statusCode || 502;
        progressMetrics.status = finalStatus;
        progress.update(progressMetrics);
        const contentType = String(upstreamResponse.headers['content-type'] || '');
        debug(`request_id=${requestId} upstream=${upstream.name} status=${finalStatus} content_type=${contentType || '<none>'}`);

        if (FAILOVER_STATUS_CODES.has(finalStatus) && index + 1 < candidates.length) {
          const next = candidates[index + 1];
          debug(`request_id=${requestId} failover=${finalStatus}`
            + ` next=${next.group.name}/${next.upstream.name}`);
          upstreamResponse.resume();
          tryCandidate(index + 1);
          return;
        }

        if (endpoint.name === 'models'
          && config.injectMappedModels
          && finalStatus >= 200
          && finalStatus < 300) {
          const chunks = [];
          upstreamResponse.on('data', (chunk) => {
            const observedAt = process.hrtime.bigint();
            if (progressMetrics.firstByteAt === null) progressMetrics.firstByteAt = observedAt;
            progressMetrics.responseBytes += chunk.length;
            chunks.push(chunk);
            progress.update(progressMetrics);
          });
          upstreamResponse.once('end', () => {
            const originalBody = Buffer.concat(chunks);
            const injectedBody = injectMappedModels(
              originalBody,
              upstreamResponse.headers,
              config.modelListIds,
            );
            const responseBody = injectedBody || originalBody;
            const responseHeaders = prepareResponseHeaders(upstreamResponse.headers);
            if (injectedBody) {
              delete responseHeaders['content-encoding'];
              responseHeaders['content-length'] = String(responseBody.length);
            }
            response.writeHead(finalStatus, upstreamResponse.statusMessage, responseHeaders);
            response.end(responseBody);
          });
          upstreamResponse.once('error', (error) => {
            debug(`request_id=${requestId} upstream_response_error=${error.code || error.message}`);
            response.destroy(error);
          });
          return;
        }

        const responseHeaders = prepareResponseHeaders(upstreamResponse.headers);
        response.writeHead(finalStatus, upstreamResponse.statusMessage, responseHeaders);

        const wantsUsage = config.requestLog.enabled || config.monitor.enabled;
        let observer;
        if ((config.debug || progress.isInteractive || wantsUsage)
          && /text\/event-stream/i.test(contentType)) {
          observer = createSseObserver();
        }
        // Non-stream replies carry usage in the final JSON object. Chunks are collected
        // alongside the pipe (no added latency) and capped so a large body cannot grow
        // memory without bound.
        const jsonChunks = wantsUsage
          && !observer
          && /application\/json/i.test(contentType)
          && finalStatus >= 200
          && finalStatus < 300
          ? [] : null;
        let jsonBytes = 0;

        upstreamResponse.on('data', (chunk) => {
          const observedAt = process.hrtime.bigint();
          if (progressMetrics.firstByteAt === null) progressMetrics.firstByteAt = observedAt;
          progressMetrics.responseBytes += chunk.length;
          if (observer) {
            observer.observe(chunk, observedAt);
            progressMetrics.firstOutputTextAt = observer.state.firstOutputTextAt;
            progressMetrics.completed = observer.state.completed;
            progressMetrics.failed = observer.state.failed;
            progressMetrics.usage = observer.state.usage;
          } else if (jsonChunks && jsonBytes < 1048576) {
            jsonChunks.push(chunk);
            jsonBytes += chunk.length;
          }
          progress.update(progressMetrics);
        });

        upstreamResponse.once('end', () => {
          if (observer) {
            const { completed, failed, done } = observer.state;
            progressMetrics.usage = observer.state.usage;
            debug(`request_id=${requestId} sse_end=true completed=${completed} failed=${failed} done=${done}`);
          } else if (jsonChunks && jsonBytes > 0 && jsonBytes <= 1048576) {
            try {
              progressMetrics.usage = usageFromPayload(JSON.parse(Buffer.concat(jsonChunks).toString('utf8')));
            } catch {
              // Not JSON after all; usage simply stays null.
            }
          }
        });
        upstreamResponse.once('error', (error) => {
          debug(`request_id=${requestId} upstream_response_error=${error.code || error.message}`);
          response.destroy(error);
        });
        upstreamResponse.pipe(response);
      });

      upstreamRequest.once('error', (error) => {
        if (connectTimer) clearTimeout(connectTimer);
        if (receivedResponse || response.headersSent || response.destroyed) {
          debug(`request_id=${requestId} stream_error=${error.code || error.message}`);
          if (!response.destroyed) response.destroy(error);
          return;
        }

        debug(`request_id=${requestId} connect_error=${error.code || error.message}`);
        if (index + 1 < candidates.length) {
          tryCandidate(index + 1);
        } else {
          finalStatus = 502;
          sendJson(response, 502, {
            error: { message: 'Unable to connect to upstream', type: 'upstream_connection_error' },
          });
        }
      });

      request.once('aborted', () => upstreamRequest.destroy());
      response.once('close', () => {
        if (!response.writableFinished) upstreamRequest.destroy();
      });

      if (currentBody !== null) upstreamRequest.end(currentBody);
      else upstreamRequest.end();
    };

    tryCandidate(0);
  });

  server.on('connection', (socket) => {
    clientSockets.add(socket);
    socket.once('close', () => clientSockets.delete(socket));
  });

  server.gracefulShutdown = (callback) => {
    progress.close();
    Promise.resolve(requestLog.flush()).finally(() => {
      server.close(callback);
      for (const socket of clientSockets) socket.destroy();
    });
  };

  return server;
}

function startFromConfig() {
  const configPath = process.env.MINI_CODEX_PROXY_CONFIG
    ? path.resolve(process.env.MINI_CODEX_PROXY_CONFIG)
    : path.join(__dirname, 'config.json');
  let config;
  try {
    config = loadConfig(configPath);
  } catch (error) {
    process.stderr.write(`Configuration error: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const server = createProxyServer(config);
  server.on('error', (error) => {
    process.stderr.write(`Proxy error: ${error.message}\n`);
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    process.stdout.write(
      `mini-codex-proxy listening on http://${config.host}:${config.port}`
      + ` (groups=${config.activeGroups.join(',')})\n`,
    );
    if (config.host === '0.0.0.0' || config.host === '::') {
      process.stderr.write('WARNING: proxy is exposed to the network.\n');
    }
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`Received ${signal}, shutting down.\n`);
    server.gracefulShutdown(() => process.exit(0));
    const forceExitTimer = setTimeout(() => process.exit(0), 1000);
    forceExitTimer.unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  return server;
}

if (require.main === module) {
  startFromConfig();
}

module.exports = {
  buildLocalModelList,
  cacheHitRate,
  createSseObserver,
  normalizeUsage,
  usageFromPayload,
  buildUpstreamUrl,
  bodyWithModel,
  createProxyServer,
  inspectRequestBody,
  loadConfig,
  resolveRoute,
  startFromConfig,
  validateAndNormalizeConfig,
};
