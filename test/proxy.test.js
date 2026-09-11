'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { once } = require('node:events');
const proxy = require('../proxy');
const { normalizeUsage, cacheHitRate, validateAndNormalizeConfig } = proxy;

function createProxyServer(rawConfig, options) {
  // Tests must not share the process-wide default jsonl; opt in with requestLog.file.
  const requestLog = rawConfig.requestLog || {};
  const config = requestLog.file
    ? rawConfig
    : { ...rawConfig, requestLog: { file: null, ...requestLog } };
  return proxy.createProxyServer(config, options);
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

function request({ port, path = '/v1/responses', method = 'POST', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

function makeConfig(upstreamPort, overrides = {}) {
  return {
    host: '127.0.0.1',
    port: 8317,
    upstream: {
      name: 'test-upstream',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: 'server-secret-key',
    },
    clientApiKey: '',
    forwardClientAuthorization: false,
    models: { 'gpt-5.6-sol': 'gpt-5.4' },
    injectMappedModels: true,
    overrideModelList: false,
    logging: { enabled: true },
    requestLog: { file: null },
    timeouts: { connectTimeoutMs: 1000 },
    ...overrides,
  };
}

test('chat completions requests are forwarded to the upstream /chat/completions path with model mapping', async (t) => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"chatcmpl_1","object":"chat.completion"}');
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(makeConfig(upstreamPort), { log: (line) => logs.push(line) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const input = {
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hello' }],
    stream: false,
  };
  const result = await request({
    port: proxyPort,
    path: '/v1/chat/completions',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer client-secret-key',
    },
    body: JSON.stringify(input),
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.toString(), '{"id":"chatcmpl_1","object":"chat.completion"}');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.authorization, 'Bearer server-secret-key');
  assert.deepEqual(received.body, { ...input, model: 'gpt-5.4' });
  assert.ok(logs.some((line) => line.includes('gpt-5.6-sol->gpt-5.4')));
});

test('non-streaming request only changes model and uses configured authorization', async (t) => {
  let received;
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': 'yes' });
    res.end('{"id":"resp_1","object":"response"}');
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const proxy = createProxyServer(makeConfig(upstreamPort), { log: (line) => logs.push(line) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const input = {
    model: 'gpt-5.6-sol',
    input: [{ role: 'user', content: 'do-not-log-this-prompt' }],
    instructions: 'keep me',
    tools: [{ type: 'function', name: 'demo', parameters: { type: 'object' } }],
    reasoning: { effort: 'high', summary: 'auto' },
    store: false,
    metadata: { trace: 'abc' },
    future_field: { untouched: true },
  };
  const result = await request({
    port: proxyPort,
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer client-secret-key',
      connection: 'keep-alive, x-remove-me',
      'x-remove-me': 'secret-hop',
    },
    body: JSON.stringify(input),
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.toString(), '{"id":"resp_1","object":"response"}');
  assert.equal(result.headers['x-upstream'], 'yes');
  assert.equal(received.url, '/v1/responses');
  assert.equal(received.authorization, 'Bearer server-secret-key');
  assert.deepEqual(received.body, { ...input, model: 'gpt-5.4' });
  assert.ok(logs.some((line) => line.includes('gpt-5.6-sol->gpt-5.4')));
  assert.ok(logs.every((line) => !line.includes('server-secret-key')));
  assert.ok(logs.every((line) => !line.includes('client-secret-key')));
  assert.ok(logs.every((line) => !line.includes('do-not-log-this-prompt')));
});

test('SSE chunks and Responses event bytes arrive without body rewriting or buffering', async (t) => {
  const chunks = [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"think"}\n\n',
    'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"x\\":"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"<thinking>raw</thinking>"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed"}\n\n',
    'data: [DONE]\n\n',
  ];
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    let index = 0;
    const writeNext = () => {
      res.write(chunks[index]);
      index += 1;
      if (index < chunks.length) setTimeout(writeNext, 35);
      else res.end();
    };
    writeNext();
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(makeConfig(upstreamPort, { debug: true }), { log() {} });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const started = Date.now();
  const arrivals = [];
  const body = await new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/responses',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }, (res) => {
      const received = [];
      res.on('data', (chunk) => {
        arrivals.push(Date.now() - started);
        received.push(chunk);
      });
      res.on('end', () => resolve(Buffer.concat(received).toString('utf8')));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi', stream: true }));
  });

  assert.equal(body, chunks.join(''));
  assert.ok(arrivals.length >= 2, `expected multiple streamed arrivals, got ${arrivals.length}`);
  assert.ok(arrivals[0] < 120, `first chunk was buffered for ${arrivals[0]}ms`);
  assert.ok(arrivals.at(-1) - arrivals[0] >= 100, 'expected chunks to remain time-separated');
});

test('interactive progress renders colors, byte counts, first byte/text, and total duration', async (t) => {
  const chunks = [
    'event: response.created\ndata: {"type":"response.created"}\n\n',
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n',
    'event: response.completed\ndata: {"type":"response.completed"}\n\n',
  ];
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(chunks[0]);
    setTimeout(() => res.write(chunks[1]), 70);
    setTimeout(() => res.end(chunks[2]), 140);
  });
  const upstreamPort = await listen(upstream);
  let terminalOutput = '';
  const fakeTerminal = {
    isTTY: true,
    write(value) { terminalOutput += String(value); },
  };
  const proxy = createProxyServer(makeConfig(upstreamPort, {
    progress: { enabled: true, color: true, refreshIntervalMs: 50 },
  }), {
    log() {},
    progress: { output: fakeTerminal, isTTY: true },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const result = await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi', stream: true }),
  });

  assert.equal(result.body.toString('utf8'), chunks.join(''));
  assert.match(terminalOutput, /\x1b\[/);
  assert.match(terminalOutput, /↑ [\d.]+ (?:B|KB)/);
  assert.match(terminalOutput, /↓ [\d.]+ (?:B|KB)/);
  assert.match(terminalOutput, /首包 \x1b\[[^m]+m\d+\.\d{2}s/);
  assert.match(terminalOutput, /首字 \x1b\[[^m]+m\d+\.\d{2}s/);
  assert.match(terminalOutput, /总耗时/);
  assert.match(terminalOutput, /gpt-5\.6-sol→gpt-5\.4/);
  assert.doesNotMatch(terminalOutput, /"delta":"hello"/);
});

test('upstream 401, 429, and 502 status/body pairs are preserved', async (t) => {
  const upstream = http.createServer((req, res) => {
    const status = Number(req.headers['x-test-status']);
    const expected = Buffer.from(`{"error":{"message":"upstream-${status}","status":${status}}}`);
    res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '9' });
    res.end(expected);
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(makeConfig(upstreamPort));
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  for (const status of [401, 429, 502]) {
    const expected = Buffer.from(`{"error":{"message":"upstream-${status}","status":${status}}}`);
    const result = await request({
      port: proxyPort,
      body: JSON.stringify({ model: 'unmapped-model', input: 'hi' }),
      headers: { 'content-type': 'application/json', 'x-test-status': String(status) },
    });
    assert.equal(result.statusCode, status);
    assert.equal(result.headers['retry-after'], '9');
    assert.deepEqual(result.body, expected);
  }
});

test('overrideModelList returns only configured aliases and does not call upstream', async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => {
    upstreamHits += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'should-not-appear', object: 'model' }] }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(makeConfig(upstreamPort, {
    models: { 'gpt-5.6-sol': 'grok4.6', 'gpt-5.6-luna': 'gpt-5.4-mini' },
    injectMappedModels: true,
    overrideModelList: true,
  }));
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const result = await request({ port: proxyPort, path: '/v1/models', method: 'GET' });
  const parsed = JSON.parse(result.body.toString('utf8'));
  assert.equal(result.statusCode, 200);
  assert.equal(upstreamHits, 0);
  assert.deepEqual(parsed.data.map((model) => model.id), ['gpt-5.6-sol', 'gpt-5.6-luna']);
  assert.ok(parsed.data.every((model) => model.owned_by === 'mini-codex-proxy'));
});

