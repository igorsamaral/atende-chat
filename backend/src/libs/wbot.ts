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
  const sessionIndex = sessions.findIndex((s) => s.id === whatsappId);
  if (sessionIndex === -1) throw new AppError("ERR_WAPP_NOT_INITIALIZED");
  return sessions[sessionIndex];
};

export const removeWbot = async (whatsappId: number, isLogout = true): Promise<void> => {
  try {
    const sessionIndex = sessions.findIndex((s) => s.id === whatsappId);
    if (sessionIndex !== -1) {
      if (isLogout) {
        try { sessions[sessionIndex].logout(); } catch (_) { /* ignore */ }
        try { sessions[sessionIndex].ws.close(); } catch (_) { /* ignore */ }
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
      const io = getIO();
      const whatsappUpdate = await Whatsapp.findOne({ where: { id: whatsapp.id } });
      if (!whatsappUpdate) return reject(new Error("Whatsapp not found"));

      const { id, name, provider } = whatsappUpdate;
      const { version, isLatest } = await fetchLatestBaileysVersion();

      logger.info(`using WA v${version.join(".")}, isLatest: ${isLatest}`);
      logger.info(`isLegacy: ${provider === "stable"}`);
      logger.info(`Starting session ${name}`);

      let retriesQrCode = 0;
      let wsocket: Session | null = null;

      const store = typeof (baileysMakeInMemoryStore as any) === "function"
        ? (baileysMakeInMemoryStore as any)({ logger: loggerBaileys })
        : ({ bind: (_ev: any) => { /* no-op */ } } as any);

      const { state, saveState } = await authState(whatsapp);

      const msgRetryCounterCache = new NodeCache();
      const userDevicesCache: CacheStore = new NodeCache();

      wsocket = makeWASocket({
        logger: loggerBaileys,
        printQRInTerminal: false,
        browser: Browsers.appropriate("Desktop"),
        auth: state,
        version,
        msgRetryCounterCache,
        shouldIgnoreJid: (jid) => isJidBroadcast(jid),
      }) as Session;

      wsocket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        logger.info(`Socket ${name} Connection Update ${connection || ""} ${lastDisconnect || ""}`);

        if (connection === "close") {
          const code = (lastDisconnect?.error as Boom)?.output?.statusCode || (lastDisconnect?.error as any)?.code;
          if (code === 403 || code === DisconnectReason.loggedOut) {
            await whatsappUpdate.update({ status: "PENDING", session: "" });
            await DeleteBaileysService(whatsapp.id);
            getIO().to(`company-${whatsapp.companyId}-mainchannel`).emit(`company-${whatsapp.companyId}-whatsappSession`, { action: "update", session: whatsappUpdate });
            removeWbot(id, false);
            setTimeout(() => StartWhatsAppSession(whatsapp, whatsapp.companyId), 2000);
          } else {
            removeWbot(id, false);
            setTimeout(() => StartWhatsAppSession(whatsapp, whatsapp.companyId), 2000);
          }
        }

        if (connection === "open") {
          await whatsappUpdate.update({ status: "CONNECTED", qrcode: "", retries: 0 });
          io.to(`company-${whatsapp.companyId}-mainchannel`).emit(`company-${whatsapp.companyId}-whatsappSession`, { action: "update", session: whatsappUpdate });
          const sessionIndex = sessions.findIndex((s) => s.id === whatsapp.id);
          if (sessionIndex === -1) { wsocket!.id = whatsapp.id; sessions.push(wsocket!); }
          resolve(wsocket!);
        }

        if (qr !== undefined) {
          if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id)! >= 3) {
            await whatsappUpdate.update({ status: "DISCONNECTED", qrcode: "" });
            await DeleteBaileysService(whatsappUpdate.id);
            io.to(`company-${whatsapp.companyId}-mainchannel`).emit("whatsappSession", { action: "update", session: whatsappUpdate });
            wsocket!.ev.removeAllListeners("connection.update");
            try { wsocket!.ws.close(); } catch (_) { /* ignore */ }
            wsocket = null;
            retriesQrCodeMap.delete(id);
          } else {
            retriesQrCodeMap.set(id, (retriesQrCode += 1));
            await whatsappUpdate.update({ qrcode: qr, status: "qrcode", retries: 0 });
            const sessionIndex = sessions.findIndex((s) => s.id === whatsapp.id);
            if (sessionIndex === -1) { wsocket!.id = whatsapp.id; sessions.push(wsocket!); }
            io.to(`company-${whatsapp.companyId}-mainchannel`).emit(`company-${whatsapp.companyId}-whatsappSession`, { action: "update", session: whatsappUpdate });
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
