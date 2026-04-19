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
        reconnection: false,
        transports: ['websocket'],
      });

      const timeout = setTimeout(() => {
        this.socket?.close();
        reject(new Error(`Failed to connect to relay at ${this.relayUrl}`));
      }, 15000);

      this.socket.on(BridgeEvent.Connected, () => {
        clearTimeout(timeout);
        console.log(`[RemotePage] Connected to relay at ${this.relayUrl}`);
        resolve();
      });

      this.socket.on(BridgeEvent.Refused, (reason: string) => {
        clearTimeout(timeout);
        reject(new Error(`Connection refused: ${reason}`));
      });

      this.socket.on('connect_error', (err: any) => {
        clearTimeout(timeout);
        reject(new Error(`Connect error: ${err?.message || err}`));
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

      this.socket.on('disconnect', () => {
        // Reject all pending calls
        for (const [id, pending] of this.pendingCalls) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('Disconnected from relay'));
        }
        this.pendingCalls.clear();
      });
    });
  }

  private async call(method: string, ...args: any[]): Promise<any> {
    if (!this.socket?.connected) {
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