test('mapped aliases are injected into successful models response', async (t) => {
  const upstream = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/models');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-5.4', object: 'model' }] }));
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(makeConfig(upstreamPort));
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const result = await request({ port: proxyPort, path: '/v1/models', method: 'GET' });
  const parsed = JSON.parse(result.body.toString('utf8'));
  assert.equal(result.statusCode, 200);
  assert.ok(parsed.data.some((model) => model.id === 'gpt-5.4'));
  assert.ok(parsed.data.some((model) => model.id === 'gpt-5.6-sol'));
});

test('client authorization is preferred when configured', async (t) => {
  let receivedAuthorization;
  const upstream = http.createServer((req, res) => {
    receivedAuthorization = req.headers.authorization;
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(makeConfig(upstreamPort, { forwardClientAuthorization: true }));
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json', authorization: 'Bearer client-key' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });
  assert.equal(receivedAuthorization, 'Bearer client-key');
});

test('clientApiKey protects the proxy and is never forwarded upstream', async (t) => {
  let receivedAuthorization;
  const logs = [];
  const upstream = http.createServer((req, res) => {
    receivedAuthorization = req.headers.authorization;
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer(makeConfig(upstreamPort, {
    clientApiKey: 'my-unified-local-key',
    forwardClientAuthorization: true,
  }), { log: (line) => logs.push(line) });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const unauthorized = await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json', authorization: 'Bearer wrong-key' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });
  assert.equal(unauthorized.statusCode, 401);
  assert.equal(unauthorized.headers['www-authenticate'], 'Bearer');

  const authorized = await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json', authorization: 'Bearer my-unified-local-key' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });
  assert.equal(authorized.statusCode, 200);
  assert.equal(receivedAuthorization, 'Bearer server-secret-key');
  assert.ok(logs.every((line) => !line.includes('my-unified-local-key')));
  assert.ok(logs.every((line) => !line.includes('server-secret-key')));
});

test('local monitor status is in-memory, loopback-only, and excludes prompt/SSE content', async (t) => {
  const upstream = await (async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"secret-answer"}\n\n');
      server.__response = res;
    });
    const port = await listen(server);
    return { server, port };
  })();
  const proxy = createProxyServer(makeConfig(upstream.port, {
    clientApiKey: 'monitor-local-key',
    monitor: { enabled: true },
  }));
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream.server); });

  const requestPromise = new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/v1/responses',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer monitor-local-key',
      },
    }, (res) => {
      res.on('error', reject);
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end(JSON.stringify({
      model: 'gpt-5.6-sol',
      input: 'do-not-expose-this-prompt',
      stream: true,
    }));
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const status = await request({
    port: proxyPort,
    path: '/_mini/status',
    method: 'GET',
    headers: {},
  });
  assert.equal(status.statusCode, 200);
  const snapshot = JSON.parse(status.body.toString('utf8'));
  assert.equal(snapshot.service, 'mini-codex-proxy');
  assert.ok(snapshot.activeCount >= 1);
  assert.ok(snapshot.activeRequests[0].requestBytes > 0);
  assert.equal(snapshot.activeRequests[0].model, 'gpt-5.6-sol');
  assert.equal(snapshot.activeRequests[0].mappedModel, 'gpt-5.4');
  assert.doesNotMatch(status.body.toString('utf8'), /do-not-expose-this-prompt|secret-answer|monitor-local-key/);

  upstream.server.__response.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  await requestPromise;
  const finalStatus = await request({ port: proxyPort, path: '/_mini/status', method: 'GET' });
  const finalSnapshot = JSON.parse(finalStatus.body.toString('utf8'));
  assert.equal(finalSnapshot.activeCount, 0);
  assert.equal(finalSnapshot.latest.state, 'completed');
  assert.ok(finalSnapshot.latest.firstOutputTextMs !== null);
  assert.equal(finalSnapshot.history.length, 1);
  assert.equal(finalSnapshot.history[0].state, 'completed');
  assert.doesNotMatch(finalStatus.body.toString('utf8'), /do-not-expose-this-prompt|secret-answer|monitor-local-key/);
  assert.equal(snapshot.group, 'default');
});

test('activeGroup selects that group upstreams and model mapping', async (t) => {
  let received;
  const unused = http.createServer(() => {
    throw new Error('inactive group should not be contacted');
  });
  const grok = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"should-not-call-upstream"}');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = {
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"resp_group"}');
  });
  const unusedPort = await listen(unused);
  const grokPort = await listen(grok);
  const proxy = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    activeGroup: 'grok',
    groups: {
      naiccc: {
        upstream: { name: 'naiccc', baseUrl: `http://127.0.0.1:${unusedPort}/v1`, apiKey: 'naiccc-key' },
        models: { 'gpt-5.6-sol': 'gpt-5.4' },
      },
      grok: {
        upstream: { name: 'grok', baseUrl: `http://127.0.0.1:${grokPort}/v1`, apiKey: 'grok-key' },
        models: { 'gpt-5.6-sol': 'grok-4.6' },
        overrideModelList: true,
      },
    },
    logging: { enabled: false },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(unused); await close(grok); });

  const models = await request({ port: proxyPort, path: '/v1/models', method: 'GET' });
  assert.equal(models.statusCode, 200);
  assert.deepEqual(JSON.parse(models.body.toString('utf8')).data.map((model) => model.id), ['gpt-5.6-sol']);

  const result = await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(received.authorization, 'Bearer grok-key');
  assert.equal(received.body.model, 'grok-4.6');

  const status = await request({ port: proxyPort, path: '/_mini/status', method: 'GET' });
  const snapshot = JSON.parse(status.body.toString('utf8'));
  assert.equal(snapshot.group, 'grok');
  assert.deepEqual(snapshot.groups, ['naiccc', 'grok']);
});

