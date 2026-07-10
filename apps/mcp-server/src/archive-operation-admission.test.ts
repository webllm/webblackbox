import { describe, expect, it } from "vitest";

import {
  ArchiveOperationAdmission,
  ArchiveOperationCapacityError
} from "./archive-operation-admission.js";

describe("archive operation admission", () => {
  it("rejects excess work and releases capacity after success", async () => {
    const admission = new ArchiveOperationAdmission(1);
    let releaseFirst: (() => void) | undefined;
    const first = admission.run(
      () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve("first");
        })
    );

    await expect(admission.run(async () => "second")).rejects.toBeInstanceOf(
      ArchiveOperationCapacityError
    );
    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(admission.run(async () => "third")).resolves.toBe("third");
  });

  it("releases capacity when an admitted operation fails", async () => {
    const admission = new ArchiveOperationAdmission(1);

    await expect(
      admission.run(async () => {
        throw new Error("operation failed");
      })
    ).rejects.toThrow("operation failed");
    await expect(admission.run(async () => "recovered")).resolves.toBe("recovered");
  });
});
