import type { CaptureMode, RecorderConfig } from "@webblackbox/protocol";

export type ModeProductProfile = {
  label: string;
  summary: string;
  signals: string;
  heavyCapture: string;
};

export const MODE_PRODUCT_PROFILES: Record<CaptureMode, ModeProductProfile> = {
  lite: {
    label: "Lite",
    summary: "Page-side lightweight signals with browser-side network metadata.",
    signals:
      "click / input / scroll / pointer samples / mutation summary / browser-side network baseline",
    heavyCapture:
      "runtime screenshots disabled, runtime DOM snapshots stay summary-only, page-side response-body capture disabled"
  },
  full: {
    label: "Full",
    summary: "Browser-assisted capture with CDP screenshots, navigation, and richer diagnostics.",
    signals: "CDP network / navigation / runtime errors plus page-side interaction hints",
    heavyCapture:
      "screenshots stay browser-side, page-side fetch/xhr hooks remain disabled, body capture stays capped"
  }
};

export function applyModeProductBoundary(
  mode: CaptureMode,
  config: RecorderConfig
): RecorderConfig {
  const next: RecorderConfig = {
    ...config,
    mode,
    freezeOnNetworkFailure: false,
    freezeOnLongTaskSpike: false,
    sampling: {
      ...config.sampling
    }
  };

  if (mode === "lite") {
    next.sampling.screenshotIdleMs = 0;
    next.sampling.bodyCaptureMaxBytes = 0;
  }

  return next;
}