test('several groups stay active at once and each alias reaches its own channel', async (t) => {
  const calls = [];
  const openai = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      channel: 'openai',
      url: req.url,
      authorization: req.headers.authorization,
      apiKeyHeader: req.headers['x-api-key'],
      model: JSON.parse(Buffer.concat(chunks).toString('utf8')).model,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"resp_openai"}');
  });
  const anthropic = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    calls.push({
      channel: 'anthropic',
      url: req.url,
      authorization: req.headers.authorization,
      apiKeyHeader: req.headers['x-api-key'],
      model: JSON.parse(Buffer.concat(chunks).toString('utf8')).model,
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"msg_claude"}');
  });
  const openaiPort = await listen(openai);
  const anthropicPort = await listen(anthropic);
  const proxy = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    activeGroups: ['openai', 'claude'],
    groups: {
      openai: {
        upstream: { name: 'oai', baseUrl: `http://127.0.0.1:${openaiPort}/v1`, apiKey: 'oai-key' },
        models: { 'gpt-5.6-sol': 'gpt-5.4' },
        endpoints: ['responses', 'chat', 'models'],
      },
      claude: {
        upstream: {
          name: 'anthropic',
          baseUrl: `http://127.0.0.1:${anthropicPort}`,
          apiKey: 'claude-key',
          authStyle: 'x-api-key',
        },
        models: { 'claude-sonnet': 'claude-sonnet-4-6' },
        endpoints: ['messages', 'models'],
      },
    },
    logging: { enabled: false },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(openai); await close(anthropic); });

  const viaOpenai = await request({
    port: proxyPort,
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });
  assert.equal(viaOpenai.statusCode, 200);
  assert.equal(viaOpenai.body.toString(), '{"id":"resp_openai"}');
  assert.deepEqual(calls.at(-1), {
    channel: 'openai',
    url: '/v1/responses',
    authorization: 'Bearer oai-key',
    apiKeyHeader: undefined,
    model: 'gpt-5.4',
  });

  const viaClaude = await request({
    port: proxyPort,
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet', messages: [] }),
  });
  assert.equal(viaClaude.statusCode, 200);
  assert.equal(viaClaude.body.toString(), '{"id":"msg_claude"}');
  assert.deepEqual(calls.at(-1), {
    channel: 'anthropic',
    url: '/messages',
    authorization: undefined,
    apiKeyHeader: 'claude-key',
    model: 'claude-sonnet-4-6',
  });

  const models = await request({ port: proxyPort, path: '/v1/models', method: 'GET' });
  assert.deepEqual(
    JSON.parse(models.body.toString('utf8')).data.map((model) => model.id),
    ['gpt-5.6-sol', 'claude-sonnet'],
  );

  const status = await request({ port: proxyPort, path: '/_mini/status', method: 'GET' });
  const snapshot = JSON.parse(status.body.toString('utf8'));
  assert.deepEqual(snapshot.activeGroups, ['openai', 'claude']);
  assert.equal(snapshot.latest.group, 'claude');
});

test('a request for an endpoint no active channel serves is rejected', async (t) => {
  const openai = http.createServer(() => {
    throw new Error('a channel without the messages endpoint must not be contacted');
  });
  const openaiPort = await listen(openai);
  const proxy = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    groups: {
      openai: {
        upstream: { name: 'oai', baseUrl: `http://127.0.0.1:${openaiPort}/v1`, apiKey: 'oai-key' },
        models: { 'gpt-5.6-sol': 'gpt-5.4' },
        endpoints: ['responses'],
      },
    },
    logging: { enabled: false },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(openai); });

  const result = await request({
    port: proxyPort,
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', messages: [] }),
  });
  assert.equal(result.statusCode, 404);
  assert.equal(JSON.parse(result.body.toString('utf8')).error.type, 'invalid_request_error');
});

test('an ambiguous alias prefers priority order and fails over across groups', async (t) => {
  const models = [];
  const down = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    models.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).model);
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('down');
  });
  const up = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    models.push(JSON.parse(Buffer.concat(chunks).toString('utf8')).model);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"resp_backup"}');
  });
  const downPort = await listen(down);
  const upPort = await listen(up);
  const proxy = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    activeGroups: 'all',
    groups: {
      backup: {
        priority: 1,
        upstream: { name: 'backup', baseUrl: `http://127.0.0.1:${upPort}/v1`, apiKey: '' },
        models: { 'gpt-5.6-sol': 'backup-model' },
        endpoints: ['responses'],
      },
      primary: {
        priority: 100,
        upstream: { name: 'primary', baseUrl: `http://127.0.0.1:${downPort}/v1`, apiKey: '' },
        models: { 'gpt-5.6-sol': 'primary-model' },
        endpoints: ['responses'],
      },
    },
    logging: { enabled: false },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(down); await close(up); });

  const result = await request({
    port: proxyPort,
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.toString(), '{"id":"resp_backup"}');
  // Each channel receives the model name its own mapping defines, not the first channel's.
  assert.deepEqual(models, ['primary-model', 'backup-model']);
});

test('a group-qualified model name pins the request to that channel', async (t) => {
  let received;
  const preferred = http.createServer(() => {
    throw new Error('the qualified group must win over priority order');
  });
  const pinned = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"resp_pinned"}');
  });
  const preferredPort = await listen(preferred);
  const pinnedPort = await listen(pinned);
  const proxy = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    activeGroups: 'all',
    groups: {
      first: {
        priority: 100,
        upstream: { name: 'first', baseUrl: `http://127.0.0.1:${preferredPort}/v1`, apiKey: '' },
        models: { shared: 'first-model' },
        endpoints: ['responses', 'models'],
      },
      second: {
        priority: 1,
        upstream: { name: 'second', baseUrl: `http://127.0.0.1:${pinnedPort}/v1`, apiKey: '' },
        models: { shared: 'second-model' },
        endpoints: ['responses', 'models'],
      },
    },
    logging: { enabled: false },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(preferred); await close(pinned); });

  const result = await request({
    port: proxyPort,
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'second/shared', input: 'hi' }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(received.model, 'second-model');

  // An alias served by more than one channel is also advertised in its qualified form.
  const models = await request({ port: proxyPort, path: '/v1/models', method: 'GET' });
  assert.deepEqual(
    JSON.parse(models.body.toString('utf8')).data.map((model) => model.id),
    ['shared', 'first/shared', 'second/shared'],
  );
});

test('failover happens before downstream headers/body are sent', async (t) => {
  const first = http.createServer((req, res) => {
    res.writeHead(503, { 'content-type': 'text/plain' });
    res.end('first failed');
  });
  const second = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: response.completed\ndata: {"type":"response.completed"}\n\n');
  });
  const firstPort = await listen(first);
  const secondPort = await listen(second);
  const config = makeConfig(firstPort);
  delete config.upstream;
  config.upstreams = [
    { name: 'primary', baseUrl: `http://127.0.0.1:${firstPort}/v1`, apiKey: '', priority: 100 },
    { name: 'secondary', baseUrl: `http://127.0.0.1:${secondPort}/v1`, apiKey: '', priority: 10 },
  ];
  const proxy = createProxyServer(config);
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(first); await close(second); });

  const result = await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi', stream: true }),
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.toString(), 'event: response.completed\ndata: {"type":"response.completed"}\n\n');
});

