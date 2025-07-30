const {
    default: makeWASocket,
    useMultiFileAuthState,
} = require("@whiskeysockets/baileys");
const sendMessages = require("./sendMessages");
const db = require("./db");
const fs = require("fs");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { toBuffer } = require("qrcode");
const levenshtein = require("fast-levenshtein");
const { proto } = require("@whiskeysockets/baileys");

const AUTH_FOLDER = "auth_info";
const PORT = 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const activeSessions = {}; // Objek untuk menyimpan sesi aktif pengguna
const sessions = {}; // Simpan sesi pengguna dan timeoutnya
const pendingMessages = {}; // Objek untuk menyimpan pesan yang menunggu input lanjutan

app.use(express.static(__dirname + "/public"));

let isConnected = false; // Tambahkan flag untuk status koneksi bot

async function restartBot() {
    console.log("🔄 Menghapus sesi lama...");
    io.emit("status", "Menghapus sesi lama...");
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });

    console.log("✅ Sesi dihapus, memulai ulang...");
    io.emit("status", "Sesi dihapus, memulai ulang...");
    startBot();
}

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log("🔄 QR Code diperbarui!");
            io.emit("status", "QR Code diperbarui!");
            const qrBuffer = await toBuffer(qr);
            io.emit(
                "qr",
                `data:image/png;base64,${qrBuffer.toString("base64")}`
            );
            io.emit("connected", false);
            isConnected = false; // Bot dalam keadaan logout
        }

        if (connection === "close") {
            const reason = lastDisconnect?.error?.output?.statusCode;
            if (reason === 401) {
                console.log("❌ Logout terdeteksi! Restarting...");
                io.emit("status", "Logout terdeteksi! Restarting...");
                io.emit("connected", false);
                isConnected = false; // Bot logout
                restartBot();
            } else {
                console.log("🔄 Koneksi terputus, mencoba menyambung ulang...");
                io.emit(
                    "status",
                    "Koneksi terputus, mencoba menyambung ulang..."
                );
                startBot();
            }
        } else if (connection === "open") {
            console.log("✅ Terhubung ke WhatsApp!");
            io.emit("status", "Terhubung ke WhatsApp!");
            io.emit("connected", true);
            isConnected = true; // Bot terhubung
            sendMessages(sock, io);
        }
    });

    async function markAsRead(msg) {
        const jid = msg.key.remoteJid;
        await sock.readMessages([
            {
                remoteJid: jid,
                id: msg.key.id,
                participant: msg.key.participant,
            },
        ]);
    }

    const responses = [
        "Silahkan ketik *hallo* untuk memulai sesi!",
        "Ayo mulai sesi dengan mengetik *hallo*!",
        "Ketik *hallo* dulu yuk, biar aku bisa bantu!",
        "Hmm, aku belum paham. Coba ketik *hallo* dulu!",
        "Mulai obrolan kita dengan ketik *hallo*!",
        "Ups! Aku cuma bisa paham kalau kamu ketik *hallo* dulu!",
        "Mau lanjut? Ketik *hallo* ya!",
        "Aku siap membantu! Mulai dengan ketik *hallo* dulu.",
        "Kamu belum memulai sesi! Yuk ketik *hallo* dulu.",
        "Biar makin seru, coba ketik *hallo* dulu!",
    ];

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
        if (!isConnected) return; // Jika bot logout, abaikan pesan masuk
        let send = true;
        const message = m.messages[0];
        if (!message.message) return;

        await markAsRead(message);

        const senderJid = message.key.remoteJid;
        const messageType = Object.keys(message.message)[0];
        let text = "";

        if (messageType === "conversation") {
            text = message.message.conversation;
        } else if (messageType === "extendedTextMessage") {
            text = message.message.extendedTextMessage.text;
        }

        // Jika pesan dari bot sendiri, abaikan
        if (message.key.fromMe) return;

        console.log(`📩 Pesan diterima dari ${senderJid}: ${text}`);
        console.log(`📩 Pesan dibaca sama bot`);
        io.emit("incomingMessage", { sender: senderJid, text });

        // Cek jika user belum memulai sesi (ngecek pesannya hallo atau bukan)
        if (!activeSessions[senderJid]) {
            if (text.toLowerCase() === "hallo") {
                activeSessions[senderJid] = true; // Tandai bahwa sesi sudah dimulai (biar setelah beberapa menit otomatis stop)
                pendingMessages[senderJid] = true; // untuk mengaktifkan sesi agar pesan selanjutnya tersimpan ke database
                sessions[senderJid] = {
                    active: true,
                    timeout: resetSessionTimeout(sock, senderJid),
                };

                // let menuText =
                //     "🎉 *Sesi telah dimulai!* ✅\n\n" +
                //     "👋 *Selamat datang di bot saya!* Senang bisa membantu Anda. 🚀\n\n" +
                //     "🔹 Silakan ketik salah satu perintah berikut untuk memulai petualangan Anda! 💡\n";

                // // Ambil daftar perintah dari database
                // const [rows] = await db
                //     .promise()
                //     .query("SELECT keyword, description FROM auto_replies");

                // for (let row of rows) {
                //     menuText += `\n*${row.keyword}* : ${
                //         row.description || "Tidak ada deskripsi"
                //     }`;
                // }

                let menuText =
                    "Silahkan Kirim Keluhan anda dengan cantumkan nama pelapor dan nama perusahaan";

                await sock.sendPresenceUpdate("composing", senderJid);
                await sock.sendMessage(senderJid, { text: menuText });
                console.log(`📜 Mengirim perintah ke ${senderJid}`);
            } else {
                // Pilih pesan secara acak
                const randomResponse =
                    responses[Math.floor(Math.random() * responses.length)];

                // Jika user mengetik apapun selain "hallo" sebelum memulai sesi
                await sock.sendMessage(senderJid, {
                    text: randomResponse,
                });
                console.log(
                    `❌ Mengarahkan ${senderJid} untuk mengetik "hallo"`
                );
            }
            return;
        }

        // Cek jika pengguna dalam mode "pesan khusus" (pesan selanjutnya tersimpan ke database)
        if (pendingMessages[senderJid]) {
            // Simpan pesan ke database
            let senderNumber = senderJid.replace("@s.whatsapp.net", "");

            await db
                .promise()
                .query(
                    "INSERT INTO received_messages (sender, message) VALUES (?, ?)",
                    [senderNumber, text]
                );
            // let pesan = "Ada pesan ni dari " + senderNumber + "\n\n" + text;
            // await db
            //     .promise()
            //     .query(
            //         "INSERT INTO send_messages (recipient, message) VALUES (?, ?)",
            //         [myphone, pesan]
            //     );

            // console.log(
            //     `📥 Pesan untuk Leri disimpan dari ${senderJid}: ${text}`
            // );

            await sock.sendPresenceUpdate("composing", senderJid);
            await sock.sendMessage(senderJid, {
                text: "✅ Pesan Anda Sudah Kami Terima, Silahkan Ketik */Stop* Untuk Mengakhiri Sesi Ini!",
            });

            // Hapus status pending agar pesan berikutnya tidak masuk mode ini
            delete pendingMessages[senderJid];
            return;
        }

        // 🔥 Ambil auto-reply dari database (ini udah ga kepake soalnya sekarang setiap hallo, langsung kirim pesan khusus)
        const [rows] = await db
            .promise()
            .query(
                "SELECT keyword, reply_message, type_message FROM auto_replies"
            );

        let replyText = "";
        let minDistance = 2; // Batas toleransi typo (misal, 2 huruf boleh salah)

        for (const row of rows) {
            const keyword = row.keyword.toLowerCase();

            // 🔥 Regex untuk mendeteksi tambahan huruf berulang di mana saja dalam kata
            const regex = new RegExp(keyword.split("").join("+") + "+", "i");

            // 🔹 Cek pakai regex dulu (lebih cepat)
            if (regex.test(text)) {
                replyText = row.reply_message.replace(/\\n/g, "\n");

                let senderNumber = senderJid.replace("@s.whatsapp.net", "");

                await db
                    .promise()
                    .query(
                        "INSERT INTO all_messages (sender, message) VALUES (?, ?)",
                        [senderNumber, text]
                    );

                // Jika user memilih "/lapor keluhan", aktifkan mode "pesan"
                if (row.type_message === "Khusus") {
                    pendingMessages[senderJid] = true;
                }

                if (keyword === "/stop") {
                    if (activeSessions[senderJid]) {
                        clearTimeout(sessions[senderJid]?.timeout);
                        delete sessions[senderJid];
                        delete activeSessions[senderJid];
                        const randomStopResponse =
                            stopResponses[
                                Math.floor(Math.random() * stopResponses.length)
                            ];

                        await sock.sendPresenceUpdate("composing", senderJid);
                        // await delay(3000);
                        await sock.sendMessage(senderJid, {
                            text: randomStopResponse,
                        });
                        console.log(`🛑 Sesi ${senderJid} telah dihapus.`);
                    } else {
                        await sock.sendPresenceUpdate("composing", senderJid);
                        // await delay(3000);
                        await sock.sendMessage(senderJid, {
                            text: "❌ Tidak ada sesi yang sedang berjalan. Ketik *hallo* untuk memulai.",
                        });
                    }
                    return;
                }
                break;
            }

            // 🔹 Kalau regex gak cocok, cek Levenshtein Distance
            const distance = levenshtein.get(text.toLowerCase(), keyword);
            if (distance <= minDistance) {
                replyText = row.reply_message.replace(/\\n/g, "\n");

                let senderNumber = senderJid.replace("@s.whatsapp.net", "");

                await db
                    .promise()
                    .query(
                        "INSERT INTO all_messages (sender, message) VALUES (?, ?)",
                        [senderNumber, text]
                    );

                // Jika user memilih "/lapor keluhan", aktifkan mode "pesan"
                if (row.type_message === "Khusus") {
                    pendingMessages[senderJid] = true;
                }

                if (keyword === "/stop") {
                    if (activeSessions[senderJid]) {
                        clearTimeout(sessions[senderJid]?.timeout);
                        delete activeSessions[senderJid];
                        delete sessions[senderJid]; // Hapus sesi jika timeout
                        const randomStopResponse =
                            stopResponses[
                                Math.floor(Math.random() * stopResponses.length)
                            ];

                        await sock.sendPresenceUpdate("composing", senderJid);
                        // await delay(3000);
                        await sock.sendMessage(senderJid, {
                            text: randomStopResponse,
                        });
                        console.log(`🛑 Sesi ${senderJid} telah dihapus.`);
                    } else {
                        await sock.sendPresenceUpdate("composing", senderJid);
                        // await delay(3000);
                        await sock.sendMessage(senderJid, {
                            text: "❌ Tidak ada sesi yang sedang berjalan. Ketik *hallo* untuk memulai.",
                        });
                    }
                    // await db
                    //     .promise()
                    //     .query(
                    //         "INSERT INTO received_messages (sender, message) VALUES (?, ?)",
                    //         [senderJid, text]
                    //     );
                    return;
                }
                break;
            }
        }

        // Jika tidak ada balasan yang sesuai
        if (!replyText) {
            send = false;
            replyText = "Maaf, keyword salah.";
            console.log(`❌ Tidak ada keyword yang cocok untuk ${senderJid}`);
        }

        // Kirim auto-reply
        await sock.sendPresenceUpdate("composing", senderJid);
        // await delay(3000);
        await sock.sendMessage(senderJid, { text: replyText });
        console.log(`🤖 Auto-reply dikirim ke ${senderJid}: ${replyText}`);

        // if (send) {
        //     // Simpan pesan ke database
        //     await db
        //         .promise()
        //         .query(
        //             "INSERT INTO received_messages (sender, message) VALUES (?, ?)",
        //             [senderJid, text]
        //         );
        // }

        clearTimeout(sessions[senderJid].timeout);
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
