/**
 * Remote Computer Device Client - used on machine B to control machine A's desktop.
 *
 * Usage:
 *   import { createRemoteComputerAgent } from './computer-client';
 *   const agent = await createRemoteComputerAgent({
 *     relayUrl: 'ws://A_IP:3767',
 *   });
 *   await agent.aiAct('click the Start button');
 */
import { Agent, type AgentOpt } from '@midscene/core/agent';
import {
  type AbstractInterface,
  type DeviceAction,
  defineActionTap,
  defineActionRightClick,
  defineActionDoubleClick,
  defineActionInput,
  defineActionKeyboardPress,
  defineActionScroll,
  defineActionDragAndDrop,
  defineActionClearInput,
} from '@midscene/core/device';
import type {
  ElementCacheFeature,
  ElementTreeNode,
  InterfaceType,
  Point,
  Rect,
  Size,
} from '@midscene/core';
import { io as ClientIO, type Socket } from 'socket.io-client';

// Inline type for locate results (not publicly exported from @midscene/core/device)
interface LocateElement {
  center: [number, number];
  [key: string]: any;
}

// Bridge protocol events
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
 * Remote Computer Device - proxies all calls to the Computer Relay Server on Machine A.
 * Implements AbstractInterface so it can be used with Midscene Agent.
 */