test('connection failure returns 502 and server can shut down cleanly', async () => {
  const reserved = http.createServer();
  const unusedPort = await listen(reserved);
  await close(reserved);
  const proxy = createProxyServer(makeConfig(unusedPort, {
    logging: { enabled: false },
    timeouts: { connectTimeoutMs: 100 },
  }));
  const proxyPort = await listen(proxy);

  const result = await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });
  assert.equal(result.statusCode, 502);
  const parsed = JSON.parse(result.body.toString('utf8'));
  assert.equal(parsed.error.type, 'upstream_connection_error');
  await new Promise((resolve) => proxy.gracefulShutdown(resolve));
  assert.equal(proxy.listening, false);
});

test('standalone process handles the Ctrl+C/SIGINT shutdown path cleanly', async () => {
  const reserved = http.createServer();
  const port = await listen(reserved);
  await close(reserved);
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-codex-proxy-'));
  const configPath = path.join(tempDirectory, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    host: '127.0.0.1',
    port,
    upstream: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' },
    logging: { enabled: false },
    requestLog: { file: null },
  }));

  const proxyPath = path.join(__dirname, '..', 'proxy.js');
  const script = `const { startFromConfig } = require(${JSON.stringify(proxyPath)});`
    + 'const server = startFromConfig();'
    + "server.once('listening', () => setTimeout(() => process.emit('SIGINT'), 20));";
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, MINI_CODEX_PROXY_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`startup timeout: ${stdout} ${stderr}`)), 2000);
    child.stdout.on('data', () => {
      if (stdout.includes('mini-codex-proxy listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited early with ${code}: ${stdout} ${stderr}`));
    });
  });

  const [code, signal] = await once(child, 'exit');
  fs.rmSync(tempDirectory, { recursive: true, force: true });
  assert.equal(code, 0, `expected exit code 0, got code=${code} signal=${signal}: ${stdout} ${stderr}`);
  assert.match(stdout, /Received SIGINT, shutting down\./);
});

test('cached tokens are folded into the prompt total for both upstream usage shapes', () => {
  // Anthropic reports cache reads alongside input_tokens, so the prompt total is the sum.
  assert.deepEqual(
    normalizeUsage({
      input_tokens: 120,
      cache_read_input_tokens: 880,
      cache_creation_input_tokens: 40,
      output_tokens: 64,
    }),
    { promptTokens: 1040, outputTokens: 64, cacheReadTokens: 880, cacheWriteTokens: 40 },
  );

  // OpenAI already counts cached tokens inside prompt_tokens, so it must not be added twice.
  assert.deepEqual(
    normalizeUsage({
      prompt_tokens: 1000,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 750 },
    }),
    { promptTokens: 1000, outputTokens: 50, cacheReadTokens: 750, cacheWriteTokens: 0 },
  );

  assert.equal(cacheHitRate({ promptTokens: 1000, cacheReadTokens: 750 }), 0.75);
  // A request that reported no prompt tokens has no meaningful ratio.
  assert.equal(cacheHitRate({ promptTokens: 0, cacheReadTokens: 0 }), null);
  assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }), null);
});

test('usage split across Anthropic stream events is merged into one record', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Prompt and cache totals arrive first; output tokens only in the closing delta.
    res.write('event: message_start\n');
    res.write('data: {"type":"message_start","message":{"usage":{"input_tokens":10,'
      + '"cache_read_input_tokens":990,"output_tokens":0}}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":25}}\n\n');
    res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    res.end();
  });
  const upstreamPort = await listen(upstream);
  const proxy = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    groups: {
      claude: {
        upstream: { name: 'anthropic', baseUrl: `http://127.0.0.1:${upstreamPort}`, apiKey: 'k' },
        models: { 'claude-sonnet': 'claude-sonnet-4-6' },
        endpoints: ['messages'],
      },
    },
    logging: { enabled: false },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await request({
    port: proxyPort,
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet', messages: [], stream: true }),
  });

  const logged = await request({ port: proxyPort, path: '/_mini/requests', method: 'GET' });
  const { entries, totals } = JSON.parse(logged.body.toString('utf8'));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].usage, {
    promptTokens: 1000,
    outputTokens: 25,
    cacheReadTokens: 990,
    cacheWriteTokens: 0,
  });
  assert.equal(entries[0].cacheHitRate, 0.99);
  assert.equal(totals.cacheReadTokens, 990);
});

test('the request log separates cache hits from misses and reports per-group totals', async (t) => {
  const warm = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      usage: { prompt_tokens: 400, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 300 } },
    }));
  });
  const cold = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ usage: { prompt_tokens: 200, completion_tokens: 10 } }));
  });
  const warmPort = await listen(warm);
  const coldPort = await listen(cold);
  const proxy = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    activeGroups: 'all',
    groups: {
      warm: {
        upstream: { name: 'warm', baseUrl: `http://127.0.0.1:${warmPort}/v1`, apiKey: 'k' },
        models: { 'gpt-warm': 'gpt-5.4' },
        endpoints: ['responses'],
      },
      cold: {
        upstream: { name: 'cold', baseUrl: `http://127.0.0.1:${coldPort}/v1`, apiKey: 'k' },
        models: { 'gpt-cold': 'gpt-5.4-mini' },
        endpoints: ['responses'],
      },
    },
    logging: { enabled: false },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); await close(warm); await close(cold); });

  const json = { 'content-type': 'application/json' };
  await request({ port: proxyPort, headers: json, body: JSON.stringify({ model: 'gpt-warm', input: 'hi' }) });
  await request({ port: proxyPort, headers: json, body: JSON.stringify({ model: 'gpt-cold', input: 'hi' }) });

  const hits = JSON.parse((await request({
    port: proxyPort, path: '/_mini/requests?cached=hit', method: 'GET',
  })).body.toString('utf8'));
  assert.deepEqual(hits.entries.map((entry) => entry.group), ['warm']);

  const misses = JSON.parse((await request({
    port: proxyPort, path: '/_mini/requests?cached=miss', method: 'GET',
  })).body.toString('utf8'));
  assert.deepEqual(misses.entries.map((entry) => entry.group), ['cold']);

  const stats = JSON.parse((await request({
    port: proxyPort, path: '/_mini/stats', method: 'GET',
  })).body.toString('utf8'));
  assert.equal(stats.overall.requests, 2);
  // 300 cached of 600 total prompt tokens across both channels.
  assert.equal(stats.overall.cacheHitRate, 0.5);
  assert.equal(stats.byGroup.warm.cacheHitRate, 0.75);
  assert.equal(stats.byGroup.cold.cacheHitRate, 0);
  assert.equal(stats.byModel['gpt-warm'].requests, 1);
});

