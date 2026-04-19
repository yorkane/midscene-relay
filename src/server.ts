/**
 * Midscene Relay Server - runs on machine A to expose desktop control.
 *
 * Starts a Computer Relay (Socket.IO on 0.0.0.0:3767) so that
 * machine B can remotely control this machine's mouse, keyboard, and screen.
 */
import 'dotenv/config';
import { ComputerRelayServer } from './computer-server';

const DEFAULT_RELAY_HOST = '0.0.0.0';

async function main() {
  const host = process.env.RELAY_HOST || DEFAULT_RELAY_HOST;
  const computerRelayPort = Number(process.env.COMPUTER_RELAY_PORT) || 3767;

  console.log('=== Midscene Relay ===');
  console.log(`Computer relay: ${host}:${computerRelayPort}`);
  console.log('');

  const computerRelay = new ComputerRelayServer({ host, port: computerRelayPort });

  process.on('SIGINT', async () => {
    console.log('\n[Relay] Shutting down...');
    await computerRelay.stop();
    process.exit(0);
  });

  try {
    await computerRelay.start();
    console.log('');
    console.log('[Relay] Ready! Waiting for connections...');
    console.log('[Relay] Computer:  ws://<this-ip>:' + computerRelayPort);
  } catch (err) {
    console.error('[Relay] Failed to start:', err);
    process.exit(1);
  }
}

main();
