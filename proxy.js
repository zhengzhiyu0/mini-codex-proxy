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

  let upstreams;
  if (Array.isArray(input.upstreams) && input.upstreams.length > 0) {
    upstreams = input.upstreams.map((upstream, index) => {
      if (!upstream || typeof upstream !== 'object') {
        throw new Error(`Invalid upstreams[${index}]`);
      }
      return {
        name: typeof upstream.name === 'string' && upstream.name.trim()
          ? upstream.name.trim()
          : `upstream-${index + 1}`,
        baseUrl: normalizeBaseUrl(upstream.baseUrl, `upstreams[${index}].baseUrl`),
        apiKey: typeof upstream.apiKey === 'string' ? upstream.apiKey : '',
        priority: Number.isFinite(upstream.priority) ? upstream.priority : 0,
      };
    }).sort((a, b) => b.priority - a.priority);
  } else {
    const upstream = input.upstream;
    if (!upstream || typeof upstream !== 'object') {
      throw new Error('Missing upstream.baseUrl');
    }
    upstreams = [{
      name: typeof upstream.name === 'string' && upstream.name.trim() ? upstream.name.trim() : 'upstream',
      baseUrl: normalizeBaseUrl(upstream.baseUrl, 'upstream.baseUrl'),
      apiKey: typeof upstream.apiKey === 'string' ? upstream.apiKey : '',
      priority: 0,
    }];
  }

  const models = input.models === undefined ? {} : input.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) {
    throw new Error('Invalid models: expected an object');
  }
  for (const [alias, target] of Object.entries(models)) {
    if (!alias || typeof target !== 'string' || !target) {
      throw new Error(`Invalid model mapping for ${alias || '<empty>'}`);
    }
  }

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

  return {
    host: host.trim(),
    port,
    upstreams,
    clientApiKey: typeof input.clientApiKey === 'string' ? input.clientApiKey : '',
    forwardClientAuthorization: input.forwardClientAuthorization === true,
    models: { ...models },
    injectMappedModels: input.injectMappedModels === true,
    logging: { enabled: input.logging?.enabled !== false },
    progress: {
      enabled: input.progress?.enabled === true,
      color: input.progress?.color !== false,
      refreshIntervalMs,
    },
    debug: input.debug === true,
    timeouts: { connectTimeoutMs },
  };
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

function rewriteModel(body, contentEncoding, models) {
  const result = {
    body,
    originalModel: undefined,
    mappedModel: undefined,
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

    result.stream = parsed.stream === true;
    if (typeof parsed.model !== 'string') {
      return result;
    }

    result.originalModel = parsed.model;
    result.mappedModel = Object.prototype.hasOwnProperty.call(models, parsed.model)
      ? models[parsed.model]
      : parsed.model;

    if (result.mappedModel !== result.originalModel) {
      parsed.model = result.mappedModel;
      result.body = Buffer.from(JSON.stringify(parsed));
    }
  } catch {
    // Preserve malformed JSON so the upstream can return its native error response.
  }

  return result;
}

