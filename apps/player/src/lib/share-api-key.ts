import { resolveShareServerOrigin } from "./share.js";

export function getShareServerApiKeyForBaseUrl(
  apiKeysByOrigin: Record<string, string>,
  baseUrl: string | null
): string {
  const origin = resolveShareServerOrigin(baseUrl);

  if (!origin) {
    return "";
  }

  return apiKeysByOrigin[origin] ?? "";
}

export function setShareServerApiKeyForBaseUrl(
  apiKeysByOrigin: Record<string, string>,
  baseUrl: string,
  apiKey: string
): void {
  const origin = resolveShareServerOrigin(baseUrl);

  if (!origin) {
    return;
  }

  const trimmed = apiKey.trim();

  if (trimmed.length > 0) {
    apiKeysByOrigin[origin] = trimmed;
  } else {
    delete apiKeysByOrigin[origin];
  }
}

export function bindShareApiKeyInputToTargetOrigin(
  sourceInput: HTMLInputElement,
  apiKeyInput: HTMLInputElement,
  resolveBaseUrl: (value: string) => string | null,
  resolveApiKeyForBaseUrl: (baseUrl: string | null) => string
): () => void {
  let apiKeyEdited = false;
  let resolvedBaseUrl = resolveBaseUrl(sourceInput.value);
  let targetOrigin = resolveShareServerOrigin(resolvedBaseUrl);
  apiKeyInput.value = resolveApiKeyForBaseUrl(resolvedBaseUrl);

  const onApiKeyInput = (): void => {
    apiKeyEdited = true;
  };

  const onSourceInput = (): void => {
    const nextBaseUrl = resolveBaseUrl(sourceInput.value);
    const nextOrigin = resolveShareServerOrigin(nextBaseUrl);

    if (nextOrigin === targetOrigin) {
      return;
    }

    resolvedBaseUrl = nextBaseUrl;
    targetOrigin = nextOrigin;

    if (!apiKeyEdited) {
      apiKeyInput.value = resolveApiKeyForBaseUrl(resolvedBaseUrl);
    }
  };

  apiKeyInput.addEventListener("input", onApiKeyInput);
  sourceInput.addEventListener("input", onSourceInput);

  return () => {
    apiKeyInput.removeEventListener("input", onApiKeyInput);
    sourceInput.removeEventListener("input", onSourceInput);
  };
}
