# mini-codex-proxy

一个面向 Codex CLI 的 Windows 本地轻量级 OpenAI Responses API 中转代理。

核心行为只有两点：

- 请求方向：读取 JSON 后仅按 `config.json` 修改顶层 `model`，其他字段原样保留。
- 响应方向：Responses 响应不解析、不重组、不缓存，收到上游响应后直接用 Node.js 流管道转发给客户端。

项目只有 Node.js 内置模块依赖，不使用 Express、Axios、数据库、Redis 或 Docker。

## 环境要求

- Windows 10/11
- Node.js 18 或更高版本，推荐 Node.js 22 LTS
- PowerShell 7（推荐）

检查版本：

```powershell
node --version
npm --version
```

## 安装

进入项目目录：

```powershell
Set-Location D:\dev\mini-codex-proxy
Copy-Item .\config.example.json .\config.json -Force
```

项目没有第三方运行时依赖，因此无需执行 `npm install`。

编辑 `config.json`，填入真实上游地址和 API Key：

```json
{
  "host": "127.0.0.1",
  "port": 8317,
  "upstream": {
    "name": "naiccc",
    "baseUrl": "https://example.com/v1",
    "apiKey": "sk-your-upstream-key"
  },
  "clientApiKey": "your-own-local-key",
  "forwardClientAuthorization": false,
  "models": {
    "gpt-5.6-luna": "gpt-5.4-mini"
  },
  "injectMappedModels": true,
  "logging": {
    "enabled": true
  },
  "progress": {
    "enabled": true,
    "color": true,
    "refreshIntervalMs": 100
  },
  "timeouts": {
    "connectTimeoutMs": 30000
  },
  "debug": false
}
```

`config.json` 已加入 `.gitignore`，避免意外提交 API Key。`config.example.json` 不应放真实密钥。

## 启动

以下两个命令等价：

```powershell
node .\proxy.js
```

```powershell
npm start
```

默认监听：

```text
http://127.0.0.1:8317
```

按 `Ctrl+C` 可正常关闭本地监听和现有连接。

如需临时指定其他配置文件：

```powershell
$env:MINI_CODEX_PROXY_CONFIG = 'D:\secure\mini-codex-proxy.json'
node .\proxy.js
```

## Codex CLI 配置

Codex 的用户配置通常位于：

```text
%USERPROFILE%\.codex\config.toml
```

增加一个自定义 Responses provider：

```toml
model = "gpt-5.6-sol"
model_provider = "mini_codex_proxy"

[model_providers.mini_codex_proxy]
name = "mini-codex-proxy"
base_url = "http://127.0.0.1:8317/v1"
wire_api = "responses"
env_key = "MINI_CODEX_PROXY_CLIENT_KEY"
```

PowerShell 中设置客户端侧占位 Key：

```powershell
$env:MINI_CODEX_PROXY_CLIENT_KEY = 'your-own-local-key'
codex --model gpt-5.6-luna
```

`clientApiKey` 是 mini-codex-proxy 对客户端提供的统一 Key。Codex 或 CC Switch 必须通过以下请求头提交相同的值：

```text
Authorization: Bearer your-own-local-key
```

认证通过后，代理不会把 `clientApiKey` 发给上游，而是改用 `upstream.apiKey` 请求 naiccc。Key 缺失或不匹配时返回 `401`。

设置 `clientApiKey` 后，建议保持 `forwardClientAuthorization=false`。只有不设置 `clientApiKey` 时，`forwardClientAuthorization=true` 才会直接把客户端 Authorization 透传给上游。

客户端请求 `gpt-5.6-luna` 时，上游实际收到：

```text
gpt-5.6-luna -> gpt-5.4-mini
```

### CC Switch 配置

在 CC Switch 的 Codex Provider 中填写：

```text
Base URL: http://127.0.0.1:8317/v1
API Key:  与 config.json 的 clientApiKey 完全一致
Model:    gpt-5.6-luna
API 类型: Responses
```

naiccc 的真实 Key 只保存在 mini-codex-proxy 的 `upstream.apiKey` 中，不需要填入 CC Switch。

## 支持的接口

- `POST /v1/responses`
- `POST /responses`
- `GET /v1/models`
- `GET /models`

代理不会把 Responses 转换为 Chat Completions，也不提供 `/v1/chat/completions`。

## Responses 流式透传

Responses 接口的请求体需要读取一次，因为代理必须找到并替换顶层 `model`。成功解析 JSON 后，只执行：

```js
body.model = configuredMapping[body.model] ?? body.model;
```

`input`、`instructions`、`tools`、`reasoning`、`include`、`metadata`、`previous_response_id`、未来新增字段等都不做删减或转换。

响应方向不解析 SSE。代码在收到上游状态码和响应头后直接执行流式管道，事件正文不会经过 JSON 解析或重新拼接。因此以下事件以及 `<thinking>...</thinking>` 文本都按上游内容转发：

- `response.reasoning_summary_text.delta`
- `response.reasoning_text.delta`
- `response.output_text.delta`
- `response.function_call_arguments.delta`
- `response.completed`
- `response.failed`
- `[DONE]`

代理会移除 HTTP hop-by-hop headers，让 Node.js 为客户端连接正确生成传输分块；SSE body 字节不会被代理修改。不会设置 30 秒或 60 秒总响应超时，已建立的长时间 reasoning/SSE 请求可以持续运行。

