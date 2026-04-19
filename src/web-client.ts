/**
 * Remote Agent Client - used on machine B to connect to the Relay on machine A.
 *
 * Usage:
 *   import { createRemoteAgent } from './client';
 *   const agent = await createRemoteAgent({ relayUrl: 'ws://A_IP:3766' });
 *   await agent.connectCurrentTab();
 *   await agent.aiAct('click login button');
 */
import { Agent, type AgentOpt } from '@midscene/core/agent';
import {
  type AbstractInterface,
  type DeviceAction,
  defineActionTap,
  defineActionRightClick,
  defineActionDoubleClick,
  defineActionHover,
  defineActionInput,
  defineActionKeyboardPress,
  defineActionScroll,
  defineActionDragAndDrop,
  defineActionClearInput,
  defineActionLongPress,
} from '@midscene/core/device';
import type {
  ElementCacheFeature,
  ElementTreeNode,
  Point,
  Rect,
  Size,
} from '@midscene/core';
import { io as ClientIO, type Socket } from 'socket.io-client';

// Bridge protocol events (must match server.ts / midscene bridge-mode)
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

/**
 * A remote page proxy that forwards all calls to the Relay via Socket.IO.
 * Implements Midscene's AbstractInterface so it can be used with Agent.
 */
export class RemotePage implements AbstractInterface {
  interfaceType = 'remote-chrome-relay';
  private socket: Socket | null = null;
  private callId = 0;
  private bridgeReady = false;
  private pendingCalls = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timeout: NodeJS.Timeout;
    }
  >();

  constructor(private relayUrl: string) {}

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = ClientIO(this.relayUrl, {
        auth: { role: 'commander' },
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        transports: ['websocket'],
      });

      const timeout = setTimeout(() => {
        this.socket?.close();
        reject(new Error(`Failed to connect to relay at ${this.relayUrl}`));
      }, 15000);

      let firstConnect = true;

      this.socket.on(BridgeEvent.Connected, () => {
        this.bridgeReady = true;
        if (firstConnect) {
          firstConnect = false;
          clearTimeout(timeout);
          console.log(`[RemotePage] Connected to relay at ${this.relayUrl}`);
          resolve();
        } else {
          console.log(`[RemotePage] Reconnected to relay at ${this.relayUrl}`);
        }
      });

      this.socket.on(BridgeEvent.Refused, (reason: string) => {
        this.bridgeReady = false;
        if (firstConnect) {
          clearTimeout(timeout);
          reject(new Error(`Connection refused: ${reason}`));
        } else {
          console.error(`[RemotePage] Reconnection refused: ${reason}`);
        }
      });

      this.socket.on('connect_error', (err: any) => {
        if (firstConnect) {
          clearTimeout(timeout);
          reject(new Error(`Connect error: ${err?.message || err}`));
        }
      });

      this.socket.on(BridgeEvent.CallResponse, (resp: BridgeCallResponse) => {
        const pending = this.pendingCalls.get(resp.id);
        if (pending) {
          this.pendingCalls.delete(resp.id);
          clearTimeout(pending.timeout);
          if (resp.error) {
            pending.reject(
              new Error(
                typeof resp.error === 'string' ? resp.error : String(resp.error),
              ),
            );
          } else {
            pending.resolve(resp.response);
          }
        }
      });

      this.socket.on('disconnect', (reason) => {
        console.log(`[RemotePage] Disconnected from relay: ${reason}`);
        this.bridgeReady = false;
        // Reject all pending calls
        for (const [id, pending] of this.pendingCalls) {
          clearTimeout(pending.timeout);
          pending.reject(new Error(`Disconnected from relay: ${reason}`));
        }
        this.pendingCalls.clear();
      });

      this.socket.on('reconnect_attempt', (attempt: number) => {
        console.log(`[RemotePage] Reconnection attempt ${attempt}...`);
      });

      this.socket.on('reconnect_failed', () => {
        console.error(`[RemotePage] All reconnection attempts exhausted`);
      });
    });
  }

  /**
   * Wait for the bridge to become ready (after reconnect).
   */
  private waitForBridgeReady(timeoutMs = 10000): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.bridgeReady) { resolve(); return; }
      const timer = setTimeout(() => {
        this.socket?.off(BridgeEvent.Connected, handler);
        reject(new Error('Reconnection timeout: bridge not ready'));
      }, timeoutMs);
      const handler = () => {
        clearTimeout(timer);
        resolve();
      };
      this.socket?.once(BridgeEvent.Connected, handler);
    });
  }

  private async call(method: string, ...args: any[]): Promise<any> {
    // If temporarily disconnected, wait for auto-reconnection
    if (!this.bridgeReady && this.socket) {
      console.log(`[RemotePage] Waiting for reconnection before calling ${method}...`);
      await this.waitForBridgeReady(10000);
    }
    if (!this.bridgeReady || !this.socket?.connected) {
      throw new Error('Not connected to relay');
    }
    const id = String(this.callId++);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCalls.delete(id);
        reject(new Error(`Call timeout: ${method}`));
      }, 60000);

      this.pendingCalls.set(id, { resolve, reject, timeout });
      this.socket!.emit(BridgeEvent.Call, { id, method, args } as BridgeCallRequest);
    });
  }

  // ===== Tab management =====
  async connectNewTabWithUrl(url: string, options?: any): Promise<void> {
    await this.call('connectNewTabWithUrl', url, options);
  }

  async connectCurrentTab(options?: any): Promise<void> {
    await this.call('connectCurrentTab', options);
  }

  async getBrowserTabList(): Promise<any[]> {
    return await this.call('getBrowserTabList');
  }

  async setActiveTabId(tabId: number): Promise<void> {
    await this.call('setActiveTabId', tabId);
  }

  // ===== AbstractInterface implementation =====
  actionSpace(): DeviceAction[] {
    const page = this;
    return [
      defineActionTap(async (param) => {
        const el = param.locate;
        if (!el) throw new Error('Element not found');
        await page.mouse.click(el.center[0], el.center[1], { button: 'left' });
      }),
      defineActionRightClick(async (param) => {
        const el = param.locate;
        if (!el) throw new Error('Element not found');
        await page.mouse.click(el.center[0], el.center[1], { button: 'right' });
      }),
      defineActionDoubleClick(async (param) => {
        const el = param.locate;
        if (!el) throw new Error('Element not found');
        await page.mouse.click(el.center[0], el.center[1], { button: 'left', count: 2 });
      }),
      defineActionHover(async (param) => {
        const el = param.locate;
        if (!el) throw new Error('Element not found');
        await page.mouse.move(el.center[0], el.center[1]);
      }),
      defineActionInput(async (param) => {
        const el = param.locate;
        if (el && param.mode !== 'typeOnly') {
          await page.clearInput(el);
        } else if (el && param.mode === 'typeOnly') {
          await page.mouse.click(el.center[0], el.center[1], { button: 'left' });
        }
        if (param.mode === 'clear' || !param?.value) return;
        await page.keyboard.type(param.value);
      }),
      defineActionKeyboardPress(async (param) => {
        const el = param.locate;
        if (el) {
          await page.mouse.click(el.center[0], el.center[1], { button: 'left' });
        }
        const keys = Array.isArray(param.keyName) ? param.keyName : [param.keyName];
        await page.keyboard.press(keys.map((k: string) => ({ key: k })));
      }),
      defineActionScroll(async (param) => {
        const el = param.locate;
        const startingPoint = el ? { left: el.center[0], top: el.center[1] } : undefined;
        const scrollType = param?.scrollType;
        if (scrollType === 'scrollToTop') await page.scrollUntilTop(startingPoint);
        else if (scrollType === 'scrollToBottom') await page.scrollUntilBottom(startingPoint);
        else if (scrollType === 'scrollToRight') await page.scrollUntilRight(startingPoint);
        else if (scrollType === 'scrollToLeft') await page.scrollUntilLeft(startingPoint);
        else {
          const dir = param?.direction || 'down';
          const dist = param?.distance ?? undefined;
          if (dir === 'down') await page.scrollDown(dist, startingPoint);
          else if (dir === 'up') await page.scrollUp(dist, startingPoint);
          else if (dir === 'left') await page.scrollLeft(dist, startingPoint);
          else if (dir === 'right') await page.scrollRight(dist, startingPoint);
        }
      }),
      defineActionDragAndDrop(async (param) => {
        if (!param.from || !param.to) throw new Error('Missing from/to for drag');
        await page.mouse.drag(
          { x: param.from.center[0], y: param.from.center[1] },
          { x: param.to.center[0], y: param.to.center[1] },
        );
      }),
      defineActionClearInput(async (param) => {
        await page.clearInput(param.locate);
      }),
      defineActionLongPress(async (param) => {
        const el = param.locate;
        if (!el) throw new Error('Element not found');
        await page.longPress(el.center[0], el.center[1], param?.duration);
      }),
    ];
  }

  async screenshotBase64(): Promise<string> {
    return await this.call('screenshotBase64');
  }

  async getElementsNodeTree(): Promise<ElementTreeNode<any>> {
    return await this.call('getElementsNodeTree');
  }

  async size(): Promise<Size> {
    return await this.call('size');
  }

  async url(): Promise<string> {
    return await this.call('url');
  }

  async navigate(url: string): Promise<void> {
    await this.call('navigate', url);
  }

  async reload(): Promise<void> {
    await this.call('reload');
  }

  async goBack(): Promise<void> {
    await this.call('goBack');
  }

  async evaluateJavaScript(script: string): Promise<any> {
    return await this.call('evaluateJavaScript', script);
  }

  async beforeInvokeAction(): Promise<void> {
    await this.call('beforeInvokeAction');
  }

  async cacheFeatureForPoint(
    center: [number, number],
    options?: any,
  ): Promise<ElementCacheFeature> {
    return { xpaths: [] };
  }

  async rectMatchesCacheFeature(feature: ElementCacheFeature): Promise<Rect> {
    throw new Error('Cache feature not supported in remote mode');
  }

  // ===== Scroll =====
  async scrollUp(distance?: number, startingPoint?: Point): Promise<void> {
    await this.call('scrollUp', distance, startingPoint);
  }
  async scrollDown(distance?: number, startingPoint?: Point): Promise<void> {
    await this.call('scrollDown', distance, startingPoint);
  }
  async scrollLeft(distance?: number, startingPoint?: Point): Promise<void> {
    await this.call('scrollLeft', distance, startingPoint);
  }
  async scrollRight(distance?: number, startingPoint?: Point): Promise<void> {
    await this.call('scrollRight', distance, startingPoint);
  }
  async scrollUntilTop(startingPoint?: Point): Promise<void> {
    await this.call('scrollUntilTop', startingPoint);
  }
  async scrollUntilBottom(startingPoint?: Point): Promise<void> {
    await this.call('scrollUntilBottom', startingPoint);
  }
  async scrollUntilLeft(startingPoint?: Point): Promise<void> {
    await this.call('scrollUntilLeft', startingPoint);
  }
  async scrollUntilRight(startingPoint?: Point): Promise<void> {
    await this.call('scrollUntilRight', startingPoint);
  }

  // ===== Input =====
  mouse = {
    click: async (x: number, y: number, options?: any) => {
      await this.call('mouse.click', x, y, options);
    },
    wheel: async (deltaX: number, deltaY: number, startX?: number, startY?: number) => {
      await this.call('mouse.wheel', deltaX, deltaY, startX, startY);
    },
    move: async (x: number, y: number) => {
      await this.call('mouse.move', x, y);
    },
    drag: async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      await this.call('mouse.drag', from, to);
    },
  };

  keyboard = {
    type: async (text: string) => {
      await this.call('keyboard.type', text);
    },
    press: async (action: any) => {
      await this.call('keyboard.press', action);
    },
  };

  async clearInput(element: any): Promise<void> {
    if (!element) return;
    await this.mouse.click(element.center[0], element.center[1]);
    await this.keyboard.press({ key: 'Control' });
    await this.keyboard.press({ key: 'a' });
    await this.keyboard.press({ key: 'Backspace' });
  }

  async longPress(x: number, y: number, duration?: number): Promise<void> {
    await this.mouse.move(x, y);
    // Simple long press emulation
    await this.call('mouse.click', x, y, { button: 'left' });
  }

  async destroy(): Promise<void> {
    await this.call('destroy').catch(() => {});
    this.socket?.disconnect();
    this.socket = null;
  }

  async setDestroyOptions(options: any): Promise<void> {
    await this.call('setDestroyOptions', options);
  }
}

/**
 * Agent for remote Chrome control.
 */
export class RemoteAgent extends Agent<RemotePage> {
  constructor(page: RemotePage, opts?: AgentOpt) {
    super(page, opts);
  }

  async connectNewTabWithUrl(url: string, options?: any) {
    await this.page.connectNewTabWithUrl(url, options);
  }

  async connectCurrentTab(options?: any) {
    await this.page.connectCurrentTab(options);
  }

  async getBrowserTabList() {
    return await this.page.getBrowserTabList();
  }

  async setActiveTabId(tabId: string) {
    await this.page.setActiveTabId(Number(tabId));
  }
}

/**
 * Create a remote agent connected to a Chrome Relay.
 *
 * @example
 * ```typescript
 * const agent = await createRemoteAgent({
 *   relayUrl: 'ws://192.168.1.13:3766',
 * });
 * await agent.connectCurrentTab();
 * await agent.aiAct('click the login button');
 * ```
 */
export async function createRemoteAgent(
  options: {
    relayUrl: string;
  } & AgentOpt,
): Promise<RemoteAgent> {
  const { relayUrl, ...agentOpts } = options;
  const page = new RemotePage(relayUrl);
  await page.connect();
  return new RemoteAgent(page, agentOpts);
}
