# Midscene Chrome Relay

独立中继服务，让远程机器通过 Midscene SDK 或 Playwright 控制本地 Chrome 浏览器。

## 架构

```
A电脑 (浏览器机器):
  Chrome --remote-debugging-port=9222
    ↑ CDP (localhost:9222)
  midscene-chrome-relay (本服务)
    ├─ Socket.IO Server (0.0.0.0:3766)  ← Midscene SDK 连接
    └─ CDP Proxy (0.0.0.0:9223)         ← Playwright / Puppeteer 连接

B电脑 (脚本机器):
  方式1: Midscene SDK → ws://A_IP:3766
  方式2: Playwright  → chromium.connectOverCDP('http://A_IP:9223')
```

## A电脑 - 启动 Chrome 和 Relay

### 1. 启动 Chrome（带远程调试端口）

```bash
# Linux
google-chrome --remote-debugging-port=9222

# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Windows
chrome.exe --remote-debugging-port=9222
```

### 2. 安装并启动 Relay

```bash
cd midscene-chrome-relay
npm install
npm start
```

启动后输出：
```
=== Midscene Chrome Relay ===
Chrome CDP:     http://127.0.0.1:9222
SDK relay:      0.0.0.0:3766
CDP proxy:      0.0.0.0:9223

[Relay] Connected to Chrome
[Relay] Server listening on 0.0.0.0:3766
[CDP Proxy] Listening on 0.0.0.0:9223

[Relay] Ready! Waiting for connections...
[Relay] Midscene SDK:  ws://<this-ip>:3766
[Relay] Playwright:    chromium.connectOverCDP("http://<this-ip>:9223")
```

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDP_URL` | `http://127.0.0.1:9222` | Chrome CDP 地址 |
| `RELAY_HOST` | `0.0.0.0` | 监听地址 |
| `RELAY_PORT` | `3766` | Midscene SDK 端口 |
| `CDP_PROXY_PORT` | `9223` | Playwright/Puppeteer CDP 代理端口 |

---

## B电脑 - 方式 1: Midscene SDK (Socket.IO)

通过 Midscene 自定义协议连接，适合需要完整 Midscene Agent 功能的场景。

```typescript
import { createRemoteAgent } from './client';

const agent = await createRemoteAgent({
  relayUrl: 'ws://A电脑IP:3766',
});

await agent.connectCurrentTab();
await agent.aiAct('click the login button');
await agent.aiAssert('login successful');
await agent.destroy();
```

运行：
```bash
RELAY_URL=ws://A电脑IP:3766 npm run demo
```

---

## B电脑 - 方式 2: Playwright (推荐)

通过 CDP 代理直接连接，使用标准 Playwright API + Midscene PlaywrightAgent。

```typescript
import { chromium } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';

// 通过 CDP 代理连接到 A 的 Chrome
const browser = await chromium.connectOverCDP('http://A电脑IP:9223');
const context = browser.contexts()[0];
const page = context.pages()[0] || await context.newPage();

// 用 Midscene AI 操作
const agent = new PlaywrightAgent(page);
await agent.aiAct('click the login button');
await agent.aiAssert('login successful');

browser.close(); // disconnect, 不会关闭 A 的 Chrome
```

运行：
```bash
RELAY_HOST=A电脑IP npm run demo:playwright
```

---

## AI 模型配置（B电脑必须）

```bash
export MIDSCENE_MODEL_NAME=qwen3.5-plus
export OPENAI_API_KEY=your-key
export OPENAI_BASE_URL=https://your-api-base/v1/
```

## 安全注意

- Relay 默认监听 `0.0.0.0`，确保在可信网络中使用
- Chrome CDP 只暴露在 localhost，外部通过 Relay 代理访问
- 建议用防火墙限制 3766 和 9223 端口的访问源
