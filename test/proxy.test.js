'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { once } = require('node:events');
const { createProxyServer } = require('../proxy');

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
    logging: { enabled: true },
    timeouts: { connectTimeoutMs: 1000 },
    debug: false,
    ...overrides,
  };
}

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
