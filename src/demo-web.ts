/**
 * Demo script - runs on machine B to control Chrome on machine A.
 *
 * Prerequisites:
 * 1. Machine A: Chrome running with --remote-debugging-port=9222
 * 2. Machine A: Relay server running (npm start)
 * 3. Set environment variables for AI model
 *
 * Usage:
 *   DEMO_RELAY_URL=ws://A_IP:3768 npm run demo:web
 */
import 'dotenv/config';
import { createRemoteAgent } from './web-client';

const RELAY_URL = process.env.DEMO_RELAY_URL || 'ws://localhost:3768';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`Connecting to relay at ${RELAY_URL}...`);

  const generateReport = process.env.GENERATE_REPORT !== 'false';

  const agent = await createRemoteAgent({
    relayUrl: RELAY_URL,
    generateReport,
    aiActionContext:
      'If asked whether to save the password, click "Do Not Save" uniformly',
  });

  // Connect to a new tab
  await agent.connectNewTabWithUrl('https://www.saucedemo.com/');
  await sleep(2000);

  // Login
  await agent.aiAct('type "standard_user" in user name input');
  await agent.aiAct('type "secret_sauce" in password input');
  await agent.aiAct('click Login Button');
  await sleep(2000);

  // Check the login success
  await agent.aiAssert('the page title is "Swag Labs"');

  console.log('Shop automation completed successfully!');
  await agent.destroy();
})();
