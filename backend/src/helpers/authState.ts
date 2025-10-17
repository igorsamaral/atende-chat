// src/libs/authState.ts
import type { AuthenticationCreds, AuthenticationState } from "@whiskeysockets/baileys"
import { initAuthCreds, makeCacheableSignalKeyStore } from "@whiskeysockets/baileys"
import Whatsapp from "../models/Whatsapp"

// ---------- utils: garantir Buffer em todos os campos binários ----------
const toBuffer = (v: any): any => {
  if (Buffer.isBuffer(v)) return v
  if (v instanceof Uint8Array) return Buffer.from(v)
  if (typeof v === "string") return Buffer.from(v, "base64")
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

// normaliza especificamente as creds usadas no Noise/Signal
const normalizeCreds = (c: any) => {
  if (!c) return c
  if (c.advSecretKey) c.advSecretKey = toBuffer(c.advSecretKey)
  if (c.noiseKey) {
    if (c.noiseKey.private) c.noiseKey.private = toBuffer(c.noiseKey.private)
    if (c.noiseKey.public) c.noiseKey.public = toBuffer(c.noiseKey.public)
  }
  if (c.signedIdentityKey) {
    if (c.signedIdentityKey.private) c.signedIdentityKey.private = toBuffer(c.signedIdentityKey.private)
    if (c.signedIdentityKey.public) c.signedIdentityKey.public = toBuffer(c.signedIdentityKey.public)
  }
  if (c.signedPreKey) {
    if (c.signedPreKey.signature) c.signedPreKey.signature = toBuffer(c.signedPreKey.signature)
    if (c.signedPreKey.keyPair) {
      if (c.signedPreKey.keyPair.private) c.signedPreKey.keyPair.private = toBuffer(c.signedPreKey.keyPair.private)
      if (c.signedPreKey.keyPair.public) c.signedPreKey.keyPair.public = toBuffer(c.signedPreKey.keyPair.public)
    }
  }
  if (c.account?.signatureKey?.public) c.account.signatureKey.public = toBuffer(c.account.signatureKey.public)
  return c
}

// JSON helpers: salva Buffer/Uint8Array como base64; lê de volta como Buffer
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
  "app-state-sync-key": "appStateSyncKeys",      // manter cru
  "app-state-sync-version": "appStateVersions",  // manter cru
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
    creds = normalizeCreds(toBufferDeep(parsed.creds)) // <- normaliza campos críticos
    keys = parsed.keys || {}
    // Normalize any buffer-like shapes in keys to actual Uint8Array instances
    const normalize = (val: any): any => {
      if (!val || typeof val !== "object") return val;
      // already a typed array
      if (val instanceof Uint8Array) return val;

      // arrays of numbers -> Uint8Array
      if (Array.isArray(val) && val.every((x) => typeof x === "number")) {
        return Uint8Array.from(val);
      }

      // { type: 'Buffer', data: ... }
      if (val.type === "Buffer") {
        const d = val.data;
        if (typeof d === "string") return Uint8Array.from(Buffer.from(d, "base64"));
        if (Array.isArray(d)) return Uint8Array.from(d);
        if (d && typeof d === "object") {
          const arr = Object.keys(d)
            .map((k) => Number(k))
            .filter((k) => !Number.isNaN(k))
            .sort((a, b) => a - b)
            .map((i) => d[i]);
          return Uint8Array.from(arr);
        }
      }

      // object with numeric keys -> treat as array-like
      const keysObj = Object.keys(val);
      if (
        keysObj.length > 0 &&
        keysObj.every((k) => /^\d+$/.test(k)) &&
        keysObj.every((k) => typeof val[k] === "number")
      ) {
        const arr = keysObj
          .map((k) => Number(k))
          .sort((a, b) => a - b)
          .map((i) => val[i]);
        return Uint8Array.from(arr);
      }

      // otherwise recursively normalize properties
      for (const k of Object.keys(val)) {
        val[k] = normalize(val[k]);
      }
      return val;
    };

    keys = normalize(keys);
    // Final sweep: ensure there are no plain objects that look like byte arrays remaining
    let firstProblem: { path: string; value: any } | null = null
    const sweep = (obj: any, path = "") => {
      if (obj == null) return
      if (typeof obj !== "object") return
      if (obj instanceof Uint8Array || Buffer.isBuffer(obj)) return
      if (Array.isArray(obj)) {
        // arrays of numbers should be converted
        if (obj.every((x) => typeof x === "number")) {
          const buf = Uint8Array.from(obj)
          return buf
        }
        for (let i = 0; i < obj.length; i++) obj[i] = sweep(obj[i], `${path}[${i}]`) || obj[i]
        return obj
      }
      // object with numeric keys
      const keysObj = Object.keys(obj)
      if (
        keysObj.length > 0 &&
        keysObj.every((k) => /^\d+$/.test(k)) &&
        keysObj.every((k) => typeof obj[k] === "number")
      ) {
        const arr = keysObj.map((k) => Number(k)).sort((a, b) => a - b).map((i) => obj[i])
        return Uint8Array.from(arr)
      }

      // detect Buffer-like shapes { type: 'Buffer', data: ... }
      if (obj.type === "Buffer" && obj.data) {
        const d = obj.data
        if (typeof d === "string") return Uint8Array.from(Buffer.from(d, "base64"))
        if (Array.isArray(d)) return Uint8Array.from(d)
      }

      for (const k of keysObj) {
        const res = sweep(obj[k], path ? `${path}.${k}` : k)
        if (res) obj[k] = res
      }
      return null
    }
    // run sweep on creds and keys
    sweep(creds, "creds")
    sweep(keys, "keys")
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
              : toBufferDeep(v) // garantir Buffer
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
            ? data[t]            // manter cru
            : toBufferDeep(data[t]) // normalizar p/ Buffer
        Object.assign(keys[bag], payload)
      }
      void saveState()
    }
  }

  return {
    state: {
      creds: toBufferDeep(creds),
      keys: makeCacheableSignalKeyStore(rawKeyStore as any) // wrapper oficial
    },
    saveState
  }
}
