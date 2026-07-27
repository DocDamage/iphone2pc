export type IphoneBrowserPlatform =
  | "chrome"
  | "safari"
  | "edge"
  | "firefox"
  | "browser";

export interface IphoneBrowserIdentity {
  name: string;
  platform: IphoneBrowserPlatform;
}

export function detectIphoneBrowser(userAgent: string): IphoneBrowserIdentity {
  if (/CriOS/i.test(userAgent)) return { name: "Chrome", platform: "chrome" };
  if (/EdgiOS/i.test(userAgent)) return { name: "Edge", platform: "edge" };
  if (/FxiOS/i.test(userAgent)) return { name: "Firefox", platform: "firefox" };
  if (/OPiOS/i.test(userAgent)) return { name: "Opera", platform: "browser" };
  if (/DuckDuckGo/i.test(userAgent)) return { name: "DuckDuckGo", platform: "browser" };
  if (/Safari/i.test(userAgent)) return { name: "Safari", platform: "safari" };
  return { name: "browser", platform: "browser" };
}
