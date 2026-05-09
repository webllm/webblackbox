export type CaptureScopeOriginChangeInput = {
  scopeOrigin: string | null;
  nextOrigin: string | null;
  stopOnOriginChange: boolean;
  activeTabScopedBuild: boolean;
};

export function shouldStopForCaptureScopeOriginChange(
  input: CaptureScopeOriginChangeInput
): boolean {
  if (!input.stopOnOriginChange && !input.activeTabScopedBuild) {
    return false;
  }

  if (!input.scopeOrigin) {
    return false;
  }

  return input.nextOrigin !== input.scopeOrigin;
}
