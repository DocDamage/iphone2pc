import { describe, expect, it } from "vitest";
import { makeConnectionUrl, rankLanAddressCandidates } from "./network.js";

describe("network selection", () => {
  it("prefers a physical LAN adapter over WSL, Docker, and VPN adapters", () => {
    const ranked = rankLanAddressCandidates([
      { interfaceName: "vEthernet (WSL)", address: "172.24.16.1" },
      { interfaceName: "Tailscale", address: "100.85.10.3" },
      { interfaceName: "Wi-Fi", address: "192.168.1.42" },
      { interfaceName: "DockerNAT", address: "10.0.75.1" }
    ]);

    expect(ranked).toEqual([
      { interfaceName: "Wi-Fi", address: "192.168.1.42" }
    ]);
  });

  it("retains a virtual adapter when it is the only usable address", () => {
    expect(
      rankLanAddressCandidates([
        { interfaceName: "vEthernet (Default Switch)", address: "172.20.0.1" }
      ])
    ).toHaveLength(1);
  });

  it("prefers Wi-Fi when both wired and wireless LAN addresses are active", () => {
    const ranked = rankLanAddressCandidates([
      { interfaceName: "Ethernet", address: "192.168.1.20" },
      { interfaceName: "Wi-Fi", address: "192.168.1.21" }
    ]);
    expect(ranked[0].interfaceName).toBe("Wi-Fi");
  });

  it("keeps the pairing code intact in a connection URL", () => {
    expect(makeConnectionUrl("192.168.50.7", 48844, "123456")).toBe(
      "http://192.168.50.7:48844/?code=123456"
    );
  });
});
