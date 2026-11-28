import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bizApi, bizFrame, bizSignInAndConsent, creds, grantFile, hasCreds, hasGrant, readFile, secretNames, sh, signInButton, SKIP_REASON, state, webLogin,
} from "./helpers";

// The whole story, through the real panel UI. Needs credentials; without them every test is skipped (never "passed").
const { admin, member } = state.projects;
const SETUP_TAB = /^(setup|configuración)$/i;
let adminCtx: BrowserContext, memberCtx: BrowserContext, adminPage: Page, memberPage: Page;
let frozenMember: { id: string; version: number; administrador: boolean; asignaciones: Record<string, unknown> } | null = null;
let adminApi: Awaited<ReturnType<typeof bizApi>> | null = null;

const setupTab = async (page: Page) => {
  const frame = bizFrame(page);
  await expect(frame.getByRole("tab", { name: SETUP_TAB })).toBeVisible({ timeout: 60_000 });
  await frame.getByRole("tab", { name: SETUP_TAB }).click();
  return frame;
};
const openSetup = async (page: Page, p: typeof admin) => {
  await webLogin(page, p, "/?lang=en#/extensions/biz/overview");
  return setupTab(page);
};
/** Sign in through the real flow: panel -> sign-in page -> Biz sign-in -> consent -> back in the panel. */
async function connect(page: Page, p: typeof admin, who: { email: string; password: string }) {
  await webLogin(page, p);
  await expect(signInButton(page)).toBeVisible();
  await signInButton(page).click();
  await bizSignInAndConsent(page, who);
  await page.waitForURL((u) => u.hostname.startsWith("panel.") && u.hash.includes("extensions/biz"), { timeout: 60_000 });
  return setupTab(page);
}
const grantToken = (p: typeof admin) => JSON.parse(readFileSync(grantFile(p), "utf8")).accessToken as string;
const access = async (p: typeof admin) =>
  fetch(`${state.biz}/oauth/framework-access?organization=${state.org}`, { headers: { Authorization: `Bearer ${grantToken(p)}` } });