export class RemoteComputerDevice implements AbstractInterface {
  interfaceType: InterfaceType = 'computer';
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
        reject(new Error(`Failed to connect to Computer Relay at ${this.relayUrl}`));
      }, 15000);

      this.socket.on(BridgeEvent.Connected, () => {
        clearTimeout(timeout);
        console.log(`[RemoteComputer] Connected to relay at ${this.relayUrl}`);
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
            pending.reject(new Error(typeof resp.error === 'string' ? resp.error : String(resp.error)));
          } else {
            pending.resolve(resp.response);
          }
        }
      });

      this.socket.on('disconnect', () => {
        for (const [, pending] of this.pendingCalls) {
          clearTimeout(pending.timeout);
          pending.reject(new Error('Disconnected from Computer Relay'));
        }
        this.pendingCalls.clear();
      });
    });
  }

  private async call(method: string, ...args: any[]): Promise<any> {
    if (!this.socket?.connected) {
      throw new Error('Not connected to Computer Relay');
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

  // ===== AbstractInterface implementation =====

  actionSpace(): DeviceAction[] {
    const device = this;
    return [
      defineActionTap(async (param) => {
        const el = param.locate as LocateElement;
        if (!el) throw new Error('Element not found');
        await device.call('mouse.click', el.center[0], el.center[1], { button: 'left' });
      }),
      defineActionRightClick(async (param) => {
        const el = param.locate as LocateElement;
        if (!el) throw new Error('Element not found');
        await device.call('mouse.click', el.center[0], el.center[1], { button: 'right' });
      }),
      defineActionDoubleClick(async (param) => {
        const el = param.locate as LocateElement;
        if (!el) throw new Error('Element not found');
        await device.call('mouse.click', el.center[0], el.center[1], { button: 'left', count: 2 });
      }),
      defineActionInput(async (param) => {
        const el = param.locate as LocateElement | undefined;
        if (el && param.mode !== 'append') {
          // Click to focus + select all + delete
          await device.call('mouse.click', el.center[0], el.center[1], { button: 'left' });
          const modifier = process.platform === 'darwin' ? 'command' : 'control';
          await device.call('keyboard.press', [{ key: `${modifier}+a` }]);
          await device.call('keyboard.press', [{ key: 'backspace' }]);
        } else if (el) {
          await device.call('mouse.click', el.center[0], el.center[1], { button: 'left' });
        }
        if (param.mode === 'clear' || !param?.value) return;
        await device.call('keyboard.type', param.value);
      }),
      defineActionKeyboardPress(async (param) => {
        const el = param.locate as LocateElement | undefined;
        if (el) {
          await device.call('mouse.click', el.center[0], el.center[1], { button: 'left' });
        }
        // param.keyName is "Ctrl+A" style string
        await device.call('keyboard.press', [{ key: param.keyName }]);
      }),
      defineActionScroll(async (param) => {
        const el = param.locate as LocateElement | undefined;
        if (el) {
          await device.call('mouse.move', el.center[0], el.center[1]);
        }
        const scrollType = param?.scrollType;
        if (scrollType === 'scrollToTop') { await device.call('scrollUntilTop'); return; }
        if (scrollType === 'scrollToBottom') { await device.call('scrollUntilBottom'); return; }
        if (scrollType === 'scrollToLeft') { await device.call('scrollUntilLeft'); return; }
        if (scrollType === 'scrollToRight') { await device.call('scrollUntilRight'); return; }
        const dir = param?.direction || 'down';
        const dist = param?.distance ?? undefined;
        if (dir === 'down') await device.call('scrollDown', dist);
        else if (dir === 'up') await device.call('scrollUp', dist);
        else if (dir === 'left') await device.call('scrollLeft', dist);
        else if (dir === 'right') await device.call('scrollRight', dist);
      }),
      defineActionDragAndDrop(async (param) => {
        const from = param.from as LocateElement;
        const to = param.to as LocateElement;
        if (!from || !to) throw new Error('Missing from/to for drag');
        await device.call('mouse.drag',
          { x: from.center[0], y: from.center[1] },
          { x: to.center[0], y: to.center[1] },
        );
      }),
      defineActionClearInput(async (param) => {
        const el = param.locate as LocateElement | undefined;
        if (!el) return;
        await device.call('mouse.click', el.center[0], el.center[1], { button: 'left' });
        const modifier = process.platform === 'darwin' ? 'command' : 'control';
        await device.call('keyboard.press', [{ key: `${modifier}+a` }]);
        await device.call('keyboard.press', [{ key: 'backspace' }]);
      }),
    ];
  }

  async screenshotBase64(): Promise<string> {
    return await this.call('screenshotBase64');
  }

  async size(): Promise<Size> {
    return await this.call('size');
  }

  async url(): Promise<string> {
    return '';
  }

  // Computer mode doesn't have element trees — AI operates on screenshots only
  async getElementsNodeTree(): Promise<ElementTreeNode<any>> {
    return { node: null, children: [] } as any;
  }

  async cacheFeatureForPoint(
    _center: [number, number],
    _options?: any,
  ): Promise<ElementCacheFeature> {
    return { xpaths: [] };
  }

  async rectMatchesCacheFeature(_feature: ElementCacheFeature): Promise<Rect> {
    throw new Error('Cache feature not supported in computer mode');
  }

  // Mouse & keyboard accessors (for actionSpace internal use)
  mouse = {
    click: async (x: number, y: number, options?: any) => {
      await this.call('mouse.click', x, y, options);
    },
    wheel: async (deltaX: number, deltaY: number) => {
      await this.call('mouse.wheel', deltaX, deltaY);
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

  async clearInput(element?: any): Promise<void> {
    if (!element) return;
    await this.mouse.click(element.center[0], element.center[1], { button: 'left' });
    const modifier = process.platform === 'darwin' ? 'command' : 'control';
    await this.keyboard.press([{ key: `${modifier}+a` }]);
    await this.keyboard.press([{ key: 'backspace' }]);
  }

  async destroy(): Promise<void> {
    await this.call('destroy').catch(() => {});
    this.socket?.disconnect();
    this.socket = null;
  }
}

/**
 * Agent for remote computer control.
 */
export class RemoteComputerAgent extends Agent<RemoteComputerDevice> {
  constructor(device: RemoteComputerDevice, opts?: AgentOpt) {
    super(device, opts);
  }
}

/**
 * Create a remote computer agent connected to a Computer Relay.
 *
 * @example
 * ```typescript
 * const agent = await createRemoteComputerAgent({
 *   relayUrl: 'ws://192.168.1.13:3767',
 * });
 * await agent.aiAct('open Chrome browser');
 * await agent.aiAct('type "hello world" in search box');
 * ```
 */
export async function createRemoteComputerAgent(
  options: {
    relayUrl: string;
  } & AgentOpt,
): Promise<RemoteComputerAgent> {
  const { relayUrl, ...agentOpts } = options;
  const device = new RemoteComputerDevice(relayUrl);
  await device.connect();
  return new RemoteComputerAgent(device, agentOpts);
}
