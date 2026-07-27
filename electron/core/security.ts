import crypto from "node:crypto";

export interface SessionInfo {
  token: string;
  deviceName: string;
  ip: string;
  deviceId: string;
  createdAt: number;
  expiresAt: number;
}

interface AttemptWindow {
  count: number;
  resetsAt: number;
}

export class PairingManager {
  private pin = PairingManager.createPin();
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly attempts = new Map<string, AttemptWindow>();
  private readonly sessionLifetimeMs = 12 * 60 * 60 * 1000;

  static createPin(): string {
    return crypto.randomInt(100_000, 1_000_000).toString();
  }

  getPin(): string {
    return this.pin;
  }

  rotatePin(): string {
    const previousPin = this.pin;
    do {
      this.pin = PairingManager.createPin();
    } while (this.pin === previousPin);
    return this.pin;
  }

  pair(
    suppliedPin: string,
    deviceName: string,
    ip: string,
    deviceId: string = crypto.randomUUID()
  ): { token: string; expiresAt: string } | null {
    if (this.isRateLimited(ip)) return null;
    const expected = Buffer.from(this.pin);
    const actual = Buffer.from(String(suppliedPin));
    const valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
    if (!valid) {
      this.recordFailure(ip);
      return null;
    }

    this.attempts.delete(ip);
    return this.createSession(deviceName, ip, deviceId);
  }

  createSession(
    deviceName: string,
    ip: string,
    deviceId: string
  ): { token: string; expiresAt: string } {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    const session: SessionInfo = {
      token,
      deviceName: String(deviceName || "iPhone").slice(0, 80),
      ip,
      deviceId,
      createdAt: now,
      expiresAt: now + this.sessionLifetimeMs
    };
    this.sessions.set(token, session);
    return { token, expiresAt: new Date(session.expiresAt).toISOString() };
  }

  validate(token?: string): SessionInfo | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  revokeDevice(deviceId: string): void {
    for (const [token, session] of this.sessions) {
      if (session.deviceId === deviceId) this.sessions.delete(token);
    }
  }

  connectedDeviceCount(): number {
    this.prune();
    return new Set([...this.sessions.values()].map((session) => session.deviceName)).size;
  }

  private isRateLimited(ip: string): boolean {
    const window = this.attempts.get(ip);
    if (!window) return false;
    if (window.resetsAt < Date.now()) {
      this.attempts.delete(ip);
      return false;
    }
    return window.count >= 8;
  }

  private recordFailure(ip: string): void {
    const current = this.attempts.get(ip);
    if (!current || current.resetsAt < Date.now()) {
      this.attempts.set(ip, { count: 1, resetsAt: Date.now() + 10 * 60 * 1000 });
      return;
    }
    current.count += 1;
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt < now) this.sessions.delete(token);
    }
  }
}
