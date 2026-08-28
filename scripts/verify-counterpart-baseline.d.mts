export function verifyCounterpartBaseline(options: {
  forComponent: "openclaw-plugin" | "thunderbird-extension";
  artifact: string;
}): Promise<{
  forComponent: "openclaw-plugin" | "thunderbird-extension";
  counterpart: "openclaw-plugin" | "thunderbird-extension";
  publishedRelease: string;
  name: string;
  sha256: string;
  size: number;
}>;
