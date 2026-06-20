const previewStorageKey = "oh-myimage.preview";
const previewAllowedHosts = new Set(["localhost", "127.0.0.1", "dev-gen.fourj.space"]);

export interface PreviewApiDecision {
  load: boolean;
  clearStoredMode: boolean;
}

export function resolvePreviewApiDecision(search: string, storedMode: string | null, hostname: string): PreviewApiDecision {
  if (!previewAllowedHosts.has(hostname)) return { load: false, clearStoredMode: false };

  const params = new URLSearchParams(search);
  const previewMode = params.get("preview");
  if (previewMode === "off") return { load: false, clearStoredMode: true };
  if (previewMode !== null) return { load: true, clearStoredMode: false };
  return { load: Boolean(storedMode), clearStoredMode: false };
}

export async function installOptionalPreviewApi(): Promise<void> {
  if (typeof window === "undefined") return;

  const decision = resolvePreviewApiDecision(
    window.location.search,
    window.localStorage.getItem(previewStorageKey),
    window.location.hostname,
  );
  if (decision.clearStoredMode) window.localStorage.removeItem(previewStorageKey);
  if (!decision.load) return;

  const { installPreviewApi } = await import("./preview-api");
  installPreviewApi();
}
