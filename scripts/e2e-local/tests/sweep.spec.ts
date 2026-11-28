import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { existsSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bizFrame, bizSignInAndConsent, creds, grantFile, hasCreds, hasGrant, readFile, secretNames, setPersonActive, sh, shot, signInButton, SKIP_REASON, state, webLogin,
} from "./helpers";

// The whole story, through the real panel UI. Needs credentials; without them every test is skipped (never "passed").
const { admin, member } = state.projects;
const SETUP_TAB = /^(setup|configuración)$/i;
let adminCtx: BrowserContext, memberCtx: BrowserContext, adminPage: Page, memberPage: Page;
let memberFrozen = false;

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
/**
 * Sign in through the real flow: panel -> sign-in page -> Biz sign-in -> consent -> back in the panel. One consent (the
 * profile grant) is all the Setup tab needs: it is visible right after it, without the agent grant.
 */
async function connect(page: Page, p: typeof admin, who: { email: string; password: string }) {
  await webLogin(page, p);
  await expect(signInButton(page)).toBeVisible();
  await signInButton(page).click();
  await bizSignInAndConsent(page, who);
  await page.waitForURL((u) => u.hostname.startsWith("panel.") && u.hash.includes("extensions/biz"), { timeout: 60_000 });
  return setupTab(page);
}
/** Publish through the two-step UI: the preview ("What will be published"), then "Confirm publication". */
async function publish(page: Page, version: string, evidence?: string) {
  const frame = bizFrame(page);
  await frame.getByRole("button", { name: /publish this project's setup|publicar el setup/i }).click();
  const group = frame.getByRole("group", { name: /what will be published|qué se va a publicar/i });
  await expect(group).toBeVisible({ timeout: 120_000 });
  if (evidence) await shot(page, `${evidence}-preview`);
  await group.getByRole("button", { name: /confirm publication|confirmar la publicación/i }).click();
  await expect(frame.getByText(/^(setup (v\d+ )?published\.?|setup (v\d+ )?publicado\.?)$/i)).toBeVisible({ timeout: 120_000 });
  await expectSetupVersion(page, version);
}
/**
 * Right after a publish the Setup screen must say the same version everywhere: the status line ("Connected. Setup vN
 * published by this project.") and the notices. A stale gateway cache showed "Setup vN published" above "Setup vN-1 applied".
 */
async function expectSetupVersion(page: Page, version: string) {
  const frame = bizFrame(page);
  const n = Number(version.slice(1));
  await expect(frame.getByText(new RegExp(`^Connected\\. Setup ${version} (published by this project|applied)\\.?$`))).toBeVisible({ timeout: 60_000 });
  for (let older = 1; older < n; older++) {
    await expect(frame.getByText(new RegExp(`^Connected\\. Setup v${older} `)), `the status line still says v${older}`).toHaveCount(0);
  }
}
const grantToken = (p: typeof admin) => JSON.parse(readFileSync(grantFile(p), "utf8")).accessToken as string;
const bizGet = (p: typeof admin, path: string) => fetch(`${state.biz}${path}`, { headers: { Authorization: `Bearer ${grantToken(p)}` } });
const access = (p: typeof admin) => bizGet(p, `/oauth/framework-access?organization=${state.org}`);
const recipients = async (p: typeof admin) => (await (await bizGet(p, `/oauth/framework-access/recipients?organization=${state.org}`)).json()).recipients as Array<{ person_id: string }>;
const personId = async (p: typeof admin) => (await (await bizGet(p, "/oauth/userinfo")).json()).sub as string;

test.describe.serial("sweep", () => {
  test.beforeEach(() => test.skip(!hasCreds, SKIP_REASON));
  // On failure, keep what each panel's Biz frame said (text only: no typed values are recorded).
  test.afterEach(async ({}, info) => {
    if (info.status === info.expectedStatus) return;
    for (const [name, page] of [["admin", adminPage], ["member", memberPage]] as const) {
      const text = await bizFrame(page).locator("body").ariaSnapshot({ timeout: 5_000 }).catch(() => "(no Biz frame)");
      await info.attach(`${name}-biz-frame`, { body: text, contentType: "text/plain" });
    }
  });
  test.beforeAll(async ({ browser }) => {
    if (!hasCreds) return;
    const viewport = { width: 1360, height: 1000 };
    adminCtx = await browser.newContext({ viewport }); memberCtx = await browser.newContext({ viewport });
    adminPage = await adminCtx.newPage(); memberPage = await memberCtx.newPage();
  });
  test.afterAll(async () => {
    // Always give the member back the access the sweep removed (fake-fyso reactivate).
    if (memberFrozen) await setPersonActive(creds.member.email, true);
  });

  test("admin: panel -> sign-in -> Biz login -> consent -> back; Setup tab visible right after the profile sign-in", async () => {
    const frame = await connect(adminPage, admin, creds.admin);
    // Before Preview/confirm: signed in, not yet applied. The tab and its Connect action must already be there.
    await expect(frame.getByRole("heading", { name: /organization setup|setup de la organización/i })).toBeVisible();
    await expect(frame.getByRole("button", { name: /connect and review changes|conectar y revisar/i })).toBeVisible();
    await shot(adminPage, "01-admin-setup-after-profile-sign-in");
  });

  test("admin: preview and apply, then the organization's framework access is NOT 503", async () => {
    const frame = await setupTab(adminPage);
    await frame.getByRole("button", { name: /connect and review changes|conectar y revisar/i }).click();
    await expect(frame.getByRole("group", { name: /what will change|qué va a cambiar/i })).toBeVisible();
    await frame.getByRole("button", { name: /apply the setup|aplicar el setup/i }).click();
    await expect(frame.getByText(/setup applied|setup aplicado/i)).toBeVisible();
    await shot(adminPage, "02-admin-setup-applied");
    expect(hasGrant(admin), "profile grant kept after connecting").toBe(true);
    const response = await access(admin);
    expect(response.status, "/oauth/framework-access for the org admin").toBe(200);
    expect((await response.json()).admin).toBe(true);
    // The panel root keeps answering for the admin once connected.
    expect((await adminPage.request.get(`${admin.panel}/`)).status()).toBeLessThan(500);
  });

  test("admin: publish the setup", async () => {
    const frame = await setupTab(adminPage);
    await publish(adminPage, "v1", "03-admin-publish"); void frame;
    const body = await (await access(admin)).json();
    expect(body.setup?.version, "the first publish of a fresh organization (run.sh --fresh)").toBe("v1");
    await shot(adminPage, "04-admin-setup-published-v1");
  });

  test("member: connect, preview warns about what changes", async () => {
    const frame = await connect(memberPage, member, creds.member);
    await frame.getByRole("button", { name: /connect and review changes|conectar y revisar/i }).click();
    const group = frame.getByRole("group", { name: /what will change|qué va a cambiar/i });
    await expect(group).toBeVisible({ timeout: 120_000 });
    await expect(group.getByRole("alert")).toContainText(/replace|reemplaz/i);
    // The lists are collapsed (<details>): open "Files replaced (n)".
    await group.getByText(/^(files replaced|archivos reemplazados)/i).click();
    await expect(group.getByText("project/wiki/welcome.md")).toBeVisible();
    await shot(memberPage, "05-member-preview-warns-replace");
    expect(hasGrant(member)).toBe(true);
  });

  test("member: confirm, the setup is applied", async () => {
    test.setTimeout(480_000);
    const frame = bizFrame(memberPage);
    const group = frame.getByRole("group", { name: /what will change|qué va a cambiar/i });
    await group.getByRole("button", { name: /apply the setup|aplicar el setup/i }).click();
    await expect(frame.getByText(/setup applied|setup aplicado/i)).toBeVisible({ timeout: 180_000 });
    expect(readFile(member, "project/wiki/welcome.md")).toContain("line1");
    await shot(memberPage, "06-member-setup-applied");
    // The v1 bundle was sealed before the member had a key: no secret yet.
    expect(secretNames(member)).not.toContain("ORG_API_KEY");
  });

  test("admin republishes for the member's new key; member sync delivers the secret", async () => {
    // Biz lists the member (who registered a key when applying) and counts the people with access and no key.
    expect((await recipients(admin)).map((r) => r.person_id), "the member's key is listed").toContain(await personId(member));
    const before = await (await access(admin)).json();
    expect(before.setup?.version).toBe("v1");
    expect(before.recipients_pending, "people with access and no key are counted").toBeGreaterThan(0);
    // The admin's own sync republishes when recipients are pending.
    sh(admin, "mise run biz:setup:sync", { allowFail: false });
    expect((await (await access(admin)).json()).setup?.version, "the admin's sync republished for the new key").toBe("v2");
    sh(member, "mise run biz:setup:sync");
    expect(secretNames(member)).toContain("ORG_API_KEY");
  });

  test("admin changes the setup and publishes; member sync applies the change", async () => {
    writeFileSync(join(admin.dir, "project/wiki/x.md"), "X v2\n");
    sh(admin, "git add -A && git commit -q -m 'admin: x v2'");
    const frame = await setupTab(adminPage);
    await adminPage.reload(); await setupTab(adminPage);
    await publish(adminPage, "v3");
    expect((await (await access(admin)).json()).setup?.version, "the publish follows the numeric order").toBe("v3");
    sh(member, "mise run biz:setup:sync");
    expect(readFile(member, "project/wiki/x.md")).toContain("X v2");
    void frame;
  });

  test("a failing preview does not delete the member's grant", async () => {
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
    // The grant still works: the status endpoint answers (403 would mean the profile session was lost).
    const status = await memberPage.evaluate(async () => (await fetch("/api/ext/biz/profile/setup/status")).status);
    expect(status).toBe(200);
  });

  test("member: the agent connection is its own consent, separate from the profile sign-in", async () => {
    const frame = bizFrame(memberPage);
    const agentGrant = join(member.dir, ".data/ext/biz/oauth.json");
    expect(existsSync(agentGrant), "the profile sign-in did not connect the agent").toBe(false);
    const hero = frame.getByRole("link", { name: /^(connect to fyso business|conectar con fyso business)/i });
    await expect(hero).toBeVisible({ timeout: 60_000 });
    await hero.click();
    await bizSignInAndConsent(memberPage, creds.member);
    await memberPage.waitForURL((u) => u.hostname.startsWith("panel.") && u.hash.includes("extensions/biz"), { timeout: 60_000 });
    await expect(bizFrame(memberPage).getByRole("tab", { name: /^(teams|equipos)$/i })).toBeVisible({ timeout: 60_000 });
    expect(existsSync(agentGrant), "the agent grant is saved").toBe(true);
    expect(hasGrant(member), "and the profile grant is still there").toBe(true);
  });

  test("member: once the agent is connected the managed teams are delivered", async ({}, info) => {
    test.setTimeout(300_000);
    const out = sh(member, "mise exec -- node extensions/biz/managed-teams.cjs 2>&1", { allowFail: true });
    await info.attach("managed-teams-output", { body: out.replace(/age1[0-9a-z]+/g, "age1…"), contentType: "text/plain" });
    expect(out, "the delivery did not fail").not.toMatch(/failed|apply_failed|not offered/i);
    // What Biz exports for the member's departments is now in the project: its bots, tracked in biz-teams.json.
    const delivered = JSON.parse(readFile(member, "project/biz-teams.json")).departments as Record<string, { bots: string[]; pending?: boolean }>;
    const bots = Object.values(delivered).flatMap((d) => d.bots);
    expect(bots.length, "at least one Biz team's bot was delivered").toBeGreaterThan(0);
    expect(bots).toContain("Asistente Transversal");
    expect(Object.values(delivered).every((d) => d.pending !== true), "nothing is left pending").toBe(true);
    expect(readFile(member, "project/bots/team.yaml")).toContain("Asistente Transversal");
    await memberPage.reload();
    const frame = bizFrame(memberPage);
    await expect(frame.getByRole("tab", { name: /^(teams|equipos)$/i })).toBeVisible({ timeout: 60_000 });
    await frame.getByRole("tab", { name: /^(teams|equipos)$/i }).click();
    await expect(frame.getByRole("heading", { name: /Transversal/ })).toBeVisible({ timeout: 60_000 });
    await expect(frame.getByText("Asistente Transversal")).toBeVisible();
    // The check of the departments is a workflow run this read-only member may not make: no error banner, an honest line.
    await expect(frame.getByRole("alert"), "the Teams tab shows no error").toHaveCount(0);
    await expect(frame.getByText(/your access to this project is read-only/i)).toBeVisible();
    const teamActions = frame.locator(".biz-team .connector-actions").getByRole("button");
    expect(await teamActions.count()).toBeGreaterThan(0);
    for (const action of await teamActions.all()) await expect(action).toBeDisabled();
    await shot(memberPage, "08-member-teams-delivered");
  });

  test("freeze the member (fake-fyso deactivates them): read-only and the delivered secret is removed", async () => {
    await setPersonActive(creds.member.email, false);
    memberFrozen = true;

    sh(member, "mise run biz:setup:sync");
    expect(secretNames(member)).not.toContain("ORG_API_KEY");
    const frame = await openSetup(memberPage, member);
    await expect(frame.getByRole("alert").filter({ hasText: /revoked|revoc/i })).toBeVisible({ timeout: 60_000 });
    await shot(memberPage, "07-member-frozen-read-only");
    const status = await memberPage.evaluate(async () => (await fetch("/api/ext/biz/profile/setup/status")).json());
    expect(status.frozen).toBe(true);
  });
});
