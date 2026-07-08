import { useSyncExternalStore } from "react";
import { getState, subscribe } from "./client.ts";

export function useLocalSlack() {
  return useSyncExternalStore(subscribe, getState);
}
