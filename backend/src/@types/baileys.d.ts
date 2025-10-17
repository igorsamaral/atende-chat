declare module "@whiskeysockets/baileys" {
  // minimal declarations to satisfy TypeScript for items used in this codebase
  // these are intentionally permissive (any) to avoid fighting upstream typings

  export type CacheStore = any;

  export function makeInMemoryStore(opts?: any): any;

  // existing exports used by the project (partial/loose types)
  export const WAMessageStubType: any;
}
