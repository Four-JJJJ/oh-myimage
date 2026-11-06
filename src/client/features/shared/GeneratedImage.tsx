import { useEffect, useState } from "react";
import { generatedImageRetryUrl } from "../../api";

interface GeneratedImageProps {
  src: string;
  fallbackSrc?: string | null;
  alt: string;
  className?: string;
  loading?: "eager" | "lazy";
  decoding?: "async" | "auto" | "sync";
  draggable?: boolean;
}

export interface GeneratedImageRecoveryState {
  useFallback: boolean;
  bypassCache: boolean;
  failed: boolean;
}

export function nextGeneratedImageRecoveryState(
  state: GeneratedImageRecoveryState,
  hasFallback: boolean,
): GeneratedImageRecoveryState {
  if (state.useFallback) {
    if (!state.bypassCache) return { ...state, bypassCache: true };
    return { ...state, failed: true };
  }
  if (!state.bypassCache) return { ...state, bypassCache: true };
  if (hasFallback) return { ...state, useFallback: true, bypassCache: false };
  return { ...state, failed: true };
}

/**
 * Generated thumbnails can occasionally fail from a stale browser/SW cache.
 * Retry once with a fresh network URL, then fall back to the original image.
 */
export function GeneratedImage({
  src,
  fallbackSrc,
  alt,
  className,
  loading = "lazy",
  decoding = "async",
  draggable,
}: GeneratedImageProps) {
  const [recovery, setRecovery] = useState<GeneratedImageRecoveryState>({ useFallback: false, bypassCache: false, failed: false });
  const currentSrc = recovery.useFallback && fallbackSrc ? fallbackSrc : src;

  useEffect(() => {
    setRecovery({ useFallback: false, bypassCache: false, failed: false });
  }, [src, fallbackSrc]);

  return (
    <span className="relative block h-full w-full overflow-hidden">
      <img
        key={currentSrc}
        src={recovery.bypassCache ? generatedImageRetryUrl(currentSrc, "image-retry") : currentSrc}
        alt={recovery.failed ? "图片暂时无法加载" : alt}
        className={className}
        loading={loading}
        decoding={decoding}
        draggable={draggable}
        onError={() => {
          setRecovery((current) => nextGeneratedImageRecoveryState(current, Boolean(fallbackSrc && fallbackSrc !== src)));
        }}
        onLoad={() => setRecovery((current) => current.failed ? { ...current, failed: false } : current)}
      />
      {recovery.failed && (
        <span role="img" aria-label="图片暂时无法加载" className="absolute inset-0 grid place-items-center bg-black/50 px-2 text-center text-xs text-white/70">
          图片暂时无法加载
        </span>
      )}
    </span>
  );
}
