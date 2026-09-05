export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Payouts = Record<Severity, number>;

export interface Impact {
  id: string;
  severity: Severity;
  label: string;
  machineCheckable: boolean;
  invariant: string | null;
}
export interface SeverityInfo {
  severities: Severity[];
  impacts: Impact[];
  machineCheckable: string[];
  presets: { onchain: Payouts; web2: Payouts };
}
export interface CreatedBounty {
  slug: string;
  rulesHash: string;
  rewardPoolUsd: number;
  onchain: { rulesHash: string; ruler: string; tiers: string[]; slaSeconds: number };
}
export interface RulesView {
  verified: boolean;
  rulesHash: string;
  pool: { committedUsd: number; fundedUsd: number; solvent: boolean };
}

export interface Program {
  slug: string;
  name: string;
  scope: string;
  bondUsd: number;
  pocBondUsd: number;
  rewardRange: string | null;
  chain: string | null;
  submitUrl: string;
  committed: boolean;
  target: string | null;
  rulesHash: string | null;
  createdBy: string | null;
  acceptedImpacts: string[];
  payouts: Payouts | null;
  slaSeconds: number | null;
  pool: { committedUsd: number; fundedUsd: number; solvent: boolean } | null;
}
export interface ProgramsResp { programs: Program[]; defaultNetwork: string; }

export interface RulesDetail {
  slug: string;
  rules: {
    name: string; target: string; scopeIn: string[]; scopeOut: string[];
    payouts: Payouts; bondUsd: number; acceptedImpacts: string[]; slaSeconds: number; ruler: string;
  };
  rulesHash: string;
  verified: boolean;
  storage?: {
    swarm: { reference: string; uri: string; url: string; gateway: string } | null;
    ens: { name: string; contenthash: string | null; dweb: string };
  };
  pool: { committedUsd: number; fundedUsd: number; solvent: boolean };
  impacts: { id: string; severity: Severity; label: string; machineCheckable: boolean; unknown?: boolean }[];
}

export interface SubmissionRow {
  id: string; title: string; severity: Severity; status: string;
  hunter: string; bondUsd: number; payoutUsd: number | null;
  createdAt: string; triagedAt: string | null; hasPoc: boolean;
  summary?: string; asset?: string | null; contentHash?: string;
  poc?: { impact?: string; requests?: { method?: string; path: string; headers?: Record<string,string>; body?: string }[] } | string;
  risk: { decision: "allow" | "risk" | "deny"; tier: string; valid: number; slop: number; agentId: string | null };
  trace: { level: string; text: string; tx?: string; url?: string }[];
}
export interface ProgramReports { slug: string; total: number; counts: Record<string, number>; reports: SubmissionRow[]; }
