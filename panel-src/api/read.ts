// Panel reads go straight to the extension's private socket through the gateway
// (framework D79, ~0.3 s). On a framework without that route, or while the process is
// down, they fall back to the extension's Dagu workflows.

let direct: boolean | undefined;

async function viaGateway<T>(path:string, init?:RequestInit):Promise<T|undefined> {
  if (direct === false) return undefined;
  try {
    const response = await fetch(`/api/ext/biz/${path}`, {credentials:"same-origin", cache:"no-store", ...init, headers:{Accept:"application/json", ...init?.headers}});
    // An older gateway answers this path with the panel's own page, not JSON.
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) {
      direct = false;
      return undefined;
    }
    direct = true;
    return await response.json() as T;
  } catch {
    return undefined;
  }
}

/** Read from the extension, or from its Dagu workflow when the route is unavailable. */
export async function read<T>(path:string, fallback:()=>Promise<T|undefined>, init?:RequestInit):Promise<T|undefined> {
  return (await viaGateway<T>(path, init)) ?? fallback();
}

// The last good answer per read, for this tab only, so a screen shows it at once and
// refreshes in the background. Business data only: credentials never reach the page.
const KEY = "biz.cache.";
export function remembered<T>(key:string):T|undefined {
  try { const value = sessionStorage.getItem(KEY + key); return value ? JSON.parse(value) as T : undefined; } catch { return undefined; }
}
export function remember(key:string, value:unknown) {
  try { sessionStorage.setItem(KEY + key, JSON.stringify(value)); } catch { /* optional */ }
}
export function forget() {
  try { Object.keys(sessionStorage).filter(k=>k.startsWith(KEY)).forEach(k=>sessionStorage.removeItem(k)); } catch { /* optional */ }
}
