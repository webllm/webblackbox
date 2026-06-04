export type CaptureScopeOriginChangeInput = {
  scopeOrigin: string | null;
  nextOrigin: string | null;
  stopOnOriginChange: boolean;
  activeTabScopedBuild: boolean;
};

export type CaptureScopeEnterpriseOriginPolicyInput = {
  nextOrigin: string | null;
  isEnterpriseOriginAllowed: (origin: string) => boolean;
};

export function shouldStopForCaptureScopeOriginChange(
  input: CaptureScopeOriginChangeInput
): boolean {
  if (!input.stopOnOriginChange) {
    return false;
  }

  if (!input.scopeOrigin) {
    return false;
  }

  return input.nextOrigin !== input.scopeOrigin;
}

export function shouldStopForEnterpriseOriginPolicy(
  input: CaptureScopeEnterpriseOriginPolicyInput
): boolean {
  if (!input.nextOrigin) {
    return false;
  }

  return !input.isEnterpriseOriginAllowed(input.nextOrigin);
}
