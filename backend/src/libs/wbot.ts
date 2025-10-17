// src/libs/wbot.ts
import * as Sentry from "@sentry/node";
import makeWASocket, {
  WASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  // makeCacheableSignalKeyStore,  // <- não usar aqui
  makeInMemoryStore as baileysMakeInMemoryStore,
  isJidBroadcast,
  CacheStore
} from "@whiskeysockets/baileys";

import Whatsapp from "../models/Whatsapp";
import { logger } from "../utils/logger";
import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger";
import authState from "../helpers/authState";
import { Boom } from "@hapi/boom";
import AppError from "../errors/AppError";
import { getIO } from "./socket";
import { Store } from "./store";
import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
import NodeCache from "node-cache";

const loggerBaileys = MAIN_LOGGER.child({});
loggerBaileys.level = "error";

type StartOpts = { whatsapp: Whatsapp }

type Session = WASocket & {
  id?: number;
  store?: Store;
};

const sessions: Session[] = [];
const retriesQrCodeMap = new Map<number, number>();

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
  if (sessionIndex === -1) throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  return sessions[sessionIndex];
};

export const removeWbot = async (whatsappId: number, isLogout = true): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        sessions[sessionIndex].logout();
        sessions[sessionIndex].ws.close();
      }
      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

