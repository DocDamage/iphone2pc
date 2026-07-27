interface RendererLocation {
  protocol: string;
  host: string;
  pathname: string;
}

function parseRendererLocation(value: string): RendererLocation | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:" && url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    if (url.username || url.password) return null;
    return {
      protocol: url.protocol,
      host: url.host,
      pathname: url.pathname
    };
  } catch {
    return null;
  }
}

/**
 * Matches a renderer URL to the one application entry point, ignoring only
 * query parameters and fragments that cannot change the loaded document.
 */
export function isTrustedRendererUrl(candidateUrl: string, trustedEntryUrl: string): boolean {
  const candidate = parseRendererLocation(candidateUrl);
  const trusted = parseRendererLocation(trustedEntryUrl);
  return Boolean(
    candidate &&
      trusted &&
      candidate.protocol === trusted.protocol &&
      candidate.host === trusted.host &&
      candidate.pathname === trusted.pathname
  );
}
