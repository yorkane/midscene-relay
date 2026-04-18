/**
 * Playwright Demo - runs on machine B to control Chrome on machine A.
 *
 * Uses Playwright's connectOverCDP to connect through the relay's CDP proxy.
 * Combined with Midscene's PlaywrightAgent for AI-powered automation.
 *
 * Prerequisites:
 * 1. Machine A: Chrome running with --remote-debugging-port=9222
 * 2. Machine A: Relay server running (npm start)
 * 3. Machine B: Set RELAY_HOST and AI model env vars
 *
 * Usage:
 *   RELAY_HOST=A_IP npx tsx src/demo-playwright.ts
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import { PlaywrightAgent } from '@midscene/web/playwright';

const RELAY_HOST = process.env.RELAY_HOST || 'localhost';
const CDP_PROXY_PORT = process.env.CDP_PROXY_PORT || '9223';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cdpEndpoint = `http://${RELAY_HOST}:${CDP_PROXY_PORT}`;
  console.log(`Connecting to Chrome via CDP proxy: ${cdpEndpoint}`);

  // Connect to Chrome through the relay's CDP proxy
  const browser = await chromium.connectOverCDP(cdpEndpoint);
  console.log(`Connected! Contexts: ${browser.contexts().length}`);

  // Get existing context or create new one
  const context = browser.contexts()[0] || await browser.newContext();
  const page = context.pages()[0] || await context.newPage();

  // Navigate
  await page.goto('https://www.saucedemo.com/');
  await sleep(2000);

  // Init Midscene agent
  const agent = new PlaywrightAgent(page);

  // Login with AI
  await agent.aiAct('type "standard_user" in user name input');
  await agent.aiAct('type "secret_sauce" in password input');
  await agent.aiAct('click Login Button');
  await sleep(2000);

  // Assert login success
  await agent.aiAssert('the page title is "Swag Labs"');

  // Shopping
  await agent.aiAct('click "add to cart" for the first product');
  await sleep(500);
  await agent.aiAct('click the cart icon in the top right');
  await sleep(1000);

  await agent.aiAssert('The cart page is displayed with at least one item');

  console.log('Playwright automation completed successfully!');

  // Disconnect (don't close - the browser belongs to machine A)
  browser.close();
})();
