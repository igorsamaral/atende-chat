import type {
  AuthenticationCreds,
  AuthenticationState
} from "@whiskeysockets/baileys";
// import runtime helpers directly from the package so we get runtime values
import { initAuthCreds } from "@whiskeysockets/baileys/lib/Utils/auth-utils.js";
import * as proto from "@whiskeysockets/baileys/WAProto/index.js";

// local BufferJSON replacer/reviver to persist binary fields (Uint8Array) as base64
const BufferJSON = {
  replacer: (_k: string, value: any) => {
    if (value instanceof Uint8Array) {
      return { type: "Buffer", data: Buffer.from(value).toString("base64") };
    }
    return value;
  },
  reviver: (_k: string, value: any) => {
    if (value && value.type === "Buffer") {
      // handle base64 string ("data": "...base64...")
      if (typeof value.data === "string") {
        return Uint8Array.from(Buffer.from(value.data, "base64"));
      }
      // handle array of numbers ([1,2,3]) or object with numeric indices
      if (Array.isArray(value.data)) {
        return Uint8Array.from(value.data);
      }
      if (value.data && typeof value.data === "object") {
        // convert { '0':1,'1':2 } to Uint8Array
        const arr = Object.keys(value.data)
          .map(k => Number(k))
          .filter(k => !Number.isNaN(k))
          .sort((a, b) => a - b)
          .map(i => value.data[i]);
        return Uint8Array.from(arr);
      }
    }
    return value;
  }
};
import Whatsapp from "../models/Whatsapp";

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
      await whatsapp.update({
        session: JSON.stringify({ creds, keys }, BufferJSON.replacer, 0)
      });
    } catch (error) {
      console.log(error);
    }
  };

  // const getSessionDatabase = await whatsappById(whatsapp.id);

  if (whatsapp.session && whatsapp.session !== null) {
    const result = JSON.parse(whatsapp.session, BufferJSON.reviver);
    creds = result.creds;
    keys = result.keys;
  } else {
    creds = initAuthCreds();
    keys = {};
  }

  return {
    state: {
      creds,
      keys: {
        get: (type, ids) => {
          const key = KEY_MAP[type];
          return ids.reduce((dict: any, id) => {
            let value = keys[key]?.[id];
            if (value) {
              if (type === "app-state-sync-key") {
                // keep raw object for app-state-sync-key (runtime proto class not required)
                // previous versions converted to a proto class, but the plain object is sufficient
                // for storage and later usage by the library.
                value = value;
              }
              dict[id] = value;
            }
            return dict;
          }, {});
        },
        set: (data: any) => {
          // eslint-disable-next-line no-restricted-syntax, guard-for-in
          for (const i in data) {
            const key = KEY_MAP[i];
            keys[key] = keys[key] || {};
            Object.assign(keys[key], data[i]);
          }
          saveState();
        }
      }
    },
    saveState
  };
};

export default authState;