test.describe.serial("sweep", () => {
  test.beforeEach(() => test.skip(!hasCreds, SKIP_REASON));
  test.beforeAll(async ({ browser }) => {
    if (!hasCreds) return;
    adminCtx = await browser.newContext(); memberCtx = await browser.newContext();
    adminPage = await adminCtx.newPage(); memberPage = await memberCtx.newPage();
  });
  test.afterAll(async () => {
    // Always give the member back the access the sweep removed.
    if (frozenMember && adminApi) {
      const list = await (await adminApi.request.get("/api/usuarios/listado")).json();
      const current = list.usuarios.find((u: any) => u.id === frozenMember!.id);
      await adminApi.request.patch(`/api/usuarios/${frozenMember.id}/acceso`, {
        data: { administrador: frozenMember.administrador, version: current?.versionRegistro ?? 0, asignaciones: frozenMember.asignaciones },
      });
    }
    await adminApi?.ctx.close();
  });

  test("admin: panel -> sign-in -> Biz login -> consent -> back; Setup tab visible before connecting", async () => {
    const frame = await connect(adminPage, admin, creds.admin);
    // Before Preview/confirm: signed in, not yet applied. The tab and its Connect action must already be there.
    await expect(frame.getByRole("heading", { name: /organization setup|setup de la organización/i })).toBeVisible();
    await expect(frame.getByRole("button", { name: /connect and review changes|conectar y revisar/i })).toBeVisible();
  });

  test("admin: preview and apply, then the organization's framework access is NOT 503", async () => {
    const frame = await setupTab(adminPage);
    await frame.getByRole("button", { name: /connect and review changes|conectar y revisar/i }).click();
    await expect(frame.getByRole("group", { name: /what will change|qué va a cambiar/i })).toBeVisible();
    await frame.getByRole("button", { name: /apply the setup|aplicar el setup/i }).click();
    await expect(frame.getByText(/setup applied|setup aplicado/i)).toBeVisible();
    expect(hasGrant(admin), "profile grant kept after connecting").toBe(true);
    const response = await access(admin);
    expect(response.status(), "/oauth/framework-access for the org admin").toBe(200);
    expect((await response.json()).admin).toBe(true);
    // The panel root keeps answering for the admin once connected.
    expect((await adminPage.request.get(`${admin.panel}/`)).status()).toBeLessThan(500);
  });

  test("admin: publish the setup", async () => {
    const frame = await setupTab(adminPage);
    await frame.getByRole("button", { name: /publish this project's setup|publicar el setup/i }).click();
    await expect(frame.getByText(/setup published|setup publicado/i)).toBeVisible({ timeout: 120_000 });
    const body = await (await access(admin)).json();
    expect(body.setup?.version).toBe("v1");
  });

  test("member: connect, preview warns about what changes, confirm, sync applies", async () => {
    const frame = await connect(memberPage, member, creds.member);
    await frame.getByRole("button", { name: /connect and review changes|conectar y revisar/i }).click();
    const group = frame.getByRole("group", { name: /what will change|qué va a cambiar/i });
    await expect(group).toBeVisible({ timeout: 120_000 });
    await expect(group.getByRole("alert")).toContainText(/replace|reemplaz/i);
    await expect(group.getByText("project/wiki/welcome.md")).toBeVisible();
    await group.getByRole("button", { name: /apply the setup|aplicar el setup/i }).click();
    await expect(frame.getByText(/setup applied|setup aplicado/i)).toBeVisible({ timeout: 180_000 });
    expect(readFile(member, "project/wiki/welcome.md")).toContain("line1");
    expect(hasGrant(member)).toBe(true);
  });

  test("admin republishes for the member's new key; member sync delivers the secret", async () => {
    // The admin's own sync republishes when recipients are pending.
    sh(admin, "mise run biz:setup:sync", { allowFail: false });
    sh(member, "mise run biz:setup:sync");
    expect(secretNames(member)).toContain("ORG_API_KEY");
  });

  test("admin changes the setup and publishes; member sync applies the change", async () => {
    writeFileSync(join(admin.dir, "project/wiki/x.md"), "X v2\n");
    sh(admin, "git add -A && git commit -q -m 'admin: x v2'");
    const frame = await setupTab(adminPage);
    await adminPage.reload(); await setupTab(adminPage);
    await bizFrame(adminPage).getByRole("button", { name: /publish this project's setup|publicar el setup/i }).click();
    await expect(bizFrame(adminPage).getByText(/setup published|setup publicado/i)).toBeVisible({ timeout: 120_000 });
    sh(member, "mise run biz:setup:sync");
    expect(readFile(member, "project/wiki/x.md")).toContain("X v2");
    void frame;
  });

  test("a failing preview does not delete the connected member's grant", async () => {
    await setupTab(memberPage);
    const dist = join(member.dir, "framework/scripts/dist.cjs");
    renameSync(dist, `${dist}.off`);
    try {
      const result = await memberPage.evaluate(async () => {
        const r = await fetch("/api/ext/biz/profile/setup/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      });
      expect(result.status).toBeGreaterThanOrEqual(400);
    } finally { renameSync(`${dist}.off`, dist); }
    expect(hasGrant(member), "grant file still there").toBe(true);
    const status = await memberPage.evaluate(async () => (await fetch("/api/ext/biz/profile/setup/status")).json());
    expect(status.connected).toBe(true);
  });

  test("freeze the member in Biz: read-only and the delivered secret is removed", async ({ browser }) => {
    adminApi = await bizApi(browser, creds.admin);
    const list = await (await adminApi.request.get("/api/usuarios/listado")).json();
    const person = list.usuarios.find((u: any) => u.email.toLowerCase() === creds.member.email.toLowerCase());
    expect(person, "member listed in the organization").toBeTruthy();
    frozenMember = { id: person.id, version: person.versionRegistro ?? 0, administrador: person.rol === "admin", asignaciones: person.rolesDepartamento ?? {} };
    const patched = await adminApi.request.patch(`/api/usuarios/${person.id}/acceso`, {
      data: { administrador: false, version: frozenMember.version, asignaciones: {} },
    });
    expect(patched.status(), "freeze through Biz admin API").toBe(200);

    sh(member, "mise run biz:setup:sync");
    expect(secretNames(member)).not.toContain("ORG_API_KEY");
    const frame = await openSetup(memberPage, member);
    await expect(frame.getByRole("alert").filter({ hasText: /revoked|revoc/i })).toBeVisible({ timeout: 60_000 });
    const status = await memberPage.evaluate(async () => (await fetch("/api/ext/biz/profile/setup/status")).json());
    expect(status.frozen).toBe(true);
  });
});
