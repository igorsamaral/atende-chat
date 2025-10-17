// backend/src/libs/wbot.ts
import * as Sentry from "@sentry/node";
import makeWASocket, {
  WASocket,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
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

type Session = WASocket & { id?: number; store?: Store };

const sessions: Session[] = [];
const retriesQrCodeMap = new Map<number, number>();

export const getWbot = (whatsappId: number): Session => {
  const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
  if (sessionIndex === -1) throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  return sessions[sessionIndex];
};

export const removeWbot = async (
  whatsappId: number,
  isLogout = true
): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex(s => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        try {
          sessions[sessionIndex].logout();
        } catch {
          /* ignore */
        }
        try {
          sessions[sessionIndex].ws.close();
        } catch {
          /* ignore */
        }
      }
      sessions.splice(sessionIndex, 1);
    }
  } catch (err) {
    logger.error(err);
  }
};

export const initWASocket = async (whatsapp: Whatsapp): Promise<Session> => {
  return new Promise<Session>(async (resolve, reject) => {
    try {
      const io = getIO();
      const whatsappUpdate = await Whatsapp.findOne({
        where: { id: whatsapp.id }
      });
      if (!whatsappUpdate) return reject(new Error("Whatsapp not found"));

      const { id, name, provider } = whatsappUpdate;
      const { version, isLatest } = await fetchLatestBaileysVersion();

      logger.info(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
      logger.info(`isLegacy: ${provider === "stable"}`);
      logger.info(`Starting session ${name}`);

      let retriesQrCode = 0;
      let wsocket: Session | null = null;

      // store defensivo (algumas builds não exportam makeInMemoryStore)
      const store =
        typeof (baileysMakeInMemoryStore as any) === "function"
          ? (baileysMakeInMemoryStore as any)({ logger: loggerBaileys })
          : ({ bind: (_ev: any) => {} } as any);

      const { state, saveState } = await authState(whatsapp);

      // Best-effort: coerção profunda para Buffer em possíveis campos binários
      const deepCoerce = (x: any): any => {
        if (x == null) return x;
        if (Buffer.isBuffer(x) || x instanceof Uint8Array) return Buffer.from(x as any);
        if (Array.isArray(x) && x.every(n => typeof n === "number")) return Buffer.from(x as any);
        if (typeof x === "object") {
          for (const k of Object.keys(x)) x[k] = deepCoerce(x[k]);
        }
        return x;
      };

      try {
        if ((state as any)?.creds) {
          (state as any).creds = deepCoerce((state as any).creds);
          (state as any).keys = deepCoerce((state as any).keys);
          // roundtrip opcional para normalizar {type:'Buffer', data:'...'}
          const replacer = (_k: string, v: any) => {
            if (v == null) return v;
            if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
              return { type: "Buffer", data: Buffer.from(v as any).toString("base64") };
            }
            return v;
          };
          const reviver = (_k: string, v: any) => {
            if (v && v.type === "Buffer" && typeof v.data === "string") {
              return Buffer.from(v.data, "base64");
            }
            return v;
          };
          try {
            (state as any).creds = JSON.parse(JSON.stringify((state as any).creds, replacer), reviver);
            (state as any).keys = JSON.parse(JSON.stringify((state as any).keys, replacer), reviver);
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        logger.error(e);
      }

      const msgRetryCounterCache = new NodeCache();
      const userDevicesCache: CacheStore = new NodeCache(); // mantido se você usar depois

      wsocket = makeWASocket({
        logger: loggerBaileys,
        printQRInTerminal: false,
        browser: Browsers.appropriate("Desktop"),
        auth: state, // usa o state direto (sem double-wrap)
        version,
        msgRetryCounterCache,
        shouldIgnoreJid: jid => isJidBroadcast(jid)
      }) as Session;

      wsocket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        logger.info(
          `Socket ${name} Connection Update ${connection || ""} ${lastDisconnect || ""}`
        );

        if (connection === "close") {
          const code =
            (lastDisconnect?.error as Boom)?.output?.statusCode ||
            (lastDisconnect?.error as any)?.code;

          if (code === 403 || code === DisconnectReason.loggedOut) {
            await whatsappUpdate.update({ status: "PENDING", session: "" });
            await DeleteBaileysService(whatsapp.id);
            io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
              `company-${whatsapp.companyId}-whatsappSession`,
              { action: "update", session: whatsappUpdate }
            );
            removeWbot(id, false);
            setTimeout(() => StartWhatsAppSession(whatsapp, whatsapp.companyId), 2000);
          } else {
            removeWbot(id, false);
            setTimeout(() => StartWhatsAppSession(whatsapp, whatsapp.companyId), 2000);
          }
        }

        if (connection === "open") {
          await whatsappUpdate.update({
            status: "CONNECTED",
            qrcode: "",
            retries: 0
          });

          io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
            `company-${whatsapp.companyId}-whatsappSession`,
            { action: "update", session: whatsappUpdate }
          );

          const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
          if (sessionIndex === -1) {
            wsocket!.id = whatsapp.id;
            sessions.push(wsocket!);
          }
          return resolve(wsocket!);
        }

        if (qr !== undefined) {
          if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id)! >= 3) {
            await whatsappUpdate.update({ status: "DISCONNECTED", qrcode: "" });
            await DeleteBaileysService(whatsappUpdate.id);
            io.to(`company-${whatsapp.companyId}-mainchannel`).emit("whatsappSession", {
              action: "update",
              session: whatsappUpdate
            });
            wsocket!.ev.removeAllListeners("connection.update");
            try {
              wsocket!.ws.close();
            } catch {
              /* ignore */
            }
            wsocket = null;
            retriesQrCodeMap.delete(id);
          } else {
            retriesQrCodeMap.set(id, (retriesQrCode += 1));
            await whatsappUpdate.update({
              qrcode: qr,
              status: "qrcode",
              retries: 0
            });

            const sessionIndex = sessions.findIndex(s => s.id === whatsapp.id);
            if (sessionIndex === -1) {
              wsocket!.id = whatsapp.id;
              sessions.push(wsocket!);
            }

            io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
              `company-${whatsapp.companyId}-whatsappSession`,
              { action: "update", session: whatsappUpdate }
            );
          }
        }
      });

      wsocket.ev.on("creds.update", saveState);
      store.bind(wsocket.ev);
    } catch (error) {
      Sentry.captureException(error);
      logger.error(error);
      return reject(error as Error);
    }
  });
};
