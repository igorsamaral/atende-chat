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

// evita "tempestade" de reconexões no mesmo processo
const reconnectCooldown = new NodeCache({ stdTTL: 2, checkperiod: 2 });

// contador de backoff por instância (em memória do processo)
const reconnectAttempts = new Map<number, number>();

/**
 * Extrai statusCode de um erro Boom/“cru”
 */
function getStatusCode(err: unknown): number | undefined {
  const boom = err as Boom | undefined;
  if (boom && (boom as any)?.isBoom && boom.output?.statusCode) {
    return boom.output.statusCode;
  }
  const anyErr = err as any;
  return anyErr?.output?.statusCode ?? anyErr?.statusCode ?? anyErr?.code;
}

/**
 * Erros transitórios típicos de rede/stream (reconectar mantendo auth)
 */
function isTransient(status?: number) {
  return (
    status === DisconnectReason.connectionClosed ||
    status === DisconnectReason.connectionLost ||
    status === 503 ||
    status === 515 ||
    typeof status === "undefined"
  );
}

/**
 * Lock “distribuído” simples usando o próprio model Whatsapp.status
 * Marca CONNECTING por até 20s; se outro processo já estiver conectando/conectado, não inicia outra sessão.
 */
async function acquireSessionLock(whatsapp: Whatsapp): Promise<boolean> {
  const fresh = await Whatsapp.findOne({ where: { id: whatsapp.id } });
  if (!fresh) return false;

  const now = Date.now();
  const updatedAt = (fresh as any).updatedAt ? new Date((fresh as any).updatedAt).getTime() : 0;
  const ageMs = now - updatedAt;

  const status: string = (fresh as any).status || "";

  // se já está CONNECTED, não tentar
  if (status === "CONNECTED") return false;

  // se está CONNECTING “recente”, respeitar lock
  if (status === "CONNECTING" && ageMs < 20000) return false;

  try {
    await fresh.update({ status: "CONNECTING" });
    return true;
  } catch {
    return false;
  }
}

async function releaseSessionLock(whatsapp: Whatsapp, nextStatus: string = "DISCONNECTED") {
  try {
    const fresh = await Whatsapp.findOne({ where: { id: whatsapp.id } });
    if (!fresh) return;
    // só atualiza se ainda estiver marcado como CONNECTING (evita sobreescrever CONNECTED)
    if ((fresh as any).status === "CONNECTING") {
      await fresh.update({ status: nextStatus });
    }
  } catch {
    // ignore
  }
}

/**
 * Reinicia a sessão com cooldown + jitter e com lock via DB
 */
async function safeRestart(whatsapp: Whatsapp) {
  const key = `re:${whatsapp.id}`;
  if (reconnectCooldown.get(key)) return;

  reconnectCooldown.set(key, true);
  const tries = (reconnectAttempts.get(whatsapp.id) || 0) + 1;
  reconnectAttempts.set(whatsapp.id, tries);

  // backoff exponencial com teto (1.2s * 2^n; máx. 15s) + jitter 0-800ms
  const base = 1200 * Math.pow(2, Math.min(tries - 1, 3)); // 1.2s, 2.4s, 4.8s, 9.6s...
  const delay = Math.min(15000, base);
  const jitter = Math.floor(Math.random() * 800);
  await new Promise((r) => setTimeout(r, delay + jitter));

  // tenta adquirir lock
  const gotLock = await acquireSessionLock(whatsapp);
  if (!gotLock) {
    logger.warn(`[WA:${whatsapp.id}] lock not acquired, skipping restart`);
    return;
  }

  try {
    logger.info(`[WA:${whatsapp.id}] restarting session... (attempt ${tries})`);
    StartWhatsAppSession(whatsapp, whatsapp.companyId);
  } catch (e) {
    logger.error(`[WA:${whatsapp.id}] restart error`, e);
    // libera lock para permitir outra tentativa futura
    await releaseSessionLock(whatsapp, "DISCONNECTED");
  }
}

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
      const userDevicesCache: CacheStore = new NodeCache(); // reservado para features futuras

      wsocket = makeWASocket({
        logger: loggerBaileys,
        printQRInTerminal: false,
        browser: Browsers.appropriate("Desktop"),
        auth: state,
        version,
        msgRetryCounterCache,
        shouldIgnoreJid: (jid) => isJidBroadcast(jid),
      }) as Session;

      // zera tentativas (voltou a montar socket)
      reconnectAttempts.set(whatsapp.id, 0);

      wsocket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
        logger.info(`Socket ${name} Connection Update ${connection || ""} ${lastDisconnect || ""}`);

        if (connection === "close") {
          const err = lastDisconnect?.error as any;
          const code = getStatusCode(err);
          logger.warn(`[${name}] close status=${code} details=${err?.message || ""}`);

          // encerra listeners/socket antigos (evita duplicação)
          try { wsocket?.ev.removeAllListeners("connection.update"); } catch {}
          try { (wsocket as any)?.end?.(); } catch {}
          try { wsocket?.ws?.close(); } catch {}

          // logged out → precisa re-parear
          if (code === 403 || code === DisconnectReason.loggedOut || code === 401) {
            await whatsappUpdate.update({ status: "PENDING", session: "" });
            await DeleteBaileysService(whatsapp.id);

            io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
              `company-${whatsapp.companyId}-whatsappSession`,
              { action: "update", session: whatsappUpdate }
            );

            await removeWbot(id, false);
            await safeRestart(whatsapp);
            return;
          }

          // falha transitória (rede/stream)
          if (isTransient(code)) {
            await removeWbot(id, false);
            await safeRestart(whatsapp);
            return;
          }

          // fallback: trata como transitório
          await removeWbot(id, false);
          await safeRestart(whatsapp);
        }

        if (connection === "open") {
          // conexão OK — marca conectado e libera o "lock"
          await whatsappUpdate.update({ status: "CONNECTED", qrcode: "", retries: 0 });
          io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
            `company-${whatsapp.companyId}-whatsappSession`,
            { action: "update", session: whatsappUpdate }
          );

          const sessionIndex = sessions.findIndex((s) => s.id === whatsapp.id);
          if (sessionIndex === -1) { wsocket!.id = whatsapp.id; sessions.push(wsocket!); }

          // libera lock se ainda marcado
          await releaseSessionLock(whatsapp, "CONNECTED");

          resolve(wsocket!);
        }

        if (qr !== undefined) {
          // controla spam de QR
          if (retriesQrCodeMap.get(id) && retriesQrCodeMap.get(id)! >= 3) {
            await whatsappUpdate.update({ status: "DISCONNECTED", qrcode: "" });
            await DeleteBaileysService(whatsappUpdate.id);

            io.to(`company-${whatsapp.companyId}-mainchannel`).emit(
              "whatsappSession",
              { action: "update", session: whatsappUpdate }
            );

            try { wsocket!.ev.removeAllListeners("connection.update"); } catch {}
            try { (wsocket as any)?.end?.(); } catch {}
            try { wsocket!.ws.close(); } catch {}
            wsocket = null;
            retriesQrCodeMap.delete(id);
          } else {
            retriesQrCodeMap.set(id, (retriesQrCode += 1));
            await whatsappUpdate.update({ qrcode: qr, status: "qrcode", retries: 0 });

            const sessionIndex = sessions.findIndex((s) => s.id === whatsapp.id);
            if (sessionIndex === -1) { wsocket!.id = whatsapp.id; sessions.push(wsocket!); }

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
