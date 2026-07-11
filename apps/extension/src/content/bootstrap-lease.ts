const CONTENT_BOOTSTRAP_SLOT = Symbol.for("webblackbox.content.bootstrap.v1");

type ContentBootstrapRecord = {
  state: "active" | "disposed" | "suspended";
};

export type ContentBootstrapLease = {
  dispose(): boolean;
  isActive(): boolean;
  resume(): boolean;
  suspend(): boolean;
};

/**
 * Claims the content-script runtime for one isolated-world global.
 *
 * Chrome can execute the same content bundle more than once in a document. The
 * non-configurable marker intentionally survives runtime cleanup so a stale or
 * delayed duplicate execution cannot start a second runtime in that document.
 * A navigation receives a fresh isolated-world global and therefore a fresh
 * lease.
 */
export function acquireContentBootstrapLease(scope: object): ContentBootstrapLease | null {
  if (Reflect.has(scope, CONTENT_BOOTSTRAP_SLOT)) {
    return null;
  }

  const record: ContentBootstrapRecord = { state: "active" };

  try {
    Object.defineProperty(scope, CONTENT_BOOTSTRAP_SLOT, {
      configurable: false,
      enumerable: false,
      value: record,
      writable: false
    });
  } catch {
    return null;
  }

  return Object.freeze({
    dispose(): boolean {
      if (record.state === "disposed") {
        return false;
      }

      record.state = "disposed";
      return true;
    },
    isActive(): boolean {
      return record.state === "active";
    },
    resume(): boolean {
      if (record.state !== "suspended") {
        return false;
      }

      record.state = "active";
      return true;
    },
    suspend(): boolean {
      if (record.state !== "active") {
        return false;
      }

      record.state = "suspended";
      return true;
    }
  });
}
