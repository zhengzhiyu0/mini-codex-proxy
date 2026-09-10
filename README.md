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
  "activeGroups": ["openai", "claude"],
  "groups": {
    "openai": {
      "priority": 100,
      "upstream": {
        "name": "openai-gateway",
        "baseUrl": "https://example.com/v1",
        "apiKey": "sk-your-upstream-key"
      },
      "models": {
        "gpt-5.6-luna": "gpt-5.4-mini"
      },
      "endpoints": ["responses", "chat", "models"],
      "injectMappedModels": true
    },
    "claude": {
      "priority": 90,
      "upstream": {
        "name": "anthropic",
        "baseUrl": "https://api.anthropic.com",
        "apiKey": "sk-ant-your-key",
        "authStyle": "x-api-key"
      },
      "models": {
        "claude-sonnet": "claude-sonnet-4-6"
      },
      "endpoints": ["messages", "models"]
    }
  },
  "clientApiKey": "your-own-local-key",
  "forwardClientAuthorization": false,
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

启动日志会带上所有已启用的组名：

```text
mini-codex-proxy listening on http://127.0.0.1:8317 (groups=openai,claude)
```

临时改变启用范围不必改 `config.json`：

```powershell
$env:MINI_CODEX_PROXY_GROUPS = 'openai,claude'
node .\proxy.js
```

只启用一个渠道，或启用全部：

