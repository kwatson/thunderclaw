export interface CounterpartBaselineRecord {
  tag: string;
  name: string;
  sha256: string;
  size: number;
}

export interface CounterpartBaselines {
  format: "thunderclaw-counterpart-baselines-v1";
  "openclaw-plugin": CounterpartBaselineRecord;
  "thunderbird-extension": CounterpartBaselineRecord;
}

export function validateCounterpartBaselines(value: unknown): CounterpartBaselines;

export function verifyCounterpartBaseline(options: {
  forComponent: "openclaw-plugin" | "thunderbird-extension";
  artifact: string;
}): Promise<{
  forComponent: "openclaw-plugin" | "thunderbird-extension";
  counterpart: "openclaw-plugin" | "thunderbird-extension";
  tag: string;
  name: string;
  sha256: string;
  size: number;
}>;
