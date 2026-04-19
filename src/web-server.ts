/**
 * Web Relay Server - runs on machine A alongside Chrome.
 *
 * 1. Connects to local Chrome via CDP (localhost:9222)
 * 2. Starts a Socket.IO server (for Midscene SDK bridge)
 * 3. Starts a CDP reverse proxy (for Playwright connectOverCDP)
 * 4. Accepts remote SDK connections and forwards commands to Chrome
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { WebSocket, WebSocketServer } from 'ws';
import { chromium, type Browser, type Page } from 'playwright';

const DEFAULT_CDP_URL = 'http://127.0.0.1:9222';
const DEFAULT_RELAY_PORT = 3766;
const DEFAULT_CDP_PROXY_PORT = 9223;
const DEFAULT_RELAY_HOST = '0.0.0.0';

// Bridge protocol events (matching midscene's bridge-mode/common.ts)
const BridgeEvent = {
  Call: 'bridge-call',
  CallResponse: 'bridge-call-response',
  Connected: 'bridge-connected',
  Refused: 'bridge-refused',
} as const;

interface BridgeCallRequest {
  id: string;
  method: string;
  args: any[];
}

interface BridgeCallResponse {
  id: string;
  response: any;
  error?: any;
}

export interface WebRelayConfig {
  /** Chrome CDP URL, default http://127.0.0.1:9222 */
  cdpUrl?: string;
  /** Relay URL for SDK, default ws://0.0.0.0:3766 */
  url?: string;
  /** CDP reverse proxy URL for Playwright, default http://0.0.0.0:9223 */
  cdpProxyUrl?: string;
}

/**
 * Web Relay Server.
 *
 * Connects to a local Chrome instance via CDP and exposes:
 * - Socket.IO bridge for Midscene SDK (tab management, screenshots, mouse/keyboard, element tree)
 * - CDP reverse proxy for Playwright connectOverCDP
 */
export class WebRelayServer {
  private io: Server | null = null;
  private browser: Browser | null = null;
  private activePage: Page | null = null;
  private commanderSocket: Socket | null = null;
  private cdpProxyServer: ReturnType<typeof createServer> | null = null;

  constructor(private config: WebRelayConfig = {}) {}

