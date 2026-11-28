// Prints the SQL that registers the E2E organization in the LOCAL Biz tenant directory (D1).
// Biz resolves the organization's Fyso API key only from that directory, so a local Biz cannot
// serve the organization without it. The key is read from the environment, encrypted with the
// local TENANT_CREDENTIALS_KEY (same AES-GCM format as src/modules/directorio-tenants/cifrado-credenciales.ts)
// and never printed anywhere but into the SQL file the caller writes with mode 600 and deletes.
import { webcrypto as crypto } from "node:crypto";

const { E2E_BIZ_ORG: slug, E2E_BIZ_ORG_API_KEY: apiKey, TENANT_CREDENTIALS_KEY: masterKey } = process.env;
const tenantId = process.env.E2E_BIZ_ORG_TENANT_ID || null;
const schemaVersion = Number(process.env.E2E_BIZ_ORG_SCHEMA_VERSION || 23);
if (!slug || !apiKey || !masterKey) { console.error("seed-tenant: E2E_BIZ_ORG, E2E_BIZ_ORG_API_KEY and TENANT_CREDENTIALS_KEY are required"); process.exit(2); }
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(slug) || !Number.isInteger(schemaVersion)) { console.error("seed-tenant: invalid slug or schema version"); process.exit(2); }

const key = await crypto.subtle.importKey("raw", Buffer.from(masterKey, "base64"), "AES-GCM", false, ["encrypt"]);
const iv = crypto.getRandomValues(new Uint8Array(12));
const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(apiKey)));
const blob = Buffer.concat([Buffer.from(iv), Buffer.from(cipher)]).toString("base64");
const now = new Date().toISOString();
const q = (v) => (v === null ? "NULL" : `'${String(v).replaceAll("'", "''")}'`);
process.stdout.write(
  `DELETE FROM tenants_directorio WHERE fyso_tenant_slug = ${q(slug)};\n` +
  `INSERT INTO tenants_directorio (fyso_tenant_id, fyso_tenant_slug, api_key_cifrada, cron_enabled, provisioning_status, creado_en, actualizado_en, schema_version) ` +
  `VALUES (${q(tenantId)}, ${q(slug)}, ${q(blob)}, 0, 'completado', ${q(now)}, ${q(now)}, ${schemaVersion});\n`,
);
