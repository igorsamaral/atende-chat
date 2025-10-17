declare module "@whiskeysockets/baileys" {
  // permissive typings to satisfy this project's usage without pulling upstream types

  export type CacheStore = any;

  export type WASocket = any;
  export type WAMessage = any;
  export type WAMessageUpdate = any;

  export const WAMessageStubType: any;
  export const Browsers: any;
  export const DisconnectReason: any;
  export type MessageUpsertType = any;
  export const MessageUpsertType: any;

  export namespace proto {
    export type IWebMessageInfo = any;
    export type WebMessageInfo = any;
    export type IMessage = any;
    export type IQuoted = any;
    // add other proto types used in the codebase as needed
  }

  // auth-related
  export type AuthenticationCreds = any;
  export type AuthenticationState = any;
  export type SignalDataTypeMap = any;
  export const BufferJSON: any;
  export function initAuthCreds(...args: any[]): any;

  // core functions
  export function makeWASocket(opts?: any): WASocket;
  export function makeWALegacySocket(opts?: any): any;
  export function makeInMemoryStore(opts?: any): any;
  export function fetchLatestBaileysVersion(): Promise<{ version: number[]; isLatest: boolean }>;
  export function makeCacheableSignalKeyStore(keys: any, logger?: any): any;
  export function isJidBroadcast(jid: string): boolean;

  // helpers
  export function downloadMediaMessage(...args: any[]): any;
  export function extractMessageContent(...args: any[]): any;
  export function getContentType(...args: any[]): any;
  export function jidNormalizedUser(...args: any[]): any;
  export function delay(ms: number): Promise<void>;

  // Common types referenced in code
  export type Chat = any;
  export type Contact = any;
  export type AnyMessageContent = any;
  export type BinaryNode = any;

  const _default: any;
  export default _default;
}