```powershell
$env:MINI_CODEX_PROXY_GROUPS = 'claude'
$env:MINI_CODEX_PROXY_GROUPS = 'all'
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

- `POST /v1/responses`、`POST /responses`
- `POST /v1/messages`、`POST /messages`
- `POST /v1/chat/completions`、`POST /chat/completions`
- `GET /v1/models`、`GET /models`

代理不做协议转换：Responses 不会被改写成 Chat Completions，Anthropic Messages 也不会被改写成 Responses。每个接口按原样转发到支持它的渠道，只替换顶层 `model`。

用 `endpoints` 限定每组接受哪些接口，就能把 OpenAI 渠道和 Claude 渠道挂在同一个端口上。

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

## 配置组（多渠道同时启用）

`groups` 用来保存多套上游和模型映射，可以同时启用任意多个组。生效范围按以下顺序解析：

1. 环境变量 `MINI_CODEX_PROXY_GROUPS`（逗号分隔）
2. 环境变量 `MINI_CODEX_PROXY_GROUP`（逗号分隔，兼容旧写法）
3. `config.json` 的 `activeGroups`（数组或逗号分隔字符串）
4. `config.json` 的 `activeGroup`（兼容旧写法）
5. `groups` 里的第一个组

把值写成 `"all"` 表示启用全部组：

```json
{
  "activeGroups": "all"
}
```

每一组都可以单独写：

- `upstream` 或 `upstreams`
- `models`
- `endpoints`：这一组接受哪些接口，取值 `responses`、`messages`、`chat`、`models`；不写表示全部
- `priority`：组之间的优先级，数值大的先尝试，默认 `0`
- `injectMappedModels`
- `overrideModelList`

OpenAI 和 Claude 渠道混合启用：

```json
{
  "activeGroups": ["openai", "claude"],
  "groups": {
    "openai": {
      "priority": 100,
      "upstream": {
        "name": "openai-gateway",
        "baseUrl": "https://example.com/v1",
        "apiKey": "sk-your-openai-key"
      },
      "models": {
        "gpt-5.6-sol": "gpt-5.4"
      },
      "endpoints": ["responses", "chat", "models"]
    },
    "claude": {
      "priority": 90,
      "upstream": {
        "name": "anthropic",
        "baseUrl": "https://api.anthropic.com",
        "apiKey": "sk-ant-your-key",
        "authStyle": "x-api-key"
      },
      "models": {
        "claude-sonnet": "claude-sonnet-4-6"
      },
      "endpoints": ["messages", "models"]
    }
  }
}
```

这样一个代理端口同时对外提供两家模型：请求 `gpt-5.6-sol` 走 OpenAI 渠道，请求 `claude-sonnet` 走 Claude 渠道，互不影响。

不写 `groups` 时，顶层 `upstream` / `upstreams` / `models` 仍可直接使用，会自动收成名为 `default` 的一组。

### 请求如何选择渠道

按顺序判断：

1. 模型名写成 `组名/模型别名`（例如 `claude/claude-sonnet`）时，只使用这一组，忽略优先级。
2. 模型别名只属于某一组时，使用那一组。
3. 同一个别名被多组配置时，按 `priority` 从高到低排列，先用优先级最高的那组，失败才顺延。
4. 模型名不在任何 `models` 里时，按 `priority` 顺序尝试所有支持该接口的组，模型名原样转发。

只有支持当前接口（`endpoints`）的组才会参与。如果没有任何组支持这个接口或这个模型，代理返回 `404`，不会去连上游。

每组保留自己的映射：同一个别名 `shared` 在 A 组映射成 `a-model`、在 B 组映射成 `b-model` 时，切换到 B 组重试会改写成 `b-model`，不会把 A 组的目标名带过去。

### 上游认证方式

`authStyle` 决定代理用哪个请求头向上游认证：

- `bearer`（默认）：`Authorization: Bearer <apiKey>`
- `x-api-key`：`x-api-key: <apiKey>`，Anthropic 官方接口需要这一种

客户端自己带的 `Authorization` 和 `x-api-key` 一律不会转发给上游。

## 模型列表

`GET /v1/models` 返回所有启用渠道的 alias 合集。同一个别名被多组配置时，除了公共别名，还会额外列出 `组名/别名` 形式，方便指定具体渠道。

只启用一个渠道时保留原有行为：默认转发到该组上游，`injectMappedModels=true` 会把该组的 alias 追加进上游返回的 `data` 数组，`overrideModelList=true` 则只返回本地 alias 且不访问上游。

同时启用多个渠道时，没有任何单一上游的列表能代表代理实际提供的模型，因此固定返回本地合集，不再转发到某一个上游。

Responses 接口不受该逻辑影响，永远不会为模型注入而缓冲。

## 日志

### 实时彩色状态条

在独立终端运行代理时，会显示一条实时刷新的彩色状态行：

```text
⠹ | #a81f90c2 | POST | /v1/responses | gpt-5.6-luna→gpt-5.4-mini | naiccc/naiccc | 200 | ↑ 18.2 KB | ↓ 46.8 KB | 首包 0.42s | 首字 1.73s | 已用 6.21s
```

请求完成后，状态行会固定为汇总：

```text
✓ | #a81f90c2 | POST | /v1/responses | gpt-5.6-luna→gpt-5.4-mini | naiccc/naiccc | 200 | ↑ 18.2 KB | ↓ 83.4 KB | 首包 0.42s | 首字 1.73s | 总耗时 8.31s
```

- 组名与上游名不同时显示为 `组名/上游名`，相同时只显示一个。
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
2026-08-12 15:20:01 POST /v1/responses model=gpt-5.6-sol->gpt-5.4 group=naiccc upstream=naiccc:200 duration=8.31s bytes=12450 stream=true tokens=12480/842 cache=76.9%
```

日志包含方法、路径、模型映射、组名、上游名与状态、耗时、请求体字节数、`stream` 标志，以及 token 数与缓存命中率（上游返回 usage 时才有）。

日志不会包含：

- Authorization 或 API Key
- prompt、`input`、`instructions`
- `tools` 内容
- SSE 正文

## 请求日志与缓存命中

每个请求的 usage 会同时写入内存和磁盘。进程重启后，WebUI 会从磁盘把最近记录读回来，缓存命中统计也会接着算。

默认配置：

```json
{
  "requestLog": {
    "enabled": true,
    "limit": 500,
    "file": "logs/requests.jsonl"
  }
}
```

