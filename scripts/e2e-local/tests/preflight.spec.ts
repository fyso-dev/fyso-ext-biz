import { expect, test } from "@playwright/test";
import { signInButton, state, webLogin } from "./helpers";

// Credential-free checks: everything up to (not including) typing a Biz password.
const admin = state.projects.admin;
const bizOrigin = new URL(state.biz).origin;

test.describe.serial("@preflight panel before connecting", () => {
  test("@preflight Biz serves OAuth metadata for the local origin with the framework_access scope", async ({ request }) => {
    const meta = await (await request.get(`${state.biz}/.well-known/oauth-authorization-server`)).json();
    expect(meta.scopes_supported).toContain("framework_access");
    expect(new URL(meta.authorization_endpoint).origin).toBe(bizOrigin);
  });

  test("@preflight panel root sends an unconnected admin to the sign-in page, not to an error", async ({ page }) => {
    await webLogin(page, admin);
    await expect(page).toHaveURL(/\/api\/ext\/biz\/profile\/sign-in/);
    await expect(signInButton(page)).toBeVisible();
  });

  test("@preflight sign-in page CSP allows exactly the local Biz origin in form-action", async ({ page }) => {
    await webLogin(page, admin);   // API paths answer 401 instead of the login form: sign in through the root first
    const response = (await page.goto(`${admin.panel}/api/ext/biz/profile/sign-in`))!;
    expect(response.status()).toBe(200);
    const csp = response.headers()["content-security-policy"] ?? "";
    const formAction = /form-action ([^;]*)/.exec(csp)?.[1] ?? "";
    expect(formAction.split(/\s+/)).toContain(bizOrigin);
    expect(formAction).not.toContain("*");
  });

  test("@preflight sign-in button reaches Biz without a CSP violation", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()); });
    await webLogin(page, admin);   // API paths answer 401 instead of the login form: sign in through the root first
    await signInButton(page).click();
    await page.waitForURL(`${bizOrigin}/**`, { timeout: 30_000 });
    expect(violations).toEqual([]);
    // Dynamic client registration succeeded: Biz asks to sign in (login) or shows the consent screen.
    expect(page.url()).toMatch(/\/(login|oauth\/authorize)/);
  });

  test("@preflight the extension's own API answers behind the panel login", async ({ page }) => {
    await webLogin(page, admin);
    const response = (await page.goto(`${admin.panel}/api/ext/biz/profile/status`))!;
    expect(response.status()).toBe(200);
    expect((await response.json()).connected).toBe(false);
  });
});
