import type { PocketDockApi } from "../electron/core/types";

declare global {
  interface Window {
    pocketdock: PocketDockApi;
  }
}

export {};
