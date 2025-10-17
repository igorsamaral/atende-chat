// src/libs/authState.ts
import type { AuthenticationCreds, AuthenticationState } from "@whiskeysockets/baileys"
import { initAuthCreds, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys"
import Whatsapp from "../models/Whatsapp"

// ---- utils: Buffer everywhere ----
const toBuffer = (v: any): any => {
  if (Buffer.isBuffer(v)) return v
  if (v instanceof Uint8Array) return Buffer.from(v)
  if (v && typeof v === "object" && v.type === "Buffer" && typeof v.data === "string") {
    return Buffer.from(v.data, "base64")
  }
  if (v && typeof v === "object" && Object.keys(v).every(k => /^\d+$/.test(k))) {
    const arr = Object.keys(v).sort((a, b) => +a - +b).map(k => v[k])
    return Buffer.from(Uint8Array.from(arr))
  }
  return v
}

const toBufferDeep = (v: any): any => {
  if (v == null) return v
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return toBuffer(v)
  if (Array.isArray(v)) return v.map(toBufferDeep)
  if (typeof v === "object") {
    const out: any = {}
    for (const k of Object.keys(v)) out[k] = toBufferDeep(v[k])
    return out
  }
  return v
}

// JSON helpers: salva buffers como base64; lê de volta como Buffer
const BufferJSON = {
  replacer: (_k: string, value: any) => {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return { type: "Buffer", data: Buffer.from(value).toString("base64") }
    }
    return value
  },
  reviver: (_k: string, value: any) => {
    if (value && value.type === "Buffer" && typeof value.data === "string") {
      return Buffer.from(value.data, "base64")
    }
    return value
  }
}

const KEY_MAP: Record<string, string> = {
  "pre-key": "preKeys",
  session: "sessions",
  "sender-key": "senderKeys",
  "app-state-sync-key": "appStateSyncKeys",      // mantemos cru
  "app-state-sync-version": "appStateVersions",  // mantemos cru
  "sender-key-memory": "senderKeyMemory"
}

export default async function authState(
  whatsapp: Whatsapp
): Promise<{ state: AuthenticationState; saveState: () => Promise<void> }> {
  let creds: AuthenticationCreds
  let keys: any = {}

  const saveState = async () => {
    try {
      await whatsapp.update({
        session: JSON.stringify({ creds, keys }, BufferJSON.replacer, 0)
      })
    } catch (err) {
      console.error("authState.saveState error:", err)
    }
  }

  if (whatsapp.session) {
    const parsed = JSON.parse(whatsapp.session, BufferJSON.reviver)
    creds = toBufferDeep(parsed.creds)
    keys = parsed.keys || {}
  } else {
    creds = initAuthCreds()
    keys = {}
  }

  const rawKeyStore = {
    get: (type: string, ids: string[]) => {
      const bag = KEY_MAP[type]
      return ids.reduce((dict: any, id: string) => {
        let v = keys[bag]?.[id]
        if (v !== undefined) {
          dict[id] =
            type === "app-state-sync-key" || type === "app-state-sync-version"
              ? v
              : toBufferDeep(v)
        }
        return dict
      }, {})
    },
    set: (data: any) => {
      for (const t of Object.keys(data)) {
        const bag = KEY_MAP[t]
        keys[bag] = keys[bag] || {}
        const payload =
          t === "app-state-sync-key" || t === "app-state-sync-version"
            ? data[t]
            : toBufferDeep(data[t])
        Object.assign(keys[bag], payload)
      }
      void saveState()
    }
  }

  return {
    state: {
      creds: toBufferDeep(creds),
      keys: makeCacheableSignalKeyStore(rawKeyStore as any)
    },
    saveState
  }
}
