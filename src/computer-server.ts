/**
 * Computer Relay Server - runs on machine A to expose desktop control via Socket.IO.
 *
 * Uses @computer-use/libnut for mouse/keyboard control and screenshot-desktop for screenshots.
 * Machine B connects via Socket.IO and sends bridge commands.
 */
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { Server, type Socket } from 'socket.io';

const DEFAULT_COMPUTER_RELAY_PORT = 3767;
const DEFAULT_RELAY_HOST = '0.0.0.0';

// Bridge protocol events (matching midscene's bridge-mode)
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

// LibNut type definitions
interface LibNut {
  getScreenSize(): { width: number; height: number };
  getMousePos(): { x: number; y: number };
  moveMouse(x: number, y: number): void;
  mouseClick(button?: 'left' | 'right' | 'middle', double?: boolean): void;
  mouseToggle(state: 'up' | 'down', button?: 'left' | 'right' | 'middle'): void;
  scrollMouse(x: number, y: number): void;
  keyTap(key: string, modifiers?: string[]): void;
  typeString(text: string): void;
}

export interface ComputerRelayConfig {
  url?: string;
}

/**
 * Load libnut native module.
 */
let libnut: LibNut | null = null;
async function getLibnut(): Promise<LibNut> {
  if (libnut) return libnut;
  const require = createRequire(import.meta.url);
  const libnutModule = require('@computer-use/libnut/dist/import_libnut');
  libnut = libnutModule.libnut as LibNut;
  if (!libnut) {
    throw new Error('libnut loaded but libnut object is undefined');
  }
  return libnut;
}

/**
 * Take a screenshot using screenshot-desktop.
 */