export const initWASocket = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise(async (resolve, reject) => {
    try {
      (async () => {
        const io = getIO();
        const whatsappUpdate = await Whatsapp.findOne({ where: { id: whatsapp.id } });
        if (!whatsappUpdate) return;

        const { id, name, provider } = whatsappUpdate;
        const { version, isLatest } = await fetchLatestBaileysVersion();
        const isLegacy = provider === "stable";

        logger.info(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
        logger.info(`isLegacy: ${isLegacy}`);
        logger.info(`Starting session ${name}`);

        let retriesQrCode = 0;
        let wsocket: Session = null;

        // store defensivo (algumas builds não exportam makeInMemoryStore)
        const store = (typeof (baileysMakeInMemoryStore as any) === "function")
          ? (baileysMakeInMemoryStore as any)({ logger: loggerBaileys })
          : { bind: (_ev: any) => { /* no-op */ } } as any;

        const { state, saveState } = await authState(whatsapp);

        // Defensive normalization: ensure creds binary fields are Buffer/Uint8Array
        const ensureBuffers = (obj: any) => {
          if (!obj || typeof obj !== "object") return obj;
          // convert { type: 'Buffer', data: 'base64' } shapes
          if (obj.type === "Buffer" && typeof obj.data === "string") {
            // src/libs/wbot.ts
            import * as Sentry from "@sentry/node";
            import makeWASocket, {
              WASocket,
              Browsers,
              DisconnectReason,
              fetchLatestBaileysVersion,
              // makeCacheableSignalKeyStore,  // <- não usar aqui
              makeInMemoryStore as baileysMakeInMemoryStore,
              isJidBroadcast,
              CacheStore
            } from "@whiskeysockets/baileys";

            import Whatsapp from "../models/Whatsapp";
            import { logger } from "../utils/logger";
            import MAIN_LOGGER from "@whiskeysockets/baileys/lib/Utils/logger";
            import authState from "../helpers/authState";
            import { Boom } from "@hapi/boom";
            import AppError from "../errors/AppError";
            import { getIO } from "./socket";
            import { Store } from "./store";
            import { StartWhatsAppSession } from "../services/WbotServices/StartWhatsAppSession";
            import DeleteBaileysService from "../services/BaileysServices/DeleteBaileysService";
            import NodeCache from "node-cache";

            const loggerBaileys = MAIN_LOGGER.child({});
            loggerBaileys.level = "error";

            type StartOpts = { whatsapp: Whatsapp };

            type Session = WASocket & {
              id?: number;
              store?: Store;
            };

            const sessions: Session[] = [];
            const retriesQrCodeMap = new Map<number, number>();

            export const getWbot = (whatsappId: number): Session => {
              const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
              if (sessionIndex === -1) throw new AppError("ERR_WAPP_NOT_INITIALIZED");
              return sessions[sessionIndex];
            };

            export const removeWbot = async (whatsappId: number, isLogout = true): Promise<void> => {
              try {
                const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
                if (sessionIndex !== -1) {
                  if (isLogout) {
                    sessions[sessionIndex].logout();
                    sessions[sessionIndex].ws.close();
                  }
                  sessions.splice(sessionIndex, 1);
                }
              } catch (err) {
                logger.error(err);
              }
            };

            export const initWASocket = async (whatsapp: Whatsapp): Promise<Session> => {
              return new Promise(async (resolve, reject) => {
                try {
                  (async () => {
                    const io = getIO();
                    const whatsappUpdate = await Whatsapp.findOne({ where: { id: whatsapp.id } });
                    if (!whatsappUpdate) return;

                    const { id, name, provider } = whatsappUpdate;
                    const { version, isLatest } = await fetchLatestBaileysVersion();
                    const isLegacy = provider === "stable";

                    logger.info(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
                    logger.info(`isLegacy: ${isLegacy}`);
                    logger.info(`Starting session ${name}`);

                    let retriesQrCode = 0;
                    let wsocket: Session = null;

                    // store defensivo (algumas builds não exportam makeInMemoryStore)
                    const store = (typeof (baileysMakeInMemoryStore as any) === "function")
                      ? (baileysMakeInMemoryStore as any)({ logger: loggerBaileys })
                      : { bind: (_ev: any) => { /* no-op */ } } as any;

                    const { state, saveState } = await authState(whatsapp);

                    // Defensive normalization: ensure creds binary fields are Buffer/Uint8Array
                    const ensureBuffers = (obj: any) => {
                      if (!obj || typeof obj !== "object") return obj;
                      // convert { type: 'Buffer', data: 'base64' } shapes
                      if (obj.type === "Buffer" && typeof obj.data === "string") {
                        try {
                          return Buffer.from(obj.data, "base64");
                        } catch (e) {
                          return obj;
                        }
                      }
                      // arrays of numbers -> Uint8Array
                      if (Array.isArray(obj) && obj.every((x) => typeof x === "number")) {
                        return Uint8Array.from(obj);
                      }

                      for (const k of Object.keys(obj)) {
                        try {
                          obj[k] = ensureBuffers(obj[k]);
                        } catch (_e) {
                          // ignore
                        }
                      }
                      return obj;
                    };

                    try {
                      if (state?.creds) {
                        // deeper, safer coercion to Buffer for anything that looks like byte array
                        const coerceToBufferDeep = (v: any): any => {
                          if (v == null) return v;
                          // if it's already a Buffer or typed array
                          if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v as any);
                          // { type: 'Buffer', data: 'base64' }
                          if (v && typeof v === "object" && (v as any).type === "Buffer" && typeof (v as any).data === "string") {
                            try { return Buffer.from((v as any).data, "base64"); } catch { return v; }
                          }
                          // arrays of numbers
                          if (Array.isArray(v) && v.every((x) => typeof x === "number")) return Buffer.from(v as any);
                          if (typeof v === "object") {
                            for (const k of Object.keys(v)) (v as any)[k] = coerceToBufferDeep((v as any)[k]);
                          }
                          return v;
                        };

                        state.creds = coerceToBufferDeep(state.creds);
                        state.keys = coerceToBufferDeep(state.keys);

                        // Additional normalization: JSON round-trip to ensure any remaining
                        // Buffer-like plain objects become actual Buffer instances.
                        const replacer = (_k: string, v: any) => {
                          if (v == null) return v;
                          if (Buffer.isBuffer(v) || v instanceof Uint8Array) return { type: "Buffer", data: Buffer.from(v as any).toString("base64") };
                          return v;
                        };
                        const reviver = (_k: string, v: any) => {
                          if (v && v.type === "Buffer" && typeof v.data === "string") return Buffer.from(v.data, "base64");
                          return v;
                        };
                        try {
                          state.creds = JSON.parse(JSON.stringify(state.creds, replacer), reviver);
                          state.keys = JSON.parse(JSON.stringify(state.keys, replacer), reviver);
                        } catch (_e) {
                          // if roundtrip fails, ignore — we already did best-effort coercion
                        }

                        if (process.env.DEBUG_AUTH === "true") {
                          /* eslint-disable no-console */
                          const sample = {
                            noiseKeyPrivateIsBuffer: Buffer.isBuffer(state.creds?.noiseKey?.private),
                            noiseKeyPublicIsBuffer: Buffer.isBuffer(state.creds?.noiseKey?.public),
                            signedIdentityKeyPrivateIsBuffer: Buffer.isBuffer(state.creds?.signedIdentityKey?.private),
                            signedPreKeySignatureIsBuffer: Buffer.isBuffer(state.creds?.signedPreKey?.signature)
                          };
                          console.info("[auth debug] creds diagnostics:", sample);
                        }
                      }
                    } catch (e) {
                      logger.error(e);
                    }

                    const msgRetryCounterCache = new NodeCache();
                    const userDevicesCache: CacheStore = new NodeCache();

                    wsocket = makeWASocket({
                      logger: loggerBaileys,
                      printQRInTerminal: false,
                      browser: Browsers.appropriate("Desktop"),
                      auth: state,                     // <- usa o state direto (sem double-wrap)
                      version,
                      msgRetryCounterCache,
                      shouldIgnoreJid: jid => isJidBroadcast(jid),
                    });

                    wsocket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
                      logger.info(`Socket  ${name} Connection Update ${connection || ""} ${lastDisconnect || ""}`);

                      if (connection === "close") {
                        const code =
                          (lastDisconnect?.error as Boom)?.output?.statusCode ||
                          (lastDisconnect?.error as any)?.code;

                        if (code === 403 || code === DisconnectReason.loggedOut) {
                          await whatsapp.update({ status: "PENDING", session: "" });
                          await DeleteBaileysService(whatsapp.id);
                          getIO()
                            .to(`company-${whatsapp.companyId}-mainchannel`)
                            .emit(`company-${whatsapp.companyId}-whatsappSession`, {
                              action: "update",
                              session: whatsapp
                            });
                          removeWbot(id, false);
                          setTimeout(() => StartWhatsAppSession(whatsapp, whatsapp.companyId), 2000);
                        } else {
                          removeWbot(id, false);
                          setTimeout(() => StartWhatsAppSession(whatsapp, whatsapp.companyId), 2000);
                        }
                      }

                      if (connection === "open") {
                        await whatsapp.update({ status: "CONNECTED", qrcode: "", retries: 0 });

                        io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
                          `company-${whatsapp.companyId}-whatsappSession`,
                          { action: "update", session: whatsapp }
                        );

                        const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
                        if (sessionIndex === -1) {
                          wsocket.id = whatsapp.id;
                          sessions.push(wsocket);
                        }
                        resolve(wsocket);
                      }

                      if (qr !== undefined) {
                        if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id) >= 3) {
                          await whatsappUpdate.update({ status: "DISCONNECTED", qrcode: "" });
                          await DeleteBaileysService(whatsappUpdate.id);
                          io.to(`company-${whatsapp.companyId}-mainchannel`).emit("whatsappSession", {
                            action: "update",
                            session: whatsappUpdate
                          });
                          wsocket.ev.removeAllListeners("connection.update");
                          wsocket.ws.close();
                          wsocket = null;
                          retriesQrCodeMap.delete(id);
                        } else {
                          logger.info(`Session QRCode Generate ${name}`);
                          retriesQrCodeMap.set(id, (retriesQrCode += 1));

                          await whatsapp.update({ qrcode: qr, status: "qrcode", retries: 0 });

                          const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
                          if (sessionIndex === -1) {
                            wsocket.id = whatsapp.id;
                            sessions.push(wsocket);
                          }

                          io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
                            `company-${whatsapp.companyId}-whatsappSession`,
                            { action: "update", session: whatsapp }
                          );
                        }
                      }
                    });

                    wsocket.ev.on("creds.update", saveState);
                    store.bind(wsocket.ev);
                  })();
                } catch (error) {
                  Sentry.captureException(error);
                  console.log(error);
                  try {
                    if (state?.creds) {
                      // Final coercion for critical credential fields
                      const coerceField = (v: any) => {
                        if (v == null) return v;
                        if (Buffer.isBuffer(v)) return v;
                        if (v instanceof Uint8Array) return Buffer.from(v as any);
                        if (typeof v === 'string') return Buffer.from(v as any, 'base64');
                        // { type: 'Buffer', data: ... }
                        if (v && typeof v === 'object' && (v as any).type === 'Buffer') {
                          if (typeof (v as any).data === 'string') return Buffer.from((v as any).data, 'base64');
                          if (Array.isArray((v as any).data)) return Buffer.from((v as any).data);
                        }
                        // array-like object {'0':..,'1':..}
                        if (v && typeof v === 'object') {
                          const keys = Object.keys(v as any);
                          if (keys.length && keys.every(k => /^\d+$/.test(k) && typeof (v as any)[k] === 'number')) {
                            const arr = keys.map(k => Number(k)).sort((a,b)=>a-b).map(i => (v as any)[i]);
                            return Buffer.from(arr as any);
                          }
                        }
                        return v;
                      };

                      const creds = state.creds;
                      try {
                        creds.noiseKey && (creds.noiseKey.private = coerceField(creds.noiseKey.private));
                        creds.noiseKey && (creds.noiseKey.public = coerceField(creds.noiseKey.public));
                        creds.signedIdentityKey && (creds.signedIdentityKey.private = coerceField(creds.signedIdentityKey.private));
                        creds.signedIdentityKey && (creds.signedIdentityKey.public = coerceField(creds.signedIdentityKey.public));
                        creds.signedPreKey && (creds.signedPreKey.signature = coerceField(creds.signedPreKey.signature));
                        creds.signedPreKey && creds.signedPreKey.keyPair && (creds.signedPreKey.keyPair.private = coerceField(creds.signedPreKey.keyPair.private));
                        creds.signedPreKey && creds.signedPreKey.keyPair && (creds.signedPreKey.keyPair.public = coerceField(creds.signedPreKey.keyPair.public));
                      } catch (er) {
                        logger.error('error coercing creds fields', er);
                      }

                      // small diagnostics (no secrets): show which fields are buffers
                      try {
                        const diag = {
                          noiseKeyPrivate: !!(state.creds?.noiseKey?.private && (Buffer.isBuffer(state.creds.noiseKey.private) || state.creds.noiseKey.private instanceof Uint8Array)),
                          noiseKeyPublic: !!(state.creds?.noiseKey?.public && (Buffer.isBuffer(state.creds.noiseKey.public) || state.creds.noiseKey.public instanceof Uint8Array)),
                          signedIdentityKeyPrivate: !!(state.creds?.signedIdentityKey?.private && (Buffer.isBuffer(state.creds.signedIdentityKey.private) || state.creds.signedIdentityKey.private instanceof Uint8Array)),
                          signedPreKeySignature: !!(state.creds?.signedPreKey?.signature && (Buffer.isBuffer(state.creds.signedPreKey.signature) || state.creds.signedPreKey.signature instanceof Uint8Array))
                        };
                        logger.info({ diag }, 'auth creds diagnostics');
                      } catch (er) {
                        // ignore diag errors
                      }
                    }
                  } catch (e) {
                    logger.error(e);
                  }
                }
              });
            };