`debug=true` 时，代理会旁路观察是否出现 `response.completed`、`response.failed` 和 `[DONE]`。观察器只读数据块，不改变也不重新生成事件。

## 模型列表

`GET /v1/models` 默认转发到上游。`injectMappedModels=true` 时，代理只对这个模型列表接口缓冲并解析成功的 JSON 响应，然后把 `models` 中的 alias 追加到 `data` 数组。

Responses 接口不受该逻辑影响，永远不会为模型注入而缓冲。

## 日志

### 实时彩色状态条

在独立终端运行代理时，会显示一条实时刷新的彩色状态行：

```text
⠹ | #a81f90c2 | POST | /v1/responses | gpt-5.6-luna→gpt-5.4-mini | naiccc | 200 | ↑ 18.2 KB | ↓ 46.8 KB | 首包 0.42s | 首字 1.73s | 已用 6.21s
```

请求完成后，状态行会固定为汇总：

```text
✓ | #a81f90c2 | POST | /v1/responses | gpt-5.6-luna→gpt-5.4-mini | naiccc | 200 | ↑ 18.2 KB | ↓ 83.4 KB | 首包 0.42s | 首字 1.73s | 总耗时 8.31s
```

- `↑`：客户端请求体的原始字节数。
- `↓`：从上游收到并转发的响应字节数。
- `首包`：从请求进入代理到收到首个上游响应数据块。
- `首字`：首次观察到 `response.output_text.delta` 事件；没有文本输出时显示 `--`。
- `总耗时`：请求进入代理到响应结束或连接关闭。

配置项：

```json
"progress": {
  "enabled": true,
  "color": true,
  "refreshIntervalMs": 100
}
```

`refreshIntervalMs` 可设置为 `50` 到 `5000` 毫秒。将 `color` 设为 `false` 可关闭颜色；设置环境变量 `NO_COLOR` 也会关闭颜色。输出被重定向到文件或终端不支持 TTY 时，程序会自动退化为普通单行日志。

状态统计仅旁路观察数据块和 SSE 事件名称，不输出正文，也不会解析、重组或修改传给 Codex 的响应流。建议让代理和 Codex 分别运行在两个终端中。

### 普通日志

示例：

```text
2026-08-12 15:20:01 POST /v1/responses model=gpt-5.6-sol->gpt-5.4 upstream=naiccc:200 duration=8.31s bytes=12450 stream=true
```

日志只包含方法、路径、模型映射、上游名与状态、耗时、请求体字节数和 `stream` 标志。

日志不会包含：

- Authorization 或 API Key
- prompt、`input`、`instructions`
- `tools` 内容
- SSE 正文

## 可选故障切换

第一版已经支持简单的优先级故障切换。把单个 `upstream` 改为：

```json
{
  "upstreams": [
    {
      "name": "naiccc",
      "baseUrl": "https://primary.example.com/v1",
      "apiKey": "sk-primary",
      "priority": 100
    },
    {
      "name": "sixoner",
      "baseUrl": "https://secondary.example.com/v1",
      "apiKey": "sk-secondary",
      "priority": 10
    }
  ]
}
```

只有连接失败或上游返回 `502`、`503`、`520`、`524` 时才尝试下一项。切换发生在代理尚未向客户端发送响应头和响应 body 之前；SSE 一旦开始发送，绝不会中途切换。

## 安全说明

- 默认只监听 `127.0.0.1`。
- 建议设置一个不易猜测的 `clientApiKey`，不要使用示例值。
- `clientApiKey` 与 `upstream.apiKey` 用途不同：前者验证本地客户端，后者认证上游。
- 不要把带真实 API Key 的 `config.json` 提交到 Git 或发给他人。
- 如果把 `host` 改为 `0.0.0.0` 或 `::`，程序会输出网络暴露警告。
- 这个代理本身不提供用户认证、限流或公网防护，不建议直接暴露到局域网或互联网。

## 常见错误

### `config.json not found`

确认项目目录存在配置：

```powershell
Copy-Item .\config.example.json .\config.json
```

### `Missing upstream.baseUrl`

检查 `upstream.baseUrl` 是否存在，或使用非空的 `upstreams` 数组。

### `Invalid port`

`port` 必须是 `1` 到 `65535` 的整数。

### 返回 502

代理未能在 `connectTimeoutMs` 内连接上游，或者连接被拒绝。检查上游 URL、DNS、网络、TLS 和代理软件设置。

### 上游返回 401/403

如果错误来自 mini-codex-proxy，检查 CC Switch 的 API Key 是否与 `clientApiKey` 完全一致。如果错误来自上游，检查 `upstream.apiKey`。上游已经返回的错误状态码和 body 会原样转发，不会被统一包装。

### Codex 无法使用模型名

确认：

- Codex `base_url` 是 `http://127.0.0.1:8317/v1`
- `wire_api = "responses"`
- `model_provider` 指向自定义 provider id
- `models` 中存在需要的 alias
- 本地代理控制台中能看到对应请求日志

## 自测

运行：

```powershell
npm test
```

测试会启动本地模拟上游，不需要真实 API Key，也不会访问真实模型服务。覆盖模型映射、字段保留、统一 Key 验证、上游 Authorization、非流式响应、分块 SSE、reasoning/tool/completed 事件、错误透传、模型注入、故障切换、日志脱敏、502 和正常关闭。