test('the dashboard is served on loopback and rejects remote callers', async (t) => {
  const proxy = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    groups: {
      solo: {
        upstream: { name: 'solo', baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'k' },
        models: { m: 'm2' },
      },
    },
    logging: { enabled: false },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => { await close(proxy); });

  const page = await request({ port: proxyPort, path: '/_mini', method: 'GET' });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.body.toString('utf8'), /mini-codex-proxy/);

  // The dashboard must never be cached; it renders live counters.
  assert.equal(page.headers['cache-control'], 'no-store');

  const unknown = await request({ port: proxyPort, path: '/_mini/nope', method: 'GET' });
  assert.equal(unknown.statusCode, 404);

  // Writes to the local surface are not an API; only GET is meaningful.
  const posted = await request({ port: proxyPort, path: '/_mini/stats', method: 'POST', body: '{}' });
  assert.equal(posted.statusCode, 404);
});

test('a request log file keeps one JSON record per line', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ usage: { prompt_tokens: 90, completion_tokens: 8 } }));
  });
  const upstreamPort = await listen(upstream);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-codex-log-'));
  const file = path.join(directory, 'requests.jsonl');
  const proxy = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    groups: {
      solo: {
        upstream: { name: 'solo', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'k' },
        models: { 'gpt-x': 'gpt-5.4' },
        endpoints: ['responses'],
      },
    },
    requestLog: { enabled: true, file },
    logging: { enabled: false },
  });
  const proxyPort = await listen(proxy);
  t.after(async () => {
    await close(proxy);
    await close(upstream);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  for (let index = 0; index < 3; index += 1) {
    await request({
      port: proxyPort,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-x', input: 'hi' }),
    });
  }

  await new Promise((resolve) => proxy.gracefulShutdown(resolve));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  const parsed = lines.map((line) => JSON.parse(line));
  assert.deepEqual(parsed.map((entry) => entry.seq), [1, 2, 3]);
  assert.equal(parsed[0].usage.promptTokens, 90);
  assert.equal(parsed[0].group, 'solo');

  // A new process must surface the same records in the dashboard, and seq must continue.
  const restarted = createProxyServer({
    host: '127.0.0.1',
    port: 8317,
    groups: {
      solo: {
        upstream: { name: 'solo', baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, apiKey: 'k' },
        models: { 'gpt-x': 'gpt-5.4' },
        endpoints: ['responses'],
      },
    },
    requestLog: { enabled: true, file },
    logging: { enabled: false },
  });
  const restartedPort = await listen(restarted);
  t.after(async () => { await close(restarted); });

  const restored = JSON.parse((await request({
    port: restartedPort, path: '/_mini/requests', method: 'GET',
  })).body.toString('utf8'));
  assert.equal(restored.total, 3);
  assert.deepEqual(restored.entries.map((entry) => entry.seq), [3, 2, 1]);
  assert.equal(restored.entries[0].usage.promptTokens, 90);

  await request({
    port: restartedPort,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-x', input: 'hi' }),
  });
  await new Promise((resolve) => restarted.gracefulShutdown(resolve));
  const after = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(after.length, 4);
  assert.equal(after[3].seq, 4);
});

test('request logging persists to logs/requests.jsonl unless file is set to null', () => {
  const base = {
    host: '127.0.0.1',
    port: 8317,
    upstream: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' },
  };
  const defaults = validateAndNormalizeConfig(base);
  assert.equal(defaults.requestLog.file, path.resolve(__dirname, '..', 'logs', 'requests.jsonl'));

  const off = validateAndNormalizeConfig({ ...base, requestLog: { enabled: false } });
  assert.equal(off.requestLog.file, null);

  const memoryOnly = validateAndNormalizeConfig({ ...base, requestLog: { file: null } });
  assert.equal(memoryOnly.requestLog.file, null);
});

test('several named client keys authorize, and a disabled key is refused', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { prompt_tokens: 10, completion_tokens: 2 } }));
  });
  const upstreamPort = await listen(upstream);
  const proxyServer = createProxyServer(makeConfig(upstreamPort, {
    clientApiKey: undefined,
    clientApiKeys: [
      { name: 'laptop', key: 'sk-laptop', enabled: true },
      { name: 'ci', key: 'sk-ci', enabled: false },
    ],
  }));
  const proxyPort = await listen(proxyServer);
  t.after(async () => { await close(proxyServer); await close(upstream); });

  const call = (key, header = 'authorization') => request({
    port: proxyPort,
    headers: {
      'content-type': 'application/json',
      [header]: header === 'authorization' ? `Bearer ${key}` : key,
    },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });

  assert.equal((await call('sk-laptop')).statusCode, 200);
  // Anthropic-style clients present the key in x-api-key instead.
  assert.equal((await call('sk-laptop', 'x-api-key')).statusCode, 200);
  assert.equal((await call('sk-ci')).statusCode, 401);
  assert.equal((await call('sk-nope')).statusCode, 401);

  const logged = await request({ port: proxyPort, path: '/_mini/requests', method: 'GET' });
  const entries = JSON.parse(logged.body.toString('utf8')).entries;
  const names = entries.filter((entry) => entry.status === 200).map((entry) => entry.apiKeyName);
  assert.deepEqual(names, ['laptop', 'laptop']);
});

test('a legacy single clientApiKey string still authorizes', () => {
  const config = validateAndNormalizeConfig({
    host: '127.0.0.1',
    port: 8317,
    upstream: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' },
    clientApiKey: 'legacy-key',
  });
  assert.deepEqual(config.clientApiKeys, [
    { name: 'default', key: 'legacy-key', enabled: true, note: '' },
  ]);
});

test('log filters combine and honour date presets and explicit windows', () => {
  const now = Date.parse('2026-03-10T12:00:00Z');
  const presets = proxy.parseLogFilters(
    new URLSearchParams('range=7d&group=a&model=m&apiKey=k'),
    now,
  );
  assert.equal(presets.group, 'a');
  assert.equal(presets.model, 'm');
  assert.equal(presets.apiKey, 'k');
  assert.equal(presets.since, now - 7 * 86400000);

  const month = proxy.parseLogFilters(new URLSearchParams('range=30d'), now);
  assert.equal(month.since, now - 30 * 86400000);

  // An explicit window always wins over the preset.
  const explicit = proxy.parseLogFilters(
    new URLSearchParams('range=30d&since=2026-03-01T00:00:00Z&until=2026-03-02T00:00:00Z'),
    now,
  );
  assert.equal(explicit.since, Date.parse('2026-03-01T00:00:00Z'));
  assert.equal(explicit.until, Date.parse('2026-03-02T00:00:00Z'));

  assert.equal(proxy.parseLogFilters(new URLSearchParams(''), now).since, undefined);
});

