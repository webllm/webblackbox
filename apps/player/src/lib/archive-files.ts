export function hasFilePayload(event: DragEvent): boolean {
  const types = event.dataTransfer?.types;

  if (!types) {
    return false;
  }

  return Array.from(types).includes("Files");
}

export function pickArchiveFile(files: FileList | null): File | null {
  if (!files || files.length === 0) {
    return null;
  }

  const supported = Array.from(files).find((file) => {
    const lowerName = file.name.toLowerCase();
    return lowerName.endsWith(".webblackbox") || lowerName.endsWith(".zip");
  });

  return supported ?? null;
}