async function takeScreenshot(): Promise<string> {
  const screenshot = (await import('screenshot-desktop')).default;
  const buffer: Buffer = await screenshot({ format: 'png' });
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Key name normalization for cross-platform compatibility
const KEY_NAME_MAP: Record<string, string> = {
  windows: 'win',
  win: 'win',
  ctrl: 'control',
  esc: 'escape',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  pgdn: 'pagedown',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
};

const PRIMARY_KEY_MAP: Record<string, string> = {
  command: 'cmd',
  cmd: 'cmd',
  meta: 'meta',
  control: 'control',
  ctrl: 'control',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
};

function normalizeKeyName(key: string): string {
  const lowerKey = key.toLowerCase();
  return KEY_NAME_MAP[lowerKey] || lowerKey;
}

function normalizePrimaryKey(key: string): string {
  const lowerKey = key.toLowerCase();
  if (PRIMARY_KEY_MAP[lowerKey]) return PRIMARY_KEY_MAP[lowerKey];
  return KEY_NAME_MAP[lowerKey] || lowerKey;
}

/**
 * Smooth mouse movement for realistic behavior.
 */
async function smoothMoveMouse(
  nut: LibNut,
  targetX: number,
  targetY: number,
  steps = 8,
  stepDelay = 8,
): Promise<void> {
  const currentPos = nut.getMousePos();
  for (let i = 1; i <= steps; i++) {
    const stepX = Math.round(currentPos.x + ((targetX - currentPos.x) * i) / steps);
    const stepY = Math.round(currentPos.y + ((targetY - currentPos.y) * i) / steps);
    nut.moveMouse(stepX, stepY);
    await sleep(stepDelay);
  }
}

/**
 * Computer Relay Server.
 *
 * Exposes desktop control (mouse, keyboard, screenshot) over Socket.IO
 * so a remote machine can control this computer via Midscene Agent.
 */
export class ComputerRelayServer {
  private io: Server | null = null;
  private commanderSocket: Socket | null = null;

  constructor(private config: ComputerRelayConfig = {}) {}

  async start(): Promise<void> {
    const relayUrl = new URL(this.config.url || 'ws://0.0.0.0:3767');
    const host = relayUrl.hostname;
    const port = Number(relayUrl.port) || 3767;

    // Initialize libnut
    console.log('[Computer Relay] Initializing libnut...');
    const nut = await getLibnut();
    const screenSize = nut.getScreenSize();
    console.log(`[Computer Relay] Screen: ${screenSize.width}x${screenSize.height}`);

    // Test screenshot
    console.log('[Computer Relay] Testing screenshot...');
    const testShot = await takeScreenshot();
    console.log(`[Computer Relay] Screenshot OK (${testShot.length} chars)`);

    // Start Socket.IO server
    const httpServer = createServer();
    this.io = new Server(httpServer, {
      maxHttpBufferSize: 100 * 1024 * 1024, // 100MB for screenshots
      pingTimeout: 60000,
      cors: { origin: '*' },
    });

    this.io.on('connection', (socket) => this.handleConnection(socket, nut));

    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', () => {
        console.log(`[Computer Relay] Listening on ${host}:${port}`);
        resolve();
      });
      httpServer.once('error', (err) =>
        reject(new Error(`Computer Relay listen error: ${err.message}`)),
      );
      httpServer.listen(port, host);
    });
  }

  private handleConnection(socket: Socket, nut: LibNut) {
    if (this.commanderSocket?.connected) {
      console.log('[Computer Relay] Refusing: already have a commander');
      socket.emit(BridgeEvent.Refused, 'Another client is already connected');
      socket.disconnect();
      return;
    }

    console.log('[Computer Relay] Commander connected');
    this.commanderSocket = socket;
    socket.emit(BridgeEvent.Connected, { version: '1.0.0-computer-relay' });

    socket.on(BridgeEvent.Call, async (call: BridgeCallRequest) => {
      try {
        const result = await this.executeCall(nut, call.method, call.args);
        socket.emit(BridgeEvent.CallResponse, {
          id: call.id,
          response: result,
        } as BridgeCallResponse);
      } catch (err: any) {
        console.error(`[Computer Relay] Call error: ${call.method}`, err?.message);
        socket.emit(BridgeEvent.CallResponse, {
          id: call.id,
          error: err?.message || String(err),
        } as BridgeCallResponse);
      }
    });

    socket.on('disconnect', (reason) => {
      console.log(`[Computer Relay] Commander disconnected: ${reason}`);
      this.commanderSocket = null;
    });
  }

  private async executeCall(nut: LibNut, method: string, args: any[]): Promise<any> {
    switch (method) {
      // ===== Screen =====
      case 'screenshotBase64': {
        return await takeScreenshot();
      }

      case 'size': {
        const s = nut.getScreenSize();
        return { width: s.width, height: s.height };
      }

      case 'url': {
        return ''; // Computer mode has no URL
      }

      // ===== Mouse =====
      case 'mouse.click': {
        const [x, y, opts] = args;
        const button = (opts?.button || 'left') as 'left' | 'right' | 'middle';
        const count = opts?.count || 1;
        await smoothMoveMouse(nut, Math.round(x), Math.round(y));
        for (let i = 0; i < count; i++) {
          nut.mouseToggle('down', button);
          await sleep(50);
          nut.mouseToggle('up', button);
          if (i < count - 1) await sleep(50);
        }
        return;
      }

      case 'mouse.move': {
        await smoothMoveMouse(nut, Math.round(args[0]), Math.round(args[1]), 10, 10);
        return;
      }

      case 'mouse.wheel': {
        const [deltaX, deltaY] = args;
        const scrollX = deltaX ? Math.round(deltaX / 100) : 0;
        const scrollY = deltaY ? -Math.round(deltaY / 100) : 0;
        nut.scrollMouse(scrollX, scrollY);
        return;
      }

      case 'mouse.drag': {
        const [from, to] = args;
        nut.moveMouse(Math.round(from.x), Math.round(from.y));
        nut.mouseToggle('down', 'left');
        await sleep(100);
        await smoothMoveMouse(nut, Math.round(to.x), Math.round(to.y), 15, 10);
        await sleep(100);
        nut.mouseToggle('up', 'left');
        return;
      }

      // ===== Keyboard =====
      case 'keyboard.type': {
        const text = args[0] as string;
        // Use clipboard paste for reliability (avoids IME issues)
        try {
          const clipboardy = await import('clipboardy');
          const oldClip = await clipboardy.default.read().catch(() => '');
          await clipboardy.default.write(text);
          await sleep(50);
          const modifier = process.platform === 'darwin' ? 'command' : 'control';
          nut.keyTap('v', [modifier]);
          await sleep(100);
          if (oldClip) await clipboardy.default.write(oldClip).catch(() => {});
        } catch {
          // Fallback: typeString
          nut.typeString(text);
        }
        return;
      }

      case 'keyboard.press': {
        const actions = Array.isArray(args[0]) ? args[0] : [args[0]];
        // Combine into a single key combo: "Ctrl+A" style
        for (const action of actions) {
          if (typeof action === 'string') {
            // "Ctrl+A" format
            const parts = action.split('+');
            const modifiers = parts.slice(0, -1).map(normalizeKeyName);
            const key = normalizePrimaryKey(parts[parts.length - 1]);
            if (modifiers.length > 0) {
              nut.keyTap(key, modifiers);
            } else {
              nut.keyTap(key);
            }
          } else if (action?.key) {
            // { key: 'a' } format
            const parts = action.key.split('+');
            const modifiers = parts.slice(0, -1).map(normalizeKeyName);
            const key = normalizePrimaryKey(parts[parts.length - 1]);
            if (modifiers.length > 0) {
              nut.keyTap(key, modifiers);
            } else {
              nut.keyTap(key);
            }
          }
        }
        return;
      }

      // ===== Scroll =====
      case 'scrollUp': {
        const distance = (args[0] as number) || 500;
        const ticks = Math.ceil(distance / 100);
        nut.scrollMouse(0, ticks);
        return;
      }
      case 'scrollDown': {
        const distance = (args[0] as number) || 500;
        const ticks = Math.ceil(distance / 100);
        nut.scrollMouse(0, -ticks);
        return;
      }
      case 'scrollLeft': {
        const distance = (args[0] as number) || 500;
        const ticks = Math.ceil(distance / 100);
        nut.scrollMouse(-ticks, 0);
        return;
      }
      case 'scrollRight': {
        const distance = (args[0] as number) || 500;
        const ticks = Math.ceil(distance / 100);
        nut.scrollMouse(ticks, 0);
        return;
      }
      case 'scrollUntilTop':
      case 'scrollUntilBottom':
      case 'scrollUntilLeft':
      case 'scrollUntilRight': {
        // Large scroll
        const scrollMap: Record<string, [number, number]> = {
          scrollUntilTop: [0, 100],
          scrollUntilBottom: [0, -100],
          scrollUntilLeft: [-100, 0],
          scrollUntilRight: [100, 0],
        };
        const [dx, dy] = scrollMap[method] || [0, 0];
        for (let i = 0; i < 10; i++) {
          nut.scrollMouse(dx, dy);
          await sleep(100);
        }
        return;
      }

      // ===== Lifecycle =====
      case 'destroy':
      case 'beforeInvokeAction':
      case 'setDestroyOptions': {
        return;
      }

      default: {
        console.warn(`[Computer Relay] Unknown method: ${method}`);
        return undefined;
      }
    }
  }

  async stop() {
    if (this.io) {
      this.io.close();
      this.io = null;
    }
  }
}
