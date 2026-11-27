import { expect, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Project = { name: string; dir: string; port: number; age: string; user: string; password: string; panel: string };
export const state: { biz: string; org: string; logs: string; projects: { admin: Project; member: Project } } =
  JSON.parse(readFileSync(process.env.E2E_STATE!, "utf8"));

// Credentials come only from the environment (run.sh loads them from an untracked file). Never logged.
const env = (n: string) => process.env[n] ?? "";
export const creds = {
  admin: { email: env("E2E_BIZ_ADMIN_EMAIL"), password: env("E2E_BIZ_ADMIN_PASSWORD") },
  member: { email: env("E2E_BIZ_MEMBER_EMAIL"), password: env("E2E_BIZ_MEMBER_PASSWORD") },
};
export const hasCreds = Boolean(creds.admin.email && creds.admin.password && creds.member.email && creds.member.password && process.env.E2E_BIZ_ORG_API_KEY && !state.org.startsWith("e2e-preflight"));
export const SKIP_REASON = "needs E2E_BIZ_* credentials, E2E_BIZ_ORG and E2E_BIZ_ORG_API_KEY (see README)";

/** Run a command in a disposable project with a clean environment (nothing of the caller's projects leaks in). */
export function sh(p: Project, cmd: string, opts: { allowFail?: boolean } = {}): string {
  try {
    return execFileSync("bash", ["-c", cmd], {
      cwd: p.dir, encoding: "utf8", timeout: 170_000, stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: process.env.HOME!, PATH: process.env.PATH!, TERM: "dumb", LANG: "en_US.UTF-8", USER: process.env.USER ?? "e2e",
        MISE_SOPS_AGE_KEY_FILE: p.age, SOPS_AGE_KEY_FILE: p.age, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@example.invalid",
        GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@example.invalid" },
    });
  } catch (e: any) {
    if (opts.allowFail) return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    throw new Error(`command failed in ${p.name}: ${cmd}\n${e.stdout ?? ""}${e.stderr ?? ""}`.slice(0, 2000));
  }
}
export const secretNames = (p: Project) => sh(p, "mise exec -- sops decrypt --output-type json secrets.enc.yaml", { allowFail: true }).match(/"([A-Z][A-Z0-9_]*)":/g)?.map((s) => s.replace(/["':]/g, "")) ?? [];
export const grantFile = (p: Project) => join(p.dir, ".data/ext/biz/profile-oauth.json");
export const hasGrant = (p: Project) => existsSync(grantFile(p));
export const readFile = (p: Project, rel: string) => readFileSync(join(p.dir, rel), "utf8");

/**
 * The project's own web login (tinyauth at auth.<domain>). Without a Biz profile session the policy then
 * redirects the panel to the extension's sign-in page, so the page may end up there.
 */
export async function webLogin(page: Page, p: Project, path = "/?lang=en") {
  await page.goto(`${p.panel}${path}`);
  const user = page.getByPlaceholder("username");
  // Either the login form (no session yet) or, with a session, straight back on the panel host.
  await Promise.race([user.waitFor({ timeout: 30_000 }), page.waitForURL((u) => u.hostname.startsWith("panel."), { timeout: 30_000 })]).catch(() => undefined);
  if (await user.isVisible()) {
    await user.fill(p.user);
    await page.getByPlaceholder("password").fill(p.password);
    await page.getByRole("button", { name: /^log ?in$/i }).click();
    await page.waitForURL((u) => u.hostname.startsWith("panel."), { timeout: 30_000 });
  }
}

export const signInButton = (page: Page) => page.getByRole("button", { name: /continue with fyso biz|continuar con fyso biz/i });
/** Biz sign-in form (email + password; the organization is resolved from the email) and the consent screen. */
export async function bizSignInAndConsent(page: Page, who: { email: string; password: string }) {
  await page.waitForURL(`${state.biz}/**`, { timeout: 30_000 });
  const email = page.locator('input[type="email"]');
  await email.waitFor({ timeout: 20_000 }).catch(() => undefined);   // absent when Biz already has a session
  if (await email.isVisible()) {
    await page.locator('input[type="email"]').fill(who.email);
    await page.locator('input[type="password"]').fill(who.password);
    await page.locator('button[type="submit"]').click();
  }
  // Consent (es: Autorizar / en: Authorize); skipped when Biz already has a consent for this client.
  const allow = page.getByRole("button", { name: /^(autorizar|authorize|allow|permitir)/i });
  await Promise.race([
    allow.click({ timeout: 60_000 }).catch(() => undefined),
    page.waitForURL(/\/extensions\/biz\/oauth\/callback|#\/extensions\/biz/, { timeout: 60_000 }).catch(() => undefined),
  ]);
}

export function bizFrame(page: Page) { return page.frameLocator('iframe[title="Fyso Biz"], iframe[src*="extensions/biz"]'); }
/** Biz REST API with a session cookie obtained by the real login endpoint (admin only: used to freeze the member). */
export async function bizApi(browser: Browser, who: { email: string; password: string }): Promise<{ ctx: BrowserContext; request: APIRequestContext }> {
  const ctx = await browser.newContext({ baseURL: state.biz });
  const login = await ctx.request.post("/api/auth/login", { data: { email: who.email, password: who.password } });
  expect(login.status(), "Biz API login").toBe(200);
  return { ctx, request: ctx.request };
}
