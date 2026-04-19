/**
 * Demo: Remote Computer Control via Computer Relay.
 *
 * This script runs on machine B and controls machine A's desktop.
 *
 * Prerequisites:
 * 1. Machine A: Relay server running with ENABLE_COMPUTER_RELAY=true
 * 2. Set environment variables for AI model
 *
 * Usage:
 *   DEMO_COMPUTER_RELAY_URL=ws://A_IP:3767 npm run demo:computer
 */
import 'dotenv/config';
import { createRemoteComputerAgent } from './computer-client';

const COMPUTER_RELAY_URL = process.env.DEMO_COMPUTER_RELAY_URL || 'ws://localhost:3767';
const generateReport = process.env.GENERATE_REPORT !== 'false';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const IS_MAC = process.platform === 'darwin';

/**
 * Open a browser using desktop AI actions.
 */
async function openBrowserAndNavigate(
  agent: Awaited<ReturnType<typeof createRemoteComputerAgent>>,
  url: string,
): Promise<void> {
  if (IS_MAC) {
    await agent.aiAct('press Cmd+Space');
    await sleep(500);
    await agent.aiAct('type "Safari" and press Enter');
    await sleep(2000);
    await agent.aiAct('press Cmd+L to focus address bar');
  } else {
    await agent.aiAct('press Super key to open start menu');
    await sleep(500);
    await agent.aiAct('type "Chrome" and press Enter');
    await sleep(2000);
    await agent.aiAct('press Ctrl+L to focus address bar');
  }
  await sleep(300);
  await agent.aiAct(`type "${url}"`);
  await agent.aiAct('press Enter');
  await sleep(3000);
}

(async () => {
  console.log(`Connecting to Computer Relay at ${COMPUTER_RELAY_URL}...`);

  const agent = await createRemoteComputerAgent({
    relayUrl: COMPUTER_RELAY_URL,
    generateReport,
    aiActionContext:
      'If asked whether to save the password, click "Do Not Save" uniformly. This is a remote desktop controlled via relay.',
  });

  // Take a screenshot to verify connection
  console.log('Connection established! Taking initial screenshot...');

  // Navigate to saucedemo
  await openBrowserAndNavigate(agent, 'https://www.saucedemo.com/');

  // Login
  await agent.aiAssert('The login form is visible');
  await agent.aiAct('type "standard_user" in user name input');
  await agent.aiAct('type "secret_sauce" in password input');
  await agent.aiAct('click Login Button');
  await sleep(2000);

  // Check login success
  await agent.aiAssert('the page title is "Swag Labs"');

  console.log('Computer automation completed successfully!');
})();