test('a date range reaching past the memory cache is served from the jsonl history', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-proxy-range-'));
  const file = path.join(dir, 'requests.jsonl');
  const now = Date.now();
  const rows = [];
  // Older than the in-memory limit below, so these can only come from the file.
  for (let i = 0; i < 12; i += 1) {
    rows.push({
      seq: i + 1,
      id: `id-${i}`,
      at: new Date(now - (40 - i) * 86400000).toISOString(),
      group: i % 2 ? 'beta' : 'alpha',
      model: 'gpt-test',
      apiKeyName: i % 2 ? 'ci' : 'laptop',
      status: 200,
      failed: false,
      usage: {
        promptTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0,
      },
    });
  }
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const proxyServer = createProxyServer(makeConfig(upstreamPort, {
    requestLog: { enabled: true, limit: 3, file },
  }));
  const proxyPort = await listen(proxyServer);
  t.after(async () => { await close(proxyServer); await close(upstream); });

  const query = async (params = '') => JSON.parse((await request({
    port: proxyPort, path: `/_mini/requests?${params}`, method: 'GET',
  })).body.toString('utf8'));

  // Only the newest 3 entries live in memory.
  assert.equal((await query('')).total, 3);
  const since = new Date(now - 45 * 86400000).toISOString();
  assert.equal((await query(`since=${since}`)).matched, 12);
  assert.equal((await query(`since=${since}&group=alpha&apiKey=laptop`)).matched, 6);

  // offset windows the newest-first result set and clamps past the end.
  const page = await query(`since=${since}&limit=5&offset=5`);
  assert.equal(page.matched, 12);
  assert.equal(page.offset, 5);
  assert.equal(page.limit, 5);
  assert.deepEqual(page.entries.map((entry) => entry.seq), [7, 6, 5, 4, 3]);

  const beyond = await query(`since=${since}&limit=5&offset=99`);
  assert.equal(beyond.offset, 12);
  assert.deepEqual(beyond.entries, []);

  // A malformed offset falls back to the first page.
  assert.equal((await query(`since=${since}&limit=5&offset=-3`)).offset, 0);
  assert.equal((await query(`since=${since}&limit=5&offset=abc`)).offset, 0);
});

test('dashboard config edits hot-apply, persist, and never expose secrets', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-proxy-config-'));
  const file = path.join(dir, 'config.json');
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [{ id: 'real-a' }, { id: 'real-b' }] }));
  });
  const upstreamPort = await listen(upstream);
  const raw = {
    host: '127.0.0.1',
    port: 8317,
    groups: {
      alpha: {
        upstream: {
          name: 'alpha',
          baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
          apiKey: 'sk-alpha-secret',
        },
        models: { 'gpt-test': 'real-a' },
        endpoints: ['responses', 'chat', 'models'],
      },
    },
    activeGroups: ['alpha'],
    clientApiKeys: [{ name: 'laptop', key: 'sk-laptop', enabled: true }],
    requestLog: { file: null },
    keepThis: 'untouched',
  };
  fs.writeFileSync(file, JSON.stringify(raw));
  const proxyServer = proxy.createProxyServer(raw, { configFile: file, log() {} });
  const proxyPort = await listen(proxyServer);
  t.after(async () => { await close(proxyServer); await close(upstream); });

  const post = (target, body) => request({
    port: proxyPort,
    path: target,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const readDisk = () => JSON.parse(fs.readFileSync(file, 'utf8'));

  const viewed = await request({ port: proxyPort, path: '/_mini/config', method: 'GET' });
  const view = viewed.body.toString('utf8');
  assert.equal(JSON.parse(view).groups[0].upstreams[0].hasApiKey, true);
  assert.ok(!view.includes('sk-alpha-secret'));
  assert.ok(!view.includes('sk-laptop'));

  const pulled = await post('/_mini/config/models', { name: 'alpha' });
  assert.deepEqual(JSON.parse(pulled.body.toString('utf8')).models, ['real-a', 'real-b']);

  // An empty apiKey means "keep the stored secret".
  const saved = await post('/_mini/config', {
    action: 'saveChannel',
    payload: {
      name: 'alpha',
      baseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
      apiKey: '',
      priority: 5,
      enabled: true,
      endpoints: ['responses', 'chat', 'models'],
    },
  });
  assert.equal(saved.statusCode, 200);
  assert.equal(readDisk().groups.alpha.upstream.apiKey, 'sk-alpha-secret');
  assert.equal(readDisk().groups.alpha.priority, 5);
  assert.deepEqual(readDisk().groups.alpha.endpoints, ['responses', 'chat', 'models']);
  assert.equal(readDisk().keepThis, 'untouched');

  await post('/_mini/config', {
    action: 'saveModels',
    payload: { name: 'alpha', models: { alias: 'real-b' } },
  });
  assert.deepEqual(readDisk().groups.alpha.models, { alias: 'real-b' });

  // The new mapping must route without a restart.
  const routed = await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-laptop' },
    body: JSON.stringify({ model: 'alias', input: 'hi' }),
  });
  assert.equal(routed.statusCode, 200);

  await post('/_mini/config', {
    action: 'saveClientKeys',
    payload: {
      keys: [
        { name: 'laptop', key: '', enabled: false },
        { name: 'phone', key: 'sk-phone', enabled: true },
      ],
    },
  });
  assert.equal(readDisk().clientApiKeys.find((k) => k.name === 'laptop').key, 'sk-laptop');
  const refused = await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-laptop' },
    body: JSON.stringify({ model: 'alias', input: 'hi' }),
  });
  assert.equal(refused.statusCode, 401);
});

test('an invalid config edit is rejected and leaves the running proxy untouched', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const proxyServer = createProxyServer(makeConfig(upstreamPort), { log() {} });
  const proxyPort = await listen(proxyServer);
  t.after(async () => { await close(proxyServer); await close(upstream); });

  const post = (body) => request({
    port: proxyPort,
    path: '/_mini/config',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const badUrl = await post({
    action: 'saveChannel',
    payload: { name: 'broken', baseUrl: 'not-a-url' },
  });
  assert.equal(badUrl.statusCode, 400);
  assert.equal((await post({ action: 'launchMissiles', payload: {} })).statusCode, 400);
  assert.equal((await post({ action: 'deleteChannel', payload: { name: '' } })).statusCode, 400);

  // The rejected edits must not have disturbed routing.
  const still = await request({
    port: proxyPort,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.6-sol', input: 'hi' }),
  });
  assert.equal(still.statusCode, 200);
});

test('config edits are not persisted unless a configFile is supplied', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const upstreamPort = await listen(upstream);
  const proxyServer = createProxyServer(makeConfig(upstreamPort), { log() {} });
  const proxyPort = await listen(proxyServer);
  t.after(async () => { await close(proxyServer); await close(upstream); });

  const before = fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8');
  const saved = await request({
    port: proxyPort,
    path: '/_mini/config',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      action: 'saveModels',
      payload: { name: 'default', models: { alias: 'gpt-5.4' } },
    }),
  });
  assert.equal(saved.statusCode, 200);
  // The repository config.json must be untouched when no configFile was given.
  assert.equal(fs.readFileSync(path.resolve(__dirname, '..', 'config.json'), 'utf8'), before);
});

