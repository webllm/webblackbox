export type SharePrivacyScannerSummary = {
  preEncryption: boolean;
  status: string;
};

export function hasPassedSharePrivacyPreflight(
  scanner: SharePrivacyScannerSummary | null | undefined
): boolean {
  return scanner?.preEncryption === true && scanner.status === "passed";
}
