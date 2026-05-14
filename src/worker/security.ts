import { Env } from "./types";

export interface BaseUrlValidation {
  ok: boolean;
  normalized?: string;
  error?: string;
}

const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
  "169.254.169.254",
]);

export function normalizeSpaceName(spaceName: string): { displayName: string; key: string } {
  const displayName = spaceName.trim().replace(/\s+/g, " ");
  return { displayName, key: displayName.toLowerCase() };
}

export function validateBaseURL(value: string): BaseUrlValidation {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return { ok: false, error: "baseURL 必须是合法 URL。" };
  }

  if (url.protocol !== "https:") {
    return { ok: false, error: "baseURL 必须使用 HTTPS。" };
  }

  if (url.username || url.password) {
    return { ok: false, error: "baseURL 不能包含用户名或密码。" };
  }

  if (url.search || url.hash) {
    return { ok: false, error: "baseURL 不能包含查询参数或 hash。" };
  }

  const hostname = url.hostname.toLowerCase();
  if (!hostname || BLOCKED_HOSTS.has(hostname) || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return { ok: false, error: "baseURL 主机不允许访问。" };
  }

  if (isIpLiteral(hostname)) {
    return { ok: false, error: "baseURL 不允许使用 IP 地址，请使用公开域名。" };
  }

  const normalizedPath = url.pathname.replace(/\/+$/, "");
  url.pathname = normalizedPath === "/" ? "" : normalizedPath;
  return { ok: true, normalized: url.toString().replace(/\/$/, "") };
}

export function buildProviderEndpoint(baseURL: string, endpoint: string): string {
  const base = new URL(baseURL);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/${endpoint.replace(/^\/+/, "")}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export function isTokenFourjBaseURL(baseURL: string): boolean {
  try {
    return new URL(baseURL).hostname.toLowerCase() === "token.fourj.space";
  } catch {
    return false;
  }
}

function isIpLiteral(hostname: string): boolean {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (hostname.includes(":")) return true;
  if (/^\[[0-9a-f:]+\]$/i.test(hostname)) return true;
  return false;
}

export async function verifyTurnstile(token: string | undefined, request: Request, env: Env): Promise<boolean> {
  const required = env.TURNSTILE_REQUIRED === "true";
  if (!env.TURNSTILE_SECRET_KEY) return !required;
  if (!token) return false;

  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET_KEY);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);

  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
  });
  if (!response.ok) return false;
  const result = (await response.json()) as { success?: boolean };
  return result.success === true;
}