test('config mutations preserve unrelated groups and keep activeGroups consistent', () => {
  const raw = {
    groups: {
      a: { upstream: { baseUrl: 'https://a.test/v1' }, models: {} },
      b: { upstream: { baseUrl: 'https://b.test/v1' }, models: {} },
    },
    activeGroups: ['a', 'b'],
  };

  const disabled = proxy.applyConfigMutation(raw, 'toggleChannel', { name: 'b', enabled: false });
  assert.deepEqual(disabled.activeGroups, ['a']);
  assert.deepEqual(Object.keys(disabled.groups), ['a', 'b']);

  const removed = proxy.applyConfigMutation(raw, 'deleteChannel', { name: 'a' });
  assert.deepEqual(Object.keys(removed.groups), ['b']);
  assert.deepEqual(removed.activeGroups, ['b']);

  assert.throws(
    () => proxy.applyConfigMutation(raw, 'saveModels', { name: 'nope', models: {} }),
    /Unknown channel/,
  );
  assert.throws(
    () => proxy.applyConfigMutation(raw, 'saveChannel', { name: 'has/slash' }),
    /must not contain/,
  );
});

test('pricing bills cache reads and writes apart from plain input tokens', () => {
  const pricing = proxy.normalizePricing({ models: { 'test-model': { input: 15, output: 75 } } });
  const usage = { promptTokens: 3880, outputTokens: 145, cacheReadTokens: 0, cacheWriteTokens: 3878 };
  const entry = { model: 'test-model', mappedModel: 'test-model', usage };
  // 2 plain input at $15/M + 3878 cache-write at 1.25x input + 145 output at $75/M.
  assert.equal(proxy.costOfEntry(entry, pricing), (2 * 15 + 3878 * 18.75 + 145 * 75) / 1e6);

  const read = { promptTokens: 2000, outputTokens: 0, cacheReadTokens: 2000, cacheWriteTokens: 0 };
  assert.equal(proxy.costOfEntry({ model: 'test-model', usage: read }, pricing), (2000 * 1.5) / 1e6);
});

