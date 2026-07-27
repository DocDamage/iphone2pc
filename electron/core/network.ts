import os from "node:os";

export interface LanAddressCandidate {
  address: string;
  interfaceName: string;
}

const VIRTUAL_INTERFACE =
  /(?:vethernet|hyper-?v|wsl|docker|vmware|virtualbox|tailscale|zerotier|loopback|vpn|tunnel|utun|hamachi)/i;
const WIFI_INTERFACE = /(?:wi-?fi|wireless|wlan)/i;
const PHYSICAL_INTERFACE = /(?:wi-?fi|wireless|wlan|ethernet|local area|en\d+|eth\d+)/i;

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) return false;
  return (
    octets[0] === 10 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
  );
}

function candidateScore(candidate: LanAddressCandidate): number {
  const [first, second] = candidate.address.split(".").map(Number);
  let score = isPrivateIpv4(candidate.address) ? 500 : 100;
  if (first === 192 && second === 168) score += 80;
  else if (first === 10) score += 60;
  else if (first === 172) score += 40;
  if (WIFI_INTERFACE.test(candidate.interfaceName)) score += 160;
  else if (PHYSICAL_INTERFACE.test(candidate.interfaceName)) score += 100;
  if (VIRTUAL_INTERFACE.test(candidate.interfaceName)) score -= 1_000;
  return score;
}

export function rankLanAddressCandidates(
  candidates: LanAddressCandidate[]
): LanAddressCandidate[] {
  const unique = new Map<string, LanAddressCandidate>();
  for (const candidate of candidates) {
    if (!unique.has(candidate.address)) unique.set(candidate.address, candidate);
  }
  const values = [...unique.values()];
  const hasNonVirtual = values.some(
    (candidate) => !VIRTUAL_INTERFACE.test(candidate.interfaceName)
  );
  return values
    .filter(
      (candidate) =>
        !hasNonVirtual || !VIRTUAL_INTERFACE.test(candidate.interfaceName)
    )
    .sort(
      (left, right) =>
        candidateScore(right) - candidateScore(left) ||
        left.interfaceName.localeCompare(right.interfaceName) ||
        left.address.localeCompare(right.address)
    );
}

export function getLanAddressCandidates(): LanAddressCandidate[] {
  const candidates: LanAddressCandidate[] = [];
  try {
    for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== "IPv4" || entry.internal) continue;
        if (entry.address.startsWith("169.254.")) continue;
        candidates.push({ address: entry.address, interfaceName });
      }
    }
  } catch {
    // Some locked-down environments block network adapter enumeration.
  }
  return rankLanAddressCandidates(candidates);
}

export function getLanAddresses(): string[] {
  return getLanAddressCandidates().map((candidate) => candidate.address);
}

export function makeConnectionUrl(address: string, port: number, pin?: string): string {
  const url = new URL(`http://${address}:${port}/`);
  if (pin) url.searchParams.set("code", pin);
  return url.toString();
}