- `limit`：内存与 WebUI 中保留的最近请求条数，超出后丢弃最旧的，默认 `500`
- `file`：JSON Lines 落盘路径，相对项目根目录。默认 `logs/requests.jsonl`。启动时只从文件尾部读取最近 `limit` 条，不会把整份历史一次性读进内存。设为 `null` 则只保留在内存，进程退出即丢失

文件按追加写入，每行一条，崩溃时最多丢掉最后半行。序号 `seq` 从文件里已有的最大值继续往下编。设置 `"requestLog": { "enabled": false }` 可同时关闭内存记录和落盘。

### 缓存命中率怎么算

两家上游的 usage 字段语义不同，代理统一折算后再计算，因此不同渠道的命中率可以直接比较：

| 上游 | 字段 | 处理方式 |
|---|---|---|
| Anthropic | `input_tokens` + `cache_read_input_tokens` + `cache_creation_input_tokens` | 三者相加得到输入总量 |
| OpenAI | `prompt_tokens`（已含缓存） + `prompt_tokens_details.cached_tokens` | 直接用 `prompt_tokens`，不重复累加 |

命中率 = `cacheReadTokens / promptTokens`。上游没返回 usage 时为 `null`，不参与统计。

Anthropic 的 usage 分散在 `message_start`（输入与缓存）和 `message_delta`（输出）两个事件里，代理会合并这两处，所以流式请求也有完整数据。

### 查询接口

```text
GET http://127.0.0.1:8317/_mini/requests
GET http://127.0.0.1:8317/_mini/stats
```

`/_mini/requests` 支持以下查询参数：

| 参数 | 取值 | 含义 |
|---|---|---|
| `limit` | 1-1000，默认 100 | 返回条数 |
| `group` | 组名 | 只看某个渠道 |
| `model` | 模型名 | 匹配原始名或映射后的名字 |
| `status` | `ok` / `failed` | 只看成功或失败 |
| `cached` | `hit` / `miss` | 只看缓存命中或未命中 |

例如只看 claude 渠道的缓存命中请求：

```text
GET /_mini/requests?group=claude&cached=hit
```

`/_mini/stats` 返回总计以及按渠道、按模型的分组统计。

这两个接口和 `/_mini/status` 一样只允许 loopback 访问，也同样不返回 API Key、prompt、`input`、tools 或 SSE 正文——只有 token 计数。设置 `"requestLog": { "enabled": false }` 可关闭记录。

## WebUI 面板

浏览器打开：

```text
http://127.0.0.1:8317/_mini
```

单文件内嵌页面，无需构建步骤、npm 依赖或额外端口。每 2 秒自动刷新，页面切到后台时暂停轮询。

面板包含：

- 顶部卡片：总请求数、缓存命中率（带进度条）、缓存读取/输入/输出 token、进行中请求数
- 活动请求表：进行中请求的实时状态、已用时间、首包耗时、下行字节
- 渠道统计表：可切换按渠道或按模型聚合
- 请求日志表：可按缓存命中/未命中、成功/失败筛选；`尝试` 列大于 1 表示发生过故障切换

设置 `"webui": { "enabled": false }` 可关闭面板，此时 `/_mini/requests` 与 `/_mini/stats` 仍然可用。

## Windows 置顶悬浮窗

项目附带一个 PowerShell 7 + WPF 的轻量监控小窗，不需要 Electron、npm 依赖或数据库。它只读取代理内存中的当前/最近一次请求状态；历史仅保存在本次代理进程的内存中。

先启动代理：

```powershell
Set-Location D:\dev\mini-codex-proxy
node .\proxy.js
```

再开第二个 PowerShell 窗口启动悬浮窗：

```powershell
pwsh.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File .\monitor.ps1
```

或者一键启动代理和悬浮窗：

```powershell
pwsh.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File .\start-monitor.ps1
```

如果代理已经在运行，只启动窗口：

```powershell
pwsh.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File .\start-monitor.ps1 -NoProxy
```

小窗特性：

