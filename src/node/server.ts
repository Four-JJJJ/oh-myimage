import { readFile, stat } from "node:fs/promises";
import { createServer, Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { serve } from "@hono/node-server";
import { app } from "../worker/index";
import { createNodeRuntime } from "./env";

const runtime = createNodeRuntime();
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8788);
const distDir = resolve(process.env.STATIC_DIR ?? join(process.cwd(), "dist"));
const requestTimeoutMs = Number(process.env.NODE_REQUEST_TIMEOUT_MS ?? 700_000);

const server = serve(
  {
    hostname: host,
    port,
    createServer,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) return app.fetch(request, runtime.env);
      return serveStaticAsset(request, distDir);
    },
  },
  (info) => {
    console.log(`oh-myimage api listening on http://${info.address}:${info.port}`);
  },
) as Server;

server.requestTimeout = requestTimeoutMs;
server.headersTimeout = requestTimeoutMs + 5_000;
server.keepAliveTimeout = 75_000;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

async function shutdown(signal: string): Promise<void> {
  console.log(`received ${signal}, shutting down`);
  server.close();
  await runtime.close();
  process.exit(0);
}

async function serveStaticAsset(request: Request, root: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const pathname = safePathname(url.pathname);
  const target = await resolveStaticTarget(root, pathname);
  if (!target) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "Content-Type": contentType(target),
    "Cache-Control": target.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
  });
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(await readFile(target), { headers });
}

async function resolveStaticTarget(root: string, pathname: string): Promise<string | null> {
  const directPath = resolve(root, `.${pathname}`);
  if (isInside(root, directPath) && (await isFile(directPath))) return directPath;

  const indexPath = resolve(root, "index.html");
  if (await isFile(indexPath)) return indexPath;
  return null;
}

function safePathname(pathname: string): string {
  try {
    return normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "/");
  } catch {
    return "/";
  }
}

function isInside(root: string, target: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return target === root || target.startsWith(normalizedRoot);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function contentType(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}
