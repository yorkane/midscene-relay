/**
 * Midscene Relay Server - runs on machine A.
 *
 * Supports two relay channels (each independently toggled via env vars):
 * - Web Relay:      Chrome CDP bridge for midscene/web (Socket.IO + CDP proxy)
 * - Computer Relay: Desktop control bridge for midscene/computer (libnut)
 */
import 'dotenv/config';
import { ComputerRelayServer } from './computer-server';
import { WebRelayServer } from './web-server';

const DEFAULT_RELAY_HOST = '0.0.0.0';

async function main() {
  const host = process.env.RELAY_HOST || DEFAULT_RELAY_HOST;

  // Web Relay config
  const cdpUrl = process.env.CDP_URL || 'http://127.0.0.1:9222';
  const webRelayPort = Number(process.env.RELAY_PORT) || 3766;
  const cdpProxyPort = Number(process.env.CDP_PROXY_PORT) || 9223;
  const enableWebRelay = process.env.ENABLE_WEB_RELAY === 'true';
  const enableCdpProxy = process.env.ENABLE_CDP_PROXY === 'true';

  // Computer Relay config
  const computerRelayPort = Number(process.env.COMPUTER_RELAY_PORT) || 3767;
  const enableComputerRelay = process.env.ENABLE_COMPUTER_RELAY === 'true';

  console.log('=== Midscene Relay ===');
  if (enableWebRelay) console.log(`Web SDK relay:  ${host}:${webRelayPort}  (CDP: ${cdpUrl})`);
  if (enableCdpProxy) console.log(`CDP proxy:      ${host}:${cdpProxyPort}`);
  if (enableComputerRelay) console.log(`Computer relay: ${host}:${computerRelayPort}`);
  if (!enableWebRelay && !enableCdpProxy && !enableComputerRelay) {
    console.log('WARNING: No relay channels enabled! Set ENABLE_WEB_RELAY, ENABLE_CDP_PROXY, or ENABLE_COMPUTER_RELAY to true.');
  }
  console.log('');

  let webRelay: WebRelayServer | null = null;
  let computerRelay: ComputerRelayServer | null = null;

  process.on('SIGINT', async () => {
    console.log('\n[Relay] Shutting down...');
    if (webRelay) await webRelay.stop();
    if (computerRelay) await computerRelay.stop();
    process.exit(0);
  });

  try {
    // Start Web Relay (SDK bridge + optional CDP proxy)
    if (enableWebRelay || enableCdpProxy) {
      webRelay = new WebRelayServer({ cdpUrl, host, port: webRelayPort, cdpProxyPort });
      if (enableWebRelay) {
        await webRelay.start();
      }
      if (enableCdpProxy) {
        await webRelay.startCdpProxy();
      }
    }

    // Start Computer Relay
    if (enableComputerRelay) {
      computerRelay = new ComputerRelayServer({ host, port: computerRelayPort });
      await computerRelay.start();
    }

    console.log('');
    console.log('[Relay] Ready! Waiting for connections...');
    if (enableWebRelay) console.log('[Relay] Midscene SDK:  ws://<this-ip>:' + webRelayPort);
    if (enableCdpProxy) console.log('[Relay] Playwright:    chromium.connectOverCDP("http://<this-ip>:' + cdpProxyPort + '")');
    if (enableComputerRelay) console.log('[Relay] Computer:      ws://<this-ip>:' + computerRelayPort);
  } catch (err) {
    console.error('[Relay] Failed to start:', err);
    process.exit(1);
  }
}

main();
