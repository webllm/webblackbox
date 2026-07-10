/** Raised when another archive-heavy MCP operation already owns the process budget. */
export class ArchiveOperationCapacityError extends Error {
  public override readonly name = "ArchiveOperationCapacityError";

  public constructor(public readonly maxConcurrentOperations: number) {
    super(
      `Archive operation capacity is exhausted (maximum ${maxConcurrentOperations} concurrent operation${maxConcurrentOperations === 1 ? "" : "s"}).`
    );
  }
}

/** Bounds concurrent operations for the full lifetime of their parsed Player instances. */
export class ArchiveOperationAdmission {
  private activeOperations = 0;

  public constructor(private readonly maxConcurrentOperations = 1) {
    if (!Number.isSafeInteger(maxConcurrentOperations) || maxConcurrentOperations <= 0) {
      throw new TypeError("Archive operation concurrency must be a positive safe integer.");
    }
  }

  public async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.activeOperations >= this.maxConcurrentOperations) {
      throw new ArchiveOperationCapacityError(this.maxConcurrentOperations);
    }

    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
    }
  }
}
