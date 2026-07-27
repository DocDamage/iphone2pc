const REQUEST_ID = /^[a-zA-Z0-9_-]{8,100}$/;

export class RemoteReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly maximumEntries = 4_096
  ) {}

  accept(id: string, now = Date.now()): boolean {
    if (!REQUEST_ID.test(id)) return false;
    this.prune(now);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now);
    while (this.seen.size > this.maximumEntries) {
      const oldest = this.seen.keys().next().value as string | undefined;
      if (!oldest) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  private prune(now: number): void {
    for (const [id, observedAt] of this.seen) {
      if (now - observedAt <= this.ttlMs) break;
      this.seen.delete(id);
    }
  }
}
