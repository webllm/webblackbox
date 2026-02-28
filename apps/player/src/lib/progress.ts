export type ProgressMarkerKind = "error" | "network" | "screenshot" | "action";
export type ProgressPanelKey =
  | "timeline"
  | "details"
  | "actions"
  | "network"
  | "compare"
  | "console"
  | "realtime"
  | "storage"
  | "perf";

export function markerKindToPanel(kind: ProgressMarkerKind | undefined): ProgressPanelKey | null {
  if (!kind) {
    return null;
  }

  if (kind === "error") {
    return "console";
  }

  if (kind === "network") {
    return "network";
  }

  if (kind === "screenshot") {
    return "details";
  }

  if (kind === "action") {
    return "actions";
  }

  return null;
}
