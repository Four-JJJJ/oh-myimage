import { createReadStream, type Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { createServer, Server } from "node:http";
import { Readable } from "node:stream";
import { extname, join, normalize, resolve, sep } from "node:path";
import { serve } from "@hono/node-server";
import { app } from "../worker/index";
import { createNodeRuntime } from "./env";
import {
  appendVary,
  COMPRESSIBLE_STATIC_EXTENSIONS,
  maybeCompressResponse,
  preferredStaticEncodings,
  StaticCompressionCache,
} from "./compression";

const runtime = createNodeRuntime();
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8788);
const distDir = resolve(process.env.STATIC_DIR ?? join(process.cwd(), "dist"));
const requestTimeoutMs = Number(process.env.NODE_REQUEST_TIMEOUT_MS ?? 700_000);
const compressionEnabled = process.env.NODE_COMPRESSION !== "0";
const staticCompression = new StaticCompressionCache();

const server = serve(
  {
    hostname: host,
    port,
    createServer,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const response = await app.fetch(request, runtime.env);
        return compressionEnabled ? maybeCompressResponse(request, response) : response;
      }
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

if (compressionEnabled) void warmStaticCompression(join(distDir, "assets"));

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
    "Content-Type": contentType(target.path),
    "Cache-Control": staticCacheControl(root, target.path),
  });

  if (compressionEnabled && COMPRESSIBLE_STATIC_EXTENSIONS.has(extname(target.path))) {
    appendVary(headers, "Accept-Encoding");
    const compressed = await staticCompression.get(
      { path: target.path, size: target.stats.size, mtimeMs: target.stats.mtimeMs },
      preferredStaticEncodings(request.headers.get("Accept-Encoding")),
    );
    if (compressed) {
      headers.set("Content-Encoding", compressed.encoding);
      headers.set("Content-Length", String(compressed.body.byteLength));
      if (request.method === "HEAD") return new Response(null, { headers });
      const { buffer, byteOffset, byteLength } = compressed.body;
      return new Response(new Uint8Array(buffer as ArrayBuffer, byteOffset, byteLength), { headers });
    }
  }

  headers.set("Content-Length", String(target.stats.size));
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(Readable.toWeb(createReadStream(target.path)) as ReadableStream, { headers });
}

/** Only content-hashed build output is safe to cache forever. */
function staticCacheControl(root: string, path: string): string {
  const assetsDir = `${join(root, "assets")}${sep}`;
  return path.startsWith(assetsDir) ? "public, max-age=31536000, immutable" : "no-cache";
}

async function resolveStaticTarget(root: string, pathname: string): Promise<{ path: string; stats: Stats } | null> {
  const directPath = resolve(root, `.${pathname}`);
  if (isInside(root, directPath)) {
    const stats = await fileStats(directPath);
    if (stats) return { path: directPath, stats };
  }

  const indexPath = resolve(root, "index.html");
  const indexStats = await fileStats(indexPath);
  if (indexStats) return { path: indexPath, stats: indexStats };
  return null;
}

async function warmStaticCompression(assetsDir: string): Promise<void> {
  try {
    const names = await readdir(assetsDir);
    for (const name of names) {
      if (!COMPRESSIBLE_STATIC_EXTENSIONS.has(extname(name))) continue;
      const path = join(assetsDir, name);
      const stats = await fileStats(path);
      if (stats) await staticCompression.get({ path, size: stats.size, mtimeMs: stats.mtimeMs }, ["br"]);
    }
  } catch {
    // Warm-up is best effort; assets are compressed lazily on first request otherwise.
  }
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

async function fileStats(path: string): Promise<Stats | null> {
  try {
    const stats = await stat(path);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
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
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".woff2":
      return "font/woff2";
    case ".woff":
      return "font/woff";
    case ".gif":
      return "image/gif";
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