- 无边框、半透明、圆角、始终置顶。
- 横条中不显示应用标题和副标题，拖动横条空白区域即可移动。
- 默认使用紧凑尺寸，适合固定在屏幕角落。
- `◷` 按钮查看本次启动以来的已完成请求历史；只保存在内存，重启代理后清空。
- `⤢` 按钮放大到详细视图，再次点击 `⤡` 还原紧凑尺寸。
- `—` 按钮折叠/展开详情。
- `刷新` 立即读取一次状态，默认每 250ms 自动刷新。
- `×` 关闭小窗，不会关闭代理。
- 成功、失败、流式中、等待中使用不同颜色。
- 显示模型映射、当前上游、HTTP 状态、上行/下行字节、首包、首字和总耗时。

### 切换悬浮窗主题

在 `config.json` 中设置 `monitor.theme`：

```json
{
  "monitor": {
    "enabled": true,
    "theme": "light-mint"
  }
}
```

可用主题：

- `dark-green`：默认深绿色。
- `light-mint`：浅薄荷绿色。
- `light-ivory`：浅象牙白。
- `light-sky`：浅蓝色。
- `light` 是 `light-mint` 的简写，`dark` 是 `dark-green` 的简写。

修改后关闭并重新启动悬浮窗即可生效，不必重启代理。如果代理通过环境变量 `MINI_CODEX_PROXY_CONFIG` 使用其他配置文件，悬浮窗会读取同一文件；也可以用 `-ConfigPath` 显式指定：

```powershell
pwsh.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File .\monitor.ps1 -ConfigPath D:\path\to\config.json
```

代理提供一个仅限回环地址访问的内存状态接口：

```text
GET http://127.0.0.1:8317/_mini/status
```

该接口只允许 `127.0.0.1`、`::1` 和 IPv4-mapped loopback 地址访问，并返回当前活跃请求与最近一次请求的摘要。它不会返回 API Key、prompt、`input`、tools 或 SSE 正文。设置 `"monitor": { "enabled": false }` 可关闭这个接口。

状态接口还会返回当前代理进程启动以来最多 100 条已完成请求摘要，悬浮窗的“历”按钮使用的就是这段内存数据；不写入文件，也不保留跨重启历史。

悬浮窗和代理建议分别运行在两个终端；关闭悬浮窗不会中断 Codex 请求，也不会改变 Responses SSE 透传。

## 故障切换

两级切换，都发生在代理还没向客户端发送响应头和 body 之前；SSE 一旦开始发送，绝不会中途切换。只有连接失败或上游返回 `502`、`503`、`520`、`524` 时才尝试下一项。

组内多上游，按 `upstreams[].priority` 从高到低：

```json
{
  "groups": {
    "naiccc": {
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
  }
}
```

跨组切换：同一个模型别名被多个启用中的组配置时，按组的 `priority` 从高到低顺延。换组重试会改用新组自己的模型映射和自己的 `apiKey`、`authStyle`。

用 `组名/别名` 指定渠道时不参与跨组切换，只在该组内部的 `upstreams` 之间切换。

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

检查对应组的 `upstream.baseUrl` 是否存在，或使用非空的 `upstreams` 数组。

### `Unknown active group`

`activeGroups`、`activeGroup` 或环境变量 `MINI_CODEX_PROXY_GROUPS` 必须对应 `groups` 里已有的组名。用 `"all"` 表示全部。

### 返回 404 且提示 `No active channel serves ...`

没有任何启用中的组支持这个接口或这个模型。检查该组是否在 `activeGroups` 里、`endpoints` 是否包含当前接口、`models` 是否有这个 alias。

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

测试会启动本地模拟上游，不需要真实 API Key，也不会访问真实模型服务。覆盖模型映射、字段保留、统一 Key 验证、上游 Authorization、非流式响应、分块 SSE、reasoning/tool/completed 事件、错误透传、模型注入、多渠道同时启用、按接口路由、跨组切换、`组名/别名` 定向、故障切换、两种 usage 字段折算、流式 usage 合并、缓存命中筛选与分组统计、WebUI 面板与 loopback 限制、JSON Lines 落盘与重启后回读、日志脱敏、502 和正常关闭。