  async start(): Promise<void> {
    const cdpUrl = this.config.cdpUrl || DEFAULT_CDP_URL;
    const relayUrlStr = this.config.url || 'ws://0.0.0.0:3766';
    const relayUrl = new URL(relayUrlStr.includes('://') ? relayUrlStr : `ws://${relayUrlStr}`);
    const host = relayUrl.hostname;
    const port = Number(relayUrl.port) || 3766;

    // 1. Connect to Chrome via CDP
    console.log(`[Web Relay] Connecting to Chrome at ${cdpUrl}...`);
    this.browser = await chromium.connectOverCDP(cdpUrl);
    console.log(`[Web Relay] Connected to Chrome (${cdpUrl})`);

    // Monitor browser disconnect
    this.browser.on('disconnected', () => {
      console.error('[Web Relay] Chrome browser disconnected!');
      this.activePage = null;
    });

    // 2. Start Socket.IO server
    const httpServer = createServer();
    this.io = new Server(httpServer, {
      maxHttpBufferSize: 100 * 1024 * 1024,
      pingTimeout: 60000,
      cors: { origin: '*' },
    });

    this.io.on('connection', (socket) => {
      const role = socket.handshake.auth?.role;
      console.log(`[Web Relay] New socket connection: ${socket.id} from ${socket.handshake.address} (role: ${role || 'none'})`);

      // Only accept connections with commander role (reject browser extension connections)
      if (role !== 'commander') {
        console.log(`[Web Relay] Rejecting ${socket.id}: missing auth role 'commander'`);
        socket.disconnect();
        return;
      }

      this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', () => {
        console.log(`[Web Relay] SDK bridge listening on ${host}:${port}`);
        resolve();
      });
      httpServer.once('error', (err) =>
        reject(new Error(`Web Relay listen error: ${err.message}`)),
      );
      httpServer.listen(port, host);
    });
  }

  private handleConnection(socket: Socket) {
    if (this.commanderSocket?.connected) {
      console.log(`[Web Relay] Kicking previous commander ${this.commanderSocket.id} for new ${socket.id}`);
      const prev = this.commanderSocket;
      this.commanderSocket = null;
      prev.disconnect();
    }

    console.log(`[Web Relay] Commander connected: ${socket.id}`);
    this.commanderSocket = socket;

    socket.emit(BridgeEvent.Connected, { version: '1.0.0-web-relay' });

    socket.on(BridgeEvent.Call, async (call: BridgeCallRequest) => {
      try {
        const result = await this.executeCall(call.method, call.args);
        socket.emit(BridgeEvent.CallResponse, {
          id: call.id,
          response: result,
        } as BridgeCallResponse);
      } catch (err: any) {
        console.error(`[Web Relay] Call error: ${call.method}`, err?.message);
        socket.emit(BridgeEvent.CallResponse, {
          id: call.id,
          error: err?.message || String(err),
        } as BridgeCallResponse);
      }
    });

    socket.on('disconnect', (reason) => {
      // Only clear if this socket is still the active commander
      if (this.commanderSocket === socket) {
        console.log(`[Web Relay] Commander ${socket.id} disconnected: ${reason}`);
        this.commanderSocket = null;
      } else {
        console.log(`[Web Relay] Old socket ${socket.id} disconnected: ${reason} (already replaced)`);
      }
    });
  }

  /**
   * Execute a bridge call method against Chrome via Playwright.
   */
  private async executeCall(method: string, args: any[]): Promise<any> {
    if (!this.browser) throw new Error('Not connected to Chrome');

    switch (method) {
      // ===== Tab management =====
      case 'connectNewTabWithUrl': {
        const url = args[0] as string;
        console.log(`[Web Relay] Creating new tab: ${url}`);
        this.activePage = await this.browser.contexts()[0].newPage();
        await this.activePage.goto(url, { waitUntil: 'domcontentloaded' });
        return;
      }

      case 'connectCurrentTab': {
        const pages = this.browser.contexts().flatMap(c => c.pages());
        this.activePage = pages[pages.length - 1] || null;
        if (!this.activePage) throw new Error('No pages available');
        console.log(`[Web Relay] Connected to current tab: ${this.activePage.url()}`);
        return;
      }

      case 'getBrowserTabList': {
        const pages = this.browser.contexts().flatMap(c => c.pages());
        return pages.map((p, i) => ({
          id: String(i),
          title: '',
          url: p.url(),
          currentActiveTab: p === this.activePage,
        }));
      }

      case 'setActiveTabId': {
        const tabIndex = Number(args[0]);
        const pages = this.browser.contexts().flatMap(c => c.pages());
        if (tabIndex >= 0 && tabIndex < pages.length) {
          this.activePage = pages[tabIndex];
          await this.activePage.bringToFront();
        }
        return;
      }

      // ===== Page info =====
      case 'url': {
        return this.getPage().url();
      }

      case 'size': {
        const viewport = this.getPage().viewportSize();
        if (viewport) return { width: viewport.width, height: viewport.height };
        // Fallback: evaluate in page
        return await this.getPage().evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }));
      }

      case 'screenshotBase64': {
        const buf = await this.getPage().screenshot({
          type: 'jpeg',
          quality: 90,
        });
        return `data:image/jpeg;base64,${buf.toString('base64')}`;
      }

      // ===== Navigation =====
      case 'navigate': {
        await this.getPage().goto(args[0], { waitUntil: 'domcontentloaded' });
        return;
      }

      case 'reload': {
        await this.getPage().reload({ waitUntil: 'domcontentloaded' });
        return;
      }

      case 'goBack': {
        await this.getPage().goBack({ waitUntil: 'domcontentloaded' });
        return;
      }

      // ===== Element tree (inject midscene inspector) =====
      case 'getElementsNodeTree': {
        return await this.getElementsNodeTree();
      }

      // ===== JavaScript evaluation =====
      case 'evaluateJavaScript': {
        const result = await this.getPage().evaluate(args[0]);
        return { result: { value: result } };
      }

      // ===== Mouse events =====
      case 'mouse.click': {
        const [x, y, opts] = args;
        const button = opts?.button || 'left';
        const count = opts?.count || 1;
        for (let i = 0; i < count; i++) {
          await this.getPage().mouse.click(x, y, { button });
        }
        return;
      }

      case 'mouse.move': {
        await this.getPage().mouse.move(args[0], args[1]);
        return;
      }

      case 'mouse.wheel': {
        const [deltaX, deltaY] = args;
        await this.getPage().mouse.wheel(deltaX, deltaY);
        return;
      }

      case 'mouse.drag': {
        const [from, to] = args;
        await this.getPage().mouse.move(from.x, from.y);
        await this.getPage().mouse.down();
        await this.getPage().mouse.move(to.x, to.y, { steps: 10 });
        await this.getPage().mouse.up();
        return;
      }

      // ===== Keyboard events =====
      case 'keyboard.type': {
        await this.getPage().keyboard.type(args[0]);
        return;
      }

      case 'keyboard.press': {
        const actions = Array.isArray(args[0]) ? args[0] : [args[0]];
        for (const action of actions) {
          await this.getPage().keyboard.down(action.key);
        }
        for (const action of [...actions].reverse()) {
          await this.getPage().keyboard.up(action.key);
        }
        return;
      }

      // ===== Scroll =====
      case 'scrollUp':
      case 'scrollDown':
      case 'scrollLeft':
      case 'scrollRight':
      case 'scrollUntilTop':
      case 'scrollUntilBottom':
      case 'scrollUntilLeft':
      case 'scrollUntilRight': {
        return await this.handleScroll(method, args);
      }

      // ===== Lifecycle =====
      case 'setDestroyOptions':
      case 'bridge-update-agent-status':
      case 'beforeInvokeAction': {
        return; // no-op on relay
      }

      case 'destroy': {
        // Don't close browser, just release the active page
        this.activePage = null;
        return;
      }

      default: {
        console.warn(`[Web Relay] Unknown method: ${method}`);
        return undefined;
      }
    }
  }

  private getPage(): Page {
    if (!this.activePage) {
      throw new Error(
        'No active page. Call connectCurrentTab() or connectNewTabWithUrl() first.',
      );
    }
    return this.activePage;
  }

  private async getElementsNodeTree(): Promise<any> {
    const page = this.getPage();

    // Inject midscene element inspector script
    const scriptUrl =
      'https://unpkg.com/@midscene/web@latest/iife-script/htmlElement.js';

    await page.evaluate(async (url: string) => {
      if (!(window as any).midscene_element_inspector) {
        const script = document.createElement('script');
        script.src = url;
        document.head.appendChild(script);
        await new Promise((resolve) => {
          script.onload = resolve;
          script.onerror = resolve;
        });
      }
    }, scriptUrl);

    // Small wait for script init
    await new Promise((r) => setTimeout(r, 200));

    const result = await page.evaluate(() => {
      const inspector = (window as any).midscene_element_inspector;
      if (!inspector) {
        throw new Error('midscene element inspector not loaded');
      }
      const tree = inspector.webExtractNodeTree();
      return {
        tree,
        size: {
          width: document.documentElement.clientWidth,
          height: document.documentElement.clientHeight,
        },
      };
    });

    return result?.tree || { node: null, children: [] };
  }

  private async handleScroll(method: string, args: any[]): Promise<void> {
    const page = this.getPage();
    const viewport = await page.evaluate(() => ({
      w: window.innerWidth,
      h: window.innerHeight,
    }));

    let deltaX = 0;
    let deltaY = 0;
    const distance = args[0] as number | undefined;
    const big = 9999999;

    switch (method) {
      case 'scrollUp':
        deltaY = -(distance || viewport.h * 0.7);
        break;
      case 'scrollDown':
        deltaY = distance || viewport.h * 0.7;
        break;
      case 'scrollLeft':
        deltaX = -(distance || viewport.w * 0.7);
        break;
      case 'scrollRight':
        deltaX = distance || viewport.w * 0.7;
        break;
      case 'scrollUntilTop':
        deltaY = -big;
        break;
      case 'scrollUntilBottom':
        deltaY = big;
        break;
      case 'scrollUntilLeft':
        deltaX = -big;
        break;
      case 'scrollUntilRight':
        deltaX = big;
        break;
    }

    await page.mouse.wheel(deltaX, deltaY);
  }

  /**
   * Start a CDP reverse proxy so Playwright can connect via
   * chromium.connectOverCDP('http://A_IP:<cdpProxyPort>').
   */
  async startCdpProxy(): Promise<void> {
    const cdpUrl = this.config.cdpUrl || DEFAULT_CDP_URL;
    const proxyUrlStr = this.config.cdpProxyUrl || 'http://0.0.0.0:9223';
    const proxyUrl = new URL(proxyUrlStr.includes('://') ? proxyUrlStr : `http://${proxyUrlStr}`);
    const host = proxyUrl.hostname;
    const proxyPort = Number(proxyUrl.port) || 9223;
    const cdpOrigin = new URL(cdpUrl);

    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const targetUrl = `${cdpUrl}${req.url}`;
      try {
        const upstream = await fetch(targetUrl);
        const contentType = upstream.headers.get('content-type') || 'application/json';
        let body = await upstream.text();

        const localWs = `ws://${cdpOrigin.hostname}:${cdpOrigin.port}`;
        const localHttp = `http://${cdpOrigin.hostname}:${cdpOrigin.port}`;
        const proxyWs = `ws://HOST_PLACEHOLDER:${proxyPort}`;
        const proxyHttp = `http://HOST_PLACEHOLDER:${proxyPort}`;
        body = body.replaceAll(localWs, proxyWs).replaceAll(localHttp, proxyHttp);

        const reqHost = req.headers.host;
        if (reqHost) {
          const hostOnly = reqHost.split(':')[0];
          body = body.replaceAll('HOST_PLACEHOLDER', hostOnly);
        }

        res.writeHead(upstream.status, { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*' });
        res.end(body);
      } catch (err: any) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`CDP proxy error: ${err.message}`);
      }
    });

    const wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (clientWs: WebSocket, req: IncomingMessage) => {
      const targetWsUrl = `ws://${cdpOrigin.hostname}:${cdpOrigin.port}${req.url}`;
      console.log(`[CDP Proxy] WS proxy: ${req.url}`);

      const chromeWs = new WebSocket(targetWsUrl);
      const pendingMessages: { data: any; isBinary: boolean }[] = [];
      let chromeReady = false;

      chromeWs.on('open', () => {
        console.log(`[CDP Proxy] WS upstream connected: ${req.url}`);
        chromeReady = true;
        for (const msg of pendingMessages) {
          chromeWs.send(msg.data, { binary: msg.isBinary });
        }
        pendingMessages.length = 0;
      });

      chromeWs.on('error', (err) => {
        console.error(`[CDP Proxy] Chrome WS error: ${err.message}`);
        try { clientWs.close(); } catch (_) {}
      });

      clientWs.on('error', (err) => {
        console.error(`[CDP Proxy] Client WS error: ${err.message}`);
        try { chromeWs.close(); } catch (_) {}
      });

      clientWs.on('message', (data, isBinary) => {
        if (chromeReady && chromeWs.readyState === WebSocket.OPEN) {
          chromeWs.send(data, { binary: isBinary });
        } else {
          pendingMessages.push({ data, isBinary });
        }
      });

      chromeWs.on('message', (data, isBinary) => {
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(data, { binary: isBinary });
        }
      });

      clientWs.on('close', (code, reason) => {
        console.log(`[CDP Proxy] Client WS closed: ${code}`);
        try { chromeWs.close(); } catch (_) {}
      });

      chromeWs.on('close', (code, reason) => {
        console.log(`[CDP Proxy] Chrome WS closed: ${code}`);
        try { clientWs.close(); } catch (_) {}
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => {
        console.log(`[CDP Proxy] Listening on ${host}:${proxyPort}`);
        resolve();
      });
      server.once('error', (err) => reject(new Error(`CDP proxy listen error: ${err.message}`)));
      server.listen(proxyPort, host);
    });

    this.cdpProxyServer = server;
  }

  async stop() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    if (this.io) {
      this.io.close();
      this.io = null;
    }
    if (this.cdpProxyServer) {
      this.cdpProxyServer.close();
      this.cdpProxyServer = null;
    }
  }
}
