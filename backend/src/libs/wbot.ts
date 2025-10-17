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
import authState from "../helpers/authState";

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
      reject(error);
    }
  });
};

export async function startWbot({ whatsapp }: StartOpts) {
  const { version, isLatest } = await fetchLatestBaileysVersion()
  logger.info({ version, isLatest }, "Using WA version")

  const { state, saveState } = await authState(whatsapp)

  const sock = makeWASocket({
    version,
    logger: loggerBaileys,
    browser: Browsers("Atendechat", "Chrome", "1.0.0"),
    printQRInTerminal: false,
    auth: state,                 // <- idem aqui
    syncFullHistory: false,
    markOnlineOnConnect: false,
    emitOwnEvents: false,
    defaultQueryTimeoutMs: 60_000
  })

  sock.ev.on("creds.update", saveState)
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update
    if (qr) logger.info("QR code gerado (envie para o front)")
    if (connection === "close") {
      const code =
        (lastDisconnect?.error as any)?.output?.statusCode ||
        (lastDisconnect?.error as any)?.code
      logger.error({ code, err: lastDisconnect?.error }, "Conexão fechada")
      if (code === DisconnectReason.loggedOut) void whatsapp.update({ session: null })
    }
    if (connection === "open") logger.info("Conectado ao WhatsApp ✅")
  })

  return sock
}
