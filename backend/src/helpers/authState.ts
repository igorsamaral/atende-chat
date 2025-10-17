import type { AuthenticationCreds, AuthenticationState } from "@whiskeysockets/baileys";
import { initAuthCreds } from "@whiskeysockets/baileys/lib/Utils/auth-utils.js";
import { makeCacheableSignalKeyStore } from "@whiskeysockets/baileys"; // 👈 IMPORTANTE
// import * as proto from "@whiskeysockets/baileys/WAProto/index.js"; // não é necessário aqui

import Whatsapp from "../models/Whatsapp";

// helper: converte recursivamente Uint8Array -> Buffer
const toBufferDeep = (val: any): any => {
  if (val instanceof Uint8Array) return Buffer.from(val);
  if (Array.isArray(val)) return val.map(toBufferDeep);
  if (val && typeof val === "object") {
    const out: any = Array.isArray(val) ? [] : {};
    for (const k of Object.keys(val)) out[k] = toBufferDeep(val[k]);
    return out;
  }
  return val;
};

// BufferJSON agora decodifica como Buffer (não Uint8Array)
const BufferJSON = {
  replacer: (_k: string, value: any) => {
    if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
      return { type: "Buffer", data: Buffer.from(value).toString("base64") };
    }
    return value;
  },
  reviver: (_k: string, value: any) => {
    if (value && value.type === "Buffer" && typeof value.data === "string") {
      return Buffer.from(value.data, "base64"); // 👈 volta como Buffer
    }
    return value;
  }
};

const KEY_MAP: Record<string, string> = {
  "pre-key": "preKeys",
  session: "sessions",
  "sender-key": "senderKeys",
  "app-state-sync-key": "appStateSyncKeys",
  "app-state-sync-version": "appStateVersions",
  "sender-key-memory": "senderKeyMemory"
};

const authState = async (
  whatsapp: Whatsapp
): Promise<{ state: AuthenticationState; saveState: () => void }> => {
  let creds: AuthenticationCreds;
  let keys: any = {};

  const saveState = async () => {
    try {
      // salva já normalizado para base64 (via BufferJSON)
      await whatsapp.update({
        session: JSON.stringify({ creds, keys }, BufferJSON.replacer, 0)
      });
    } catch (error) {
      console.log(error);
    }
  };

  if (whatsapp.session) {
    // carrega e garante Buffer em todo lugar
    const parsed = JSON.parse(whatsapp.session, BufferJSON.reviver);
    creds = toBufferDeep(parsed.creds);
    keys = toBufferDeep(parsed.keys);
  } else {
    creds = initAuthCreds(); // já no formato esperado pela versão atual
    keys = {};
  }

  // keystore cru em memória (convertendo outputs para Buffer)
  const rawKeyStore = {
    get: (type: string, ids: string[]) => {
      const key = KEY_MAP[type];
      return ids.reduce((dict: any, id: string) => {
        const v = keys[key]?.[id];
        if (v !== undefined) {
          dict[id] = toBufferDeep(v); // 👈 garante Buffer nas chaves
        }
        return dict;
      }, {});
    },
    set: (data: any) => {
      for (const type of Object.keys(data)) {
        const key = KEY_MAP[type];
        keys[key] = keys[key] || {};
        // normaliza para Buffer ao salvar em memória
        const payload = toBufferDeep(data[type]);
        Object.assign(keys[key], payload);
      }
      void saveState();
    }
  };

  return {
    state: {
      creds: toBufferDeep(creds), // 👈 por garantia (noiseKey, signedIdentityKey, etc.)
      // ESSENCIAL: envolver com makeCacheableSignalKeyStore
      keys: makeCacheableSignalKeyStore(rawKeyStore as any)
    },
    saveState
  };
};

export default authState;
