import { HTTPException } from "hono/http-exception";

export function jsonError(status: number, code: string, message: string): HTTPException {
  return new HTTPException(status as never, {
    message,
    res: Response.json({ ok: false, error: { code, message } }, { status }),
  });
}

export function envNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function publicErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactSecrets(error.message);
  return "请求失败，请稍后重试。";
}

export function redactSecrets(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/sk-[A-Za-z0-9._-]+/gi, "sk-[redacted]")
    .replace(/Authorization["']?\s*:\s*["'][^"']+["']/gi, "Authorization: [redacted]");
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function todayStartIso(): string {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

export function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