function prepareRequestHeaders(clientHeaders, upstream, config, body, forceIdentityEncoding) {
  const headers = cloneHeadersWithoutHopByHop(clientHeaders);
  delete headers.host;
  delete headers['content-length'];
  delete headers.expect;

  if (forceIdentityEncoding) {
    headers['accept-encoding'] = 'identity';
  }

  if (!config.clientApiKey && config.forwardClientAuthorization && clientHeaders.authorization) {
    headers.authorization = clientHeaders.authorization;
  } else if (upstream.apiKey) {
    headers.authorization = `Bearer ${upstream.apiKey}`;
  } else {
    delete headers.authorization;
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
  const token = extractBearerToken(request.headers.authorization);
  return safeTokenEqual(token, config.clientApiKey);
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

function injectMappedModels(body, headers, mappings) {
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
    for (const alias of Object.keys(mappings)) {
      if (!existingIds.has(alias)) {
        parsed.data.push({
          id: alias,
          object: 'model',
          created: 0,
          owned_by: 'mini-codex-proxy',
        });
      }
    }
    return Buffer.from(JSON.stringify(parsed));
  } catch {
    return null;
  }
}

function createSseObserver() {
  let tail = '';
  const state = { completed: false, failed: false, done: false, firstOutputTextAt: null };

  return {
    observe(chunk, observedAt = process.hrtime.bigint()) {
      const text = tail + chunk.toString('utf8');
      if (/response\.completed/.test(text)) state.completed = true;
      if (/response\.failed/.test(text)) state.failed = true;
      if (/data:\s*\[DONE\]/.test(text)) state.done = true;
      if (state.firstOutputTextAt === null && /response\.output_text\.delta/.test(text)) {
        state.firstOutputTextAt = observedAt;
      }
      tail = text.slice(-256);
    },
    state,
  };
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
    if (metrics.upstream) parts.push(color(metrics.upstream, ANSI.blue, colorsEnabled));
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
    const endpoint = endpointForPath(clientUrl.pathname);

    if (!endpoint
      || (endpoint.name === 'responses' && request.method !== 'POST')
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

    let requestBody = null;
    let rawRequestBytes = 0;
    let requestInfo = { body: null, originalModel: undefined, mappedModel: undefined, stream: false };
    try {
      if (request.method === 'POST') {
        requestBody = await readRequestBody(request);
        rawRequestBytes = requestBody.length;
        requestInfo = rewriteModel(
          requestBody,
          String(request.headers['content-encoding'] || '').toLowerCase(),
          config.models,
        );
        requestBody = requestInfo.body;
      }
    } catch (error) {
      sendJson(response, 400, { error: { message: error.message, type: 'invalid_request_error' } });
      return;
    }

    let finalStatus = 502;
    let finalUpstreamName = config.upstreams[0].name;
    const progressMetrics = {
      id: requestId.slice(0, 8),
      method: request.method,
      path: clientUrl.pathname,
      originalModel: requestInfo.originalModel,
      mappedModel: requestInfo.mappedModel,
      upstream: finalUpstreamName,
      status: null,
      requestBytes: rawRequestBytes,
      responseBytes: 0,
      firstByteAt: null,
      firstOutputTextAt: null,
      startedAt,
      endedAt: null,
    };
    progress.start(progressMetrics);
    let logged = false;
    const finishLog = () => {
      if (logged) return;
      logged = true;
      progressMetrics.status = finalStatus;
      progressMetrics.upstream = finalUpstreamName;
      progressMetrics.endedAt = process.hrtime.bigint();
      const durationSeconds = elapsedSeconds(startedAt, progressMetrics.endedAt);
      const modelPart = requestInfo.originalModel
        ? ` model=${requestInfo.originalModel}->${requestInfo.mappedModel}`
        : '';
      const bytePart = requestBody === null ? '' : ` bytes=${rawRequestBytes}`;
      const streamPart = endpoint.name === 'responses' ? ` stream=${requestInfo.stream}` : '';
      if (!progress.finish(progressMetrics)) {
        log(`${formatTime()} ${request.method} ${clientUrl.pathname}${modelPart}`
          + ` upstream=${finalUpstreamName}:${finalStatus} duration=${durationSeconds.toFixed(2)}s`
          + `${bytePart} responseBytes=${progressMetrics.responseBytes}${streamPart}`);
      }
    };
    response.once('finish', finishLog);
    response.once('close', finishLog);

    const tryUpstream = (index) => {
      if (index >= config.upstreams.length) {
        finalStatus = 502;
        sendJson(response, 502, {
          error: { message: 'Unable to connect to upstream', type: 'upstream_connection_error' },
        });
        return;
      }

      const upstream = config.upstreams[index];
      finalUpstreamName = upstream.name;
      progressMetrics.upstream = finalUpstreamName;
      progress.update(progressMetrics);
      const upstreamUrl = buildUpstreamUrl(upstream.baseUrl, endpoint.canonicalPath, clientUrl.search);
      const transport = upstreamUrl.protocol === 'https:' ? https : http;
      const forceIdentityEncoding = endpoint.name === 'models' && config.injectMappedModels;
      const headers = prepareRequestHeaders(
        request.headers,
        upstream,
        config,
        requestBody,
        forceIdentityEncoding,
      );

      debug(`request_id=${requestId} upstream=${upstream.name} target=${upstreamUrl.origin}${upstreamUrl.pathname}`);

      let receivedResponse = false;
      let connectTimer;
      const upstreamRequest = transport.request(upstreamUrl, {
        method: request.method,
        headers,
        agent: endpoint.name === 'responses' ? false : undefined,
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

        if (FAILOVER_STATUS_CODES.has(finalStatus) && index + 1 < config.upstreams.length) {
          debug(`request_id=${requestId} failover=${finalStatus} next=${config.upstreams[index + 1].name}`);
          upstreamResponse.resume();
          tryUpstream(index + 1);
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
            const injectedBody = injectMappedModels(originalBody, upstreamResponse.headers, config.models);
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

        let observer;
        if ((config.debug || progress.isInteractive) && /text\/event-stream/i.test(contentType)) {
          observer = createSseObserver();
        }

        upstreamResponse.on('data', (chunk) => {
          const observedAt = process.hrtime.bigint();
          if (progressMetrics.firstByteAt === null) progressMetrics.firstByteAt = observedAt;
          progressMetrics.responseBytes += chunk.length;
          if (observer) {
            observer.observe(chunk, observedAt);
            progressMetrics.firstOutputTextAt = observer.state.firstOutputTextAt;
          }
          progress.update(progressMetrics);
        });

        upstreamResponse.once('end', () => {
          if (observer) {
            const { completed, failed, done } = observer.state;
            debug(`request_id=${requestId} sse_end=true completed=${completed} failed=${failed} done=${done}`);
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
        if (index + 1 < config.upstreams.length) {
          tryUpstream(index + 1);
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

      if (requestBody !== null) upstreamRequest.end(requestBody);
      else upstreamRequest.end();
    };

    tryUpstream(0);
  });

  server.on('connection', (socket) => {
    clientSockets.add(socket);
    socket.once('close', () => clientSockets.delete(socket));
  });

  server.gracefulShutdown = (callback) => {
    progress.close();
    server.close(callback);
    for (const socket of clientSockets) socket.destroy();
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
    process.stdout.write(`mini-codex-proxy listening on http://${config.host}:${config.port}\n`);
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
  buildUpstreamUrl,
  createProxyServer,
  loadConfig,
  rewriteModel,
  startFromConfig,
  validateAndNormalizeConfig,
};