test('config pricing overrides built-ins, supports prefix wildcards, and prefers the upstream name', () => {
  const pricing = proxy.normalizePricing({
    currency: 'CNY',
    models: {
      'claude-opus-5': { input: 1, output: 2 },
      'acme-*': { input: 4, output: 8 },
    },
  });
  assert.equal(pricing.currency, 'CNY');
  assert.equal(proxy.matchPrice(pricing, 'claude-opus-5').input, 1);
  // Models the overlay does not mention keep their built-in rate.
  assert.equal(proxy.matchPrice(pricing, 'claude-sonnet-5').input, 2);
  assert.equal(proxy.matchPrice(pricing, 'acme-pro-2').output, 8);
  assert.equal(proxy.matchPrice(pricing, 'nothing-known'), null);

  const usage = { promptTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const entry = { model: 'acme-pro-2', mappedModel: 'claude-opus-5', usage };
  assert.equal(proxy.costOfEntry(entry, pricing), 1);
});

test('unpriced models and missing usage report null cost rather than zero', () => {
  const pricing = proxy.normalizePricing({ models: {} });
  const usage = { promptTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
  assert.equal(proxy.costOfEntry({ model: 'mystery-model', usage }, pricing), null);
  assert.equal(proxy.costOfEntry({ model: 'claude-opus-5', usage: null }, pricing), null);

  const totals = proxy.summarizeUsage([
    { model: 'claude-opus-5', usage: { promptTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    { model: 'mystery-model', usage },
    { model: 'claude-opus-5', usage: null },
  ], pricing);
  assert.equal(totals.requests, 2);
  assert.equal(totals.pricedRequests, 1);
  assert.equal(totals.unpricedRequests, 1);
  assert.equal(totals.cost, 5);
});

const MILLION = 1e6;

function assertClose(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}：期望 ${expected}，实际 ${actual}`);
}

// 按面板的口径结算单条请求，并报出四个费用分量，让每个用例都写清缓存输入与普通输入
// 是怎么拆的。期望值一律写成字面算式、不从 proxy.js 反推；但 total_cost 仍取自生产代码，
// 所以 entryCost 一旦走样用例就会失败。
function bill(t, model, usage, expected) {
  const pricing = proxy.normalizePricing({ models: {} });
  const normalized = normalizeUsage(usage);
  const spec = proxy.matchPrice(pricing, model);
  const rate = spec.longContext && normalized.promptTokens >= spec.longContext.threshold
    ? spec.longContext
    : spec;
  const inputTokens = normalized.promptTokens
    - normalized.cacheReadTokens
    - normalized.cacheWriteTokens;
  const actual = {
    input_cost: inputTokens * rate.input / MILLION,
    cached_input_cost: normalized.cacheReadTokens * rate.cacheRead / MILLION,
    output_cost: normalized.outputTokens * rate.output / MILLION,
    total_cost: proxy.costOfEntry({ model, usage: normalized }, pricing),
  };
  t.diagnostic(`${model} prompt=${normalized.promptTokens}`
    + ` cached=${normalized.cacheReadTokens} output=${normalized.outputTokens}`
    + ` -> input_cost=${actual.input_cost} cached_input_cost=${actual.cached_input_cost}`
    + ` output_cost=${actual.output_cost} total_cost=${actual.total_cost}`);
  for (const [key, value] of Object.entries(expected)) {
    assertClose(actual[key], value, `${model} ${key}`);
  }
  return normalized;
}

test('grok-4.6 普通上下文、无缓存：只计普通输入与输出', (t) => {
  bill(t, 'grok-4.6', { prompt_tokens: 100000, completion_tokens: 500 }, {
    input_cost: 100000 * 2 / MILLION,
    cached_input_cost: 0,
    output_cost: 500 * 6 / MILLION,
    total_cost: 0.203,
  });
});

test('grok-4.6 普通上下文：缓存读按 $0.50、其余输入按 $2', (t) => {
  bill(t, 'grok-4.6', {
    prompt_tokens: 100000,
    completion_tokens: 500,
    prompt_tokens_details: { cached_tokens: 80000 },
  }, {
    input_cost: 20000 * 2 / MILLION,
    cached_input_cost: 80000 * 0.5 / MILLION,
    output_cost: 500 * 6 / MILLION,
    total_cost: 0.083,
  });

  // 同样的拆分也可能由厂商专属的缓存字段名给出。
  bill(t, 'grok-4.6', {
    prompt_tokens: 100000,
    completion_tokens: 0,
    prompt_cache_hit_tokens: 80000,
  }, {
    input_cost: 20000 * 2 / MILLION,
    cached_input_cost: 80000 * 0.5 / MILLION,
    output_cost: 0,
    total_cost: 0.08,
  });
});

test('grok-4.6 长上下文、无缓存：整条请求切到 $4 / $12 档', (t) => {
  bill(t, 'grok-4.6', { prompt_tokens: 250000, completion_tokens: 100 }, {
    input_cost: 250000 * 4 / MILLION,
    cached_input_cost: 0,
    output_cost: 100 * 12 / MILLION,
    total_cost: 1.0012,
  });
});

test('grok-4.6 长上下文：缓存读按 $1、其余输入按 $4', (t) => {
  bill(t, 'grok-4.6', {
    prompt_tokens: 300000,
    completion_tokens: 1000,
    prompt_tokens_details: { cached_tokens: 250000 },
  }, {
    input_cost: 50000 * 4 / MILLION,
    cached_input_cost: 250000 * 1 / MILLION,
    output_cost: 1000 * 12 / MILLION,
    total_cost: 0.462,
  });
});

test('grok-4.6 长上下文：缓存读几乎覆盖整个 prompt', (t) => {
  bill(t, 'grok-4.6', {
    prompt_tokens: 250000,
    completion_tokens: 10,
    prompt_tokens_details: { cached_tokens: 249000 },
  }, {
    input_cost: 1000 * 4 / MILLION,
    cached_input_cost: 249000 * 1 / MILLION,
    output_cost: 10 * 12 / MILLION,
    total_cost: 0.25312,
  });
});

test('grok-4.6 上游未返回 cached token 时，整个 prompt 按普通输入计价', (t) => {
  const usage = bill(t, 'grok-4.6', {
    prompt_tokens: 200000,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 0 },
  }, {
    input_cost: 200000 * 4 / MILLION,
    cached_input_cost: 0,
    output_cost: 0,
    total_cost: 0.8,
  });
  assert.equal(usage.cacheReadTokens, 0);
});

test('grok-4.6 在正好 200,000 个 prompt token 处切换档位', (t) => {
  bill(t, 'grok-4.6', { prompt_tokens: 199999, completion_tokens: 0 }, {
    input_cost: 199999 * 2 / MILLION,
    cached_input_cost: 0,
    output_cost: 0,
    total_cost: 0.399998,
  });
  bill(t, 'grok-4.6', { prompt_tokens: 200000, completion_tokens: 0 }, {
    input_cost: 200000 * 4 / MILLION,
    cached_input_cost: 0,
    output_cost: 0,
    total_cost: 0.8,
  });
});

test('grok-4.6 多条请求各自计价后再累加', () => {
  const pricing = proxy.normalizePricing({ models: {} });
  const entries = [
    {
      model: 'grok-4.6',
      usage: normalizeUsage({
        prompt_tokens: 554000,
        completion_tokens: 3490,
        prompt_tokens_details: { cached_tokens: 536000 },
      }),
    },
    {
      model: 'grok-4.6',
      usage: normalizeUsage({ prompt_tokens: 1000, completion_tokens: 100 }),
    },
  ];
  const totals = proxy.summarizeUsage(entries, pricing);
  assert.equal(totals.requests, 2);
  assert.equal(totals.pricedRequests, 2);
  assert.equal(totals.unpricedRequests, 0);
  assertClose(totals.cost, 0.64988 + (1000 * 2 + 100 * 6) / MILLION, '累加费用');
  // 把两条请求并成一组、按单一价算，会漏掉长上下文那条的高档价。
  assertClose(totals.cost, 0.65248, '单一价汇总');
});

test('554k / 536k / 3.49k 这条 grok-4.6 请求计费 $0.64988', (t) => {
  const usage = bill(t, 'grok-4.6', {
    prompt_tokens: 554000,
    completion_tokens: 3490,
    prompt_tokens_details: { cached_tokens: 536000 },
  }, {
    input_cost: 18000 * 4 / MILLION,
    cached_input_cost: 536000 * 1 / MILLION,
    output_cost: 3490 * 12 / MILLION,
    total_cost: 0.64988,
  });
  assert.equal(usage.promptTokens, 554000);
  assert.equal(usage.cacheReadTokens, 536000);
  assert.equal((usage.promptTokens - usage.cacheReadTokens), 18000);
  // 面板把命中率保留一位小数，所以 96.75% 显示成 96.8%。
  assert.equal((cacheHitRate(usage) * 100).toFixed(1), '96.8');
});

test('缓存桶大于 prompt 时被钳制，不会重复计费', () => {
  const usage = normalizeUsage({
    prompt_tokens: 1000,
    completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 5000 },
  });
  assert.equal(usage.cacheReadTokens, 1000);
  const pricing = proxy.normalizePricing({ models: {} });
  assertClose(
    proxy.costOfEntry({ model: 'grok-4.6', usage }, pricing),
    1000 * 0.5 / MILLION,
    '钳制后费用',
  );
});

test('longContext 阶梯在加载配置时校验', () => {
  const pricing = proxy.normalizePricing({
    models: {
      'tiered-*': {
        input: 1,
        output: 2,
        longContext: { threshold: 100, input: 3, output: 4, cacheRead: 0.5 },
      },
    },
  });
  const spec = proxy.matchPrice(pricing, 'tiered-pro');
  assert.equal(spec.input, 1);
  assert.equal(spec.longContext.threshold, 100);
  assert.equal(spec.longContext.input, 3);
  assert.equal(spec.longContext.cacheRead, 0.5);
  assert.equal(spec.longContext.longContext, null);
  // 没有配阶梯的模型，任何 prompt 大小都走基础档。
  assert.equal(proxy.matchPrice(pricing, 'claude-opus-5').longContext, null);

  assert.throws(
    () => proxy.normalizePricing({ models: { x: { input: 1, longContext: { input: 2 } } } }),
    /longContext\.threshold/,
  );
  assert.throws(
    () => proxy.normalizePricing({ models: { x: { input: 1, longContext: [] } } }),
    /longContext must be an object/,
  );
  assert.throws(
    () => proxy.normalizePricing({ models: { x: { input: 1, longContext: { threshold: -1, input: 2 } } } }),
    /longContext\.threshold/,
  );
});

test('invalid pricing entries are rejected while loading config', () => {
  const base = {
    host: '127.0.0.1',
    port: 8317,
    upstream: { baseUrl: 'http://127.0.0.1:9/v1', apiKey: '' },
  };
  assert.equal(validateAndNormalizeConfig(base).pricing.currency, 'USD');
  assert.throws(
    () => validateAndNormalizeConfig({ ...base, pricing: { models: { x: { input: -1 } } } }),
    /Invalid pricing\.models/,
  );
  assert.throws(
    () => validateAndNormalizeConfig({ ...base, pricing: { models: { x: {} } } }),
    /needs an "input" or "output" price/,
  );
  assert.throws(
    () => validateAndNormalizeConfig({ ...base, pricing: { models: { x: 'free' } } }),
    /must be an object/,
  );
  assert.throws(
    () => validateAndNormalizeConfig({ ...base, pricing: { cacheReadMultiplier: -1 } }),
    /Invalid pricing\.cacheReadMultiplier/,
  );
});
