import { describe, expect, it } from "vitest";

import {
  buildLocalStorageSnapshotExpression,
  parseStorageSnapshotMeta
} from "./storage-snapshot.js";

describe("storage-snapshot", () => {
  it("does not include storage keys in lengths-only snapshots", () => {
    const expression = buildLocalStorageSnapshotExpression("lengths-only");

    expect(expression).toContain("lengths.push(value.length)");
    expect(expression).not.toContain("entries.push([key");
    expect(expression).not.toContain(
      "JSON.stringify({ count, truncated: count > maxItems, entries })"
    );
  });

  it("parses keyed and lengths-only snapshot metadata", () => {
    expect(
      parseStorageSnapshotMeta(
        JSON.stringify({
          count: 3,
          truncated: true,
          entries: [
            ["featureFlag", 4],
            ["theme", 5]
          ]
        })
      )
    ).toEqual({
      count: 3,
      sampledCount: 2,
      truncated: true
    });

    expect(
      parseStorageSnapshotMeta(
        JSON.stringify({
          count: 2,
          truncated: false,
          lengths: [12, 5]
        })
      )
    ).toEqual({
      count: 2,
      sampledCount: 2,
      truncated: false
    });
  });
});
