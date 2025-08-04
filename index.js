const fs = require("fs");
const http = require("http");
const path = require("path");
const express = require("express");
const { Server } = require("socket.io");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  proto,
} = require("@whiskeysockets/baileys");
const { toBuffer } = require("qrcode");
const levenshtein = require("fast-levenshtein");
const sendMessages = require("./sendMessages");
const db = require("./db");
const { DateTime } = require("luxon");

const AUTH_FOLDER = "auth_info";
const PORT = 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

let isConnected = false;
const activeSessions = {};
const sessions = {};
const pendingMessages = {};

function emitStatus(msg) {
  console.log(msg);
  io.emit("status", msg);
}

function setConnection(status) {
  isConnected = status;
  io.emit("connected", status);
}

async function restartBot() {
  emitStatus("🔄 Menghapus sesi lama...");
  fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
  emitStatus("✅ Sesi dihapus, memulai ulang...");
  startBot();
}

function resetSessionTimeout(sock, senderJid) {
  return setTimeout(async () => {
    delete activeSessions[senderJid];
    delete sessions[senderJid];
    delete pendingMessages[senderJid];
    await sock.sendMessage(senderJid, {
      text: "⏳ Sesi telah berakhir karena tidak ada aktivitas selama 1 menit. Silakan ketik *hallo* untuk memulai ulang.",
    });
    console.log(`⏳ Sesi otomatis dihentikan untuk ${senderJid}`);
  }, 60000);
}

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on(
    "connection.update",
    async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        emitStatus("🔄 QR Code diperbarui!");
        const qrBuffer = await toBuffer(qr);
        io.emit("qr", `data:image/png;base64,${qrBuffer.toString("base64")}`);
        setConnection(false);
      }

      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        if (reason === 401) {
          emitStatus("❌ Logout terdeteksi! Restarting...");
          setConnection(false);
          restartBot();
        } else {
          emitStatus("🔄 Koneksi terputus, mencoba menyambung ulang...");
          startBot();
        }
      } else if (connection === "open") {
        emitStatus("✅ Terhubung ke WhatsApp!");
        setConnection(true);
        sendMessages(sock, io);
      }
    }
  );

  async function markAsRead(msg) {
    await sock.readMessages([
      {
        remoteJid: msg.key.remoteJid,
        id: msg.key.id,
        participant: msg.key.participant,
      },
    ]);
  }

  const getGreetingMessage = () => {
    const now = DateTime.now().setZone("Asia/Jakarta");
    const hour = now.hour;

    let greeting;

    if (hour >= 4 && hour < 11) {
      greeting = "Selamat pagi";
    } else if (hour >= 11 && hour < 15) {
      greeting = "Selamat siang";
    } else if (hour >= 15 && hour < 18) {
      greeting = "Selamat sore";
    } else {
      greeting = "Selamat malam";
    }

    return `${greeting}, terima kasih telah menghubungi layanan kami. Silakan ketik *hallo* untuk memulai sesi percakapan.`;
  };

  const responses = getGreetingMessage();

  const responseKeluhan = `Halo, terima kasih telah menghubungi layanan kami.

Silakan sampaikan keluhan atau pertanyaan Anda melalui pesan ini. Untuk memudahkan proses tindak lanjut, mohon sertakan informasi berikut:

- Nama pelapor
- Nama perusahaan
- Uraian singkat keluhan atau kebutuhan Anda

Contoh format:
Nama: Budi Santoso
Perusahaan: PT Maju Jaya
Keluhan: Tidak dapat mengakses sistem sejak pukul 08.00 WIB.

Kami akan segera menindaklanjuti laporan Anda. Terima kasih.`;

  // Daftar pesan acak untuk menghentikan sesi
  const stopResponses = [
    "✅ Sesi telah dihentikan. Silakan ketik *hallo* untuk memulai ulang.",
    "✅ Sesi kamu sudah diakhiri. Mau mulai lagi? Ketik *hallo*!",
    "✅ Oke, sesi sudah ditutup. Kalau butuh lagi, cukup ketik *hallo* ya!",
    "✅ Sesi telah berakhir. Aku tunggu kalau kamu mau mulai lagi, ketik *hallo*!",
    "✅ Sesi ditutup. Ayo mulai lagi dengan ketik *hallo*!",
    "✅ Sesi sudah dihentikan. Kalau ada yang perlu ditanya lagi, ketik *hallo*!",
    "✅ Beres! Sesi dihentikan. Ketik *hallo* kalau mau lanjut lagi!",
    "✅ Sesi telah selesai. Aku siap membantu lagi kapan pun! Ketik *hallo* ya!",
    "✅ Sesi diakhiri. Kalau butuh bantuan lagi, cukup ketik *hallo*!",
    "✅ Sesi sudah selesai. Aku standby kalau kamu mau mulai lagi! Ketik *hallo*!",
  ];

  sock.ev.on("messages.upsert", async (m) => {
    if (!isConnected) return;

    const message = m.messages[0];
    if (!message.message || message.key.fromMe) return;

    await markAsRead(message);

    const senderJid = message.key.remoteJid;
    const messageType = Object.keys(message.message)[0];
    const text =
      messageType === "conversation"
        ? message.message.conversation
        : messageType === "extendedTextMessage"
        ? message.message.extendedTextMessage.text
        : "";

    console.log(`📩 Pesan diterima dari ${senderJid}: ${text}`);
    io.emit("incomingMessage", { sender: senderJid, text });

    const sendMessage = (jid, text) => sock.sendMessage(jid, { text });
    const randomFromArray = (arr) =>
      arr[Math.floor(Math.random() * arr.length)];
    const isStopCommand = (txt) =>
      ["/stop", "stop"].includes(txt.toLowerCase());

    const endSession = async () => {
      clearTimeout(sessions[senderJid]?.timeout);
      delete sessions[senderJid];
      delete activeSessions[senderJid];
      const stopMsg = randomFromArray(stopResponses);
      await sock.sendPresenceUpdate("composing", senderJid);
      await sendMessage(senderJid, stopMsg);
      console.log(`🛑 Sesi ${senderJid} telah dihapus.`);
    };

    if (!activeSessions[senderJid]) {
      if (text.toLowerCase() === "hallo") {
        activeSessions[senderJid] = true;
        pendingMessages[senderJid] = true;
        sessions[senderJid] = {
          active: true,
          timeout: resetSessionTimeout(sock, senderJid),
        };

        await sock.sendPresenceUpdate("composing", senderJid);
        await sendMessage(senderJid, responseKeluhan);
      } else {
        await sendMessage(senderJid, responses);
        console.log(`❌ Mengarahkan ${senderJid} untuk mengetik "hallo"`);
      }
      return;
    }

    if (pendingMessages[senderJid]) {
      const senderNumber = senderJid.replace("@s.whatsapp.net", "");
      await db
        .promise()
        .query(
          "INSERT INTO received_messages (sender, message, created_at) VALUES (?, ?, ?)",
          [senderNumber, text, new Date()]
        );

      await sock.sendPresenceUpdate("composing", senderJid);
      await sendMessage(
        senderJid,
        "✅ Pesan Anda Sudah Kami Terima, Silahkan Ketik */Stop* Untuk Mengakhiri Sesi Ini!"
      );
      delete pendingMessages[senderJid];
      return;
    }

    if (isStopCommand(text)) {
      if (activeSessions[senderJid]) {
        await endSession();
      } else {
        await sock.sendPresenceUpdate("composing", senderJid);
        await sendMessage(
          senderJid,
          "❌ Tidak ada sesi yang sedang berjalan. Ketik *hallo* untuk memulai."
        );
      }
      return;
    }

    const [rows] = await db
      .promise()
      .query("SELECT keyword, reply_message FROM auto_replies");

    let replyText = "";
    for (const row of rows) {
      const keyword = row.keyword.toLowerCase();
      const regex = new RegExp(keyword.split("").join("+") + "+", "i");

      if (
        regex.test(text) ||
        levenshtein.get(text.toLowerCase(), keyword) <= 2
      ) {
        replyText = row.reply_message.replace(/\\n/g, "\n");

        if (isStopCommand(keyword)) {
          await endSession();
          return;
        }

        break;
      }
    }

    if (!replyText) {
      replyText =
        "Maaf, silahkan stop sesi ini terlebih dahulu untuk memulai sesi baru.";
      console.log(`❌ Tidak ada keyword yang cocok untuk ${senderJid}`);
    }

    await sock.sendPresenceUpdate("composing", senderJid);
    await sendMessage(senderJid, replyText);
    console.log(`🤖 Auto-reply dikirim ke ${senderJid}: ${replyText}`);

    clearTimeout(sessions[senderJid]?.timeout);
    sessions[senderJid].timeout = resetSessionTimeout(sock, senderJid);
  });
}

// Fungsi untuk mengatur timeout sesi 1 menit
function resetSessionTimeout(sock, senderJid) {
  return setTimeout(async () => {
    delete activeSessions[senderJid];
    delete sessions[senderJid]; // Hapus sesi jika timeout
    delete pendingMessages[senderJid];
    await sock.sendMessage(senderJid, {
      text: "⏳ Sesi telah berakhir karena tidak ada aktivitas selama 1 menit. Silakan ketik *hallo* untuk memulai ulang.",
    });
    console.log(`⏳ Sesi otomatis dihentikan untuk ${senderJid}`);
  }, 60000); // 60 detik
}

server.listen(PORT, () => {
  console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});

startBot();
