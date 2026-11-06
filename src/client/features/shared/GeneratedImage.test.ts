import { describe, expect, it } from "vitest";
import { nextGeneratedImageRecoveryState, type GeneratedImageRecoveryState } from "./GeneratedImage";

const initialState: GeneratedImageRecoveryState = { useFallback: false, bypassCache: false, failed: false };

describe("generated image recovery", () => {
  it("retries the current image without cache before falling back to the original", () => {
    const cacheRetry = nextGeneratedImageRecoveryState(initialState, true);
    expect(cacheRetry).toEqual({ useFallback: false, bypassCache: true, failed: false });

    const originalFallback = nextGeneratedImageRecoveryState(cacheRetry, true);
    expect(originalFallback).toEqual({ useFallback: true, bypassCache: false, failed: false });
  });

  it("shows a visible failure after both current and original images fail", () => {
    const originalRetry = nextGeneratedImageRecoveryState({ useFallback: true, bypassCache: false, failed: false }, true);
    expect(originalRetry).toEqual({ useFallback: true, bypassCache: true, failed: false });

    const visibleFailure = nextGeneratedImageRecoveryState(originalRetry, true);
    expect(visibleFailure).toEqual({ useFallback: true, bypassCache: true, failed: true });
  });

  it("shows a visible failure after both cache-bypassed attempts fail when no original exists", () => {
    expect(nextGeneratedImageRecoveryState(initialState, false)).toEqual({ useFallback: false, bypassCache: true, failed: false });
    expect(nextGeneratedImageRecoveryState({ useFallback: false, bypassCache: true, failed: false }, false)).toEqual({ useFallback: false, bypassCache: true, failed: true });
  });
});
