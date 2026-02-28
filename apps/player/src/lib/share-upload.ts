export function uploadArchiveWithProgress(
  url: string,
  headers: Record<string, string>,
  body: ArrayBuffer,
  onProgress: (loadedBytes: number, totalBytes: number | null) => void
): Promise<Record<string, unknown>> {
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
      reject(new Error("Network error while uploading archive."));
    });

    xhr.addEventListener("abort", () => {
      reject(new Error("Upload aborted."));
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

        reject(new Error("Share server response is not a JSON object."));
      } catch {
        reject(new Error("Share server returned invalid JSON."));
      }
    });

    xhr.send(body);
  });
}
