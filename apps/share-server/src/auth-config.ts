export type ShareApiScope = "upload" | "read" | "list" | "revoke" | "admin";

export type ShareApiCredential = {
  secret: string;
  scopes: Set<ShareApiScope>;
};

export function parseShareApiCredentials(
  rawValue: string | undefined,
  legacyAdminKey: string | null
): ShareApiCredential[] {
  const credentials: ShareApiCredential[] = [];
  const configuredSecrets = new Set<string>();

  if (legacyAdminKey) {
    addCredential(credentials, configuredSecrets, legacyAdminKey, new Set(["admin"]));
  }

  if (typeof rawValue !== "string" || rawValue.trim().length === 0) {
    return credentials;
  }

  const initialCredentialCount = credentials.length;

  for (const entry of rawValue.split(";")) {
    const trimmed = entry.trim();

    if (!trimmed) {
      continue;
    }

    const separatorIndex = trimmed.indexOf(":");
    const secret = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex).trim() : trimmed;

    if (!secret) {
      throw new Error("Share API credential secret cannot be empty.");
    }

    if (separatorIndex < 0) {
      addCredential(credentials, configuredSecrets, secret, new Set(["admin"]));
      continue;
    }

    const rawScopes = trimmed.slice(separatorIndex + 1).trim();

    if (!rawScopes) {
      throw new Error(`Share API credential '${secret}' must declare at least one scope.`);
    }

    const scopes = new Set<ShareApiScope>();

    for (const rawScope of rawScopes.split(",")) {
      const scope = rawScope.trim();
      const normalized = normalizeShareApiScope(scope);

      if (!normalized) {
        throw new Error(
          `Share API credential '${secret}' has unknown scope '${scope || "(empty)"}'.`
        );
      }

      scopes.add(normalized);
    }

    addCredential(credentials, configuredSecrets, secret, scopes);
  }

  if (credentials.length === initialCredentialCount) {
    throw new Error("WEBBLACKBOX_SHARE_API_KEYS must contain at least one credential.");
  }

  return credentials;
}

function addCredential(
  credentials: ShareApiCredential[],
  configuredSecrets: Set<string>,
  secret: string,
  scopes: Set<ShareApiScope>
): void {
  if (configuredSecrets.has(secret)) {
    throw new Error("Share API credential secrets must be unique.");
  }

  configuredSecrets.add(secret);
  credentials.push({ secret, scopes });
}

function normalizeShareApiScope(value: string): ShareApiScope | null {
  const normalized = value.toLowerCase();

  if (
    normalized === "upload" ||
    normalized === "read" ||
    normalized === "list" ||
    normalized === "revoke" ||
    normalized === "admin"
  ) {
    return normalized;
  }

  return null;
}
