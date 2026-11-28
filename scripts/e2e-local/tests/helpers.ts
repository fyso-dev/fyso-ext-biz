import { expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Project = { name: string; dir: string; port: number; age: string; user: string; password: string; panel: string };
export const state: { biz: string; org: string; logs: string; projects: { admin: Project; member: Project } } =
  JSON.parse(readFileSync(process.env.E2E_STATE!, "utf8"));

// Personas come from the local stack's credentials.env, exported by run.sh (propietario = admin, miembro = member). Never logged.
const env = (n: string) => process.env[n] ?? "";
export const fakeFyso = { url: env("E2E_FAKE_FYSO_URL"), token: env("E2E_FAKE_FYSO_ADMIN_TOKEN") };
export const creds = {
  admin: { email: env("E2E_BIZ_ADMIN_EMAIL"), password: env("E2E_BIZ_ADMIN_PASSWORD") },
  member: { email: env("E2E_BIZ_MEMBER_EMAIL"), password: env("E2E_BIZ_MEMBER_PASSWORD") },
};
export const hasCreds = Boolean(creds.admin.email && creds.admin.password && creds.member.email && creds.member.password && fakeFyso.url && fakeFyso.token);
export const SKIP_REASON = "needs the local stack's credentials.env (run through run.sh; see README)";

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
  // Consent (es: Autorizar / en: Authorize); skipped when Biz already has a consent for this client. The page is a Next
  // app: a click before it hydrates does nothing, so click again until the redirect back to the project happens.
  const allow = page.getByRole("button", { name: /^(autorizar|authorize|allow|permitir)$/i });
  const back = () => new URL(page.url()).hostname !== new URL(state.biz).hostname;
  for (let attempt = 0; attempt < 5 && !back(); attempt++) {
    if (await allow.isVisible().catch(() => false)) await allow.click().catch(() => undefined);
    await page.waitForURL((u) => u.hostname !== new URL(state.biz).hostname, { timeout: 12_000 }).catch(() => undefined);
  }
}

export function bizFrame(page: Page) { return page.frameLocator('iframe[title="Fyso Biz"], iframe[src*="extensions/biz"]'); }
/** The local stack's fake Fyso: take a person's access away (and give it back). `deactivate` freezes them in Biz's report. */
export async function setPersonActive(email: string, active: boolean) {
  const response = await fetch(`${fakeFyso.url}/__admin/users/${active ? "reactivate" : "deactivate"}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${fakeFyso.token}` }, body: JSON.stringify({ email }),
  });
  expect(response.status, `fake-fyso ${active ? "reactivate" : "deactivate"}`).toBe(200);
}

/** Evidence: with E2E_SHOTS_DIR set, save a PNG of the page (panel and the Biz frame in it). Never of a sign-in form. */
export async function shot(page: Page, name: string) {
  const dir = process.env.E2E_SHOTS_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`) });
}
