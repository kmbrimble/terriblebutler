import { test as base, expect } from '@playwright/test';

// Every spec imports test/expect from here instead of '@playwright/test'. An auto fixture
// records Content-Security-Policy violations in every page of the test's browser context and
// fails the test if any occurred, so the server's CSP (lib/middleware.js) is enforced against
// all the flows the suite already exercises (login, inventory, scan, crop, invoice import).
// Two signals, because neither alone is complete: the in-page `securitypolicyviolation` event
// (precise, but only after the init script runs) and Chromium's console error for the same
// block (catches a violation that happens before any script, such as an inline <script>).
// The same fixture also fails a test on any unhandled promise rejection or uncaught page error,
// so a client handler that lets a failed request escape cannot pass quietly.
export const test = base.extend({
  cspViolations: [
    async ({ context }, use) => {
      const violations = [];
      const rejections = [];
      await context.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          // Surface through the console so the context-level listener below sees it.
          console.error(`CSP-VIOLATION ${e.violatedDirective} ${e.blockedURI}`);
        });
        window.addEventListener('unhandledrejection', (e) => {
          console.error(`UNHANDLED-REJECTION ${e.reason && e.reason.message ? e.reason.message : e.reason}`);
        });
      });
      context.on('console', (msg) => {
        const text = msg.text();
        if (msg.type() === 'error' && (text.startsWith('CSP-VIOLATION') || /Content[- ]Security[- ]Policy/i.test(text))) {
          violations.push(text);
        }
        if (msg.type() === 'error' && text.startsWith('UNHANDLED-REJECTION')) rejections.push(text);
      });
      context.on('page', (page) => page.on('pageerror', (err) => rejections.push(`pageerror ${err.message}`)));
      await use(violations);
      expect(violations, 'Content-Security-Policy violations').toEqual([]);
      expect(rejections, 'Unhandled promise rejections / uncaught page errors').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
