import { createPlayerI18n, type PlayerLocale } from "./i18n.js";

export function uploadArchiveWithProgress(
  url: string,
  headers: Record<string, string>,
  body: ArrayBuffer,
  onProgress: (loadedBytes: number, totalBytes: number | null) => void,
  locale: PlayerLocale = "en"
): Promise<Record<string, unknown>> {
  const i18n = createPlayerI18n(locale);

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);

    for (const [name, value] of Object.entries(headers)) {
      xhr.setRequestHeader(name, value);
    }

    xhr.upload.addEventListener("progress", (event) => {
      const totalBytes = event.lengthComputable ? event.total : body.byteLength;
      onProgress(event.loaded, totalBytes);
    });

    xhr.addEventListener("error", () => {
      reject(new Error(i18n.messages.uploadNetworkError));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error(i18n.messages.uploadAborted));
    });

    xhr.addEventListener("load", () => {
      const responseText = xhr.responseText ?? "";

      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(responseText || `HTTP ${xhr.status}`));
        return;
      }

      if (responseText.trim().length === 0) {
        resolve({});
        return;
      }

      try {
        const parsed = JSON.parse(responseText) as unknown;

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
          return;
        }

        reject(new Error(i18n.messages.uploadResponseNotJsonObject));
      } catch {
        reject(new Error(i18n.messages.uploadInvalidJson));
      }
    });

    xhr.send(body);
  });
}
