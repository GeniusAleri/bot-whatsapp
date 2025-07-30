const db = require("./db");

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let isProcessing = false; // Flag untuk mencegah eksekusi ganda
let botConnected = false; // Status koneksi bot

async function sendMessages(sock, io) {
    setInterval(async () => {
        console.log(`🔄 Memulai pengecekan pesan dalam database... `);
        if (isProcessing) return; // Cegah eksekusi jika masih berjalan

        isProcessing = true;

        try {
            const [rows] = await db
                .promise()
                .query("SELECT * FROM send_messages WHERE send = 0");
            if (rows.length === 0) {
                console.log("Tidak ada pesan baru.");
                io.emit("status", "Tidak ada pesan baru.");
                isProcessing = false;
                return;
            }

            for (const row of rows) {
                const jid = row.recipient + "@s.whatsapp.net";
                try {
                    const now = new Date();
                    const tanggal = now.toLocaleDateString("id-ID"); // Format: 28/02/2025
                    const waktu = now.toLocaleTimeString("id-ID"); // Format: 07:15:30

                    // Kirim status mengetik ke penerima
                    await sock.sendPresenceUpdate("composing", jid);
                    console.log(
                        `📲 Mengirim status mengetik ke ${row.recipient}...`
                    );
                    io.emit(
                        "status",
                        `📲 Mengirim status mengetik ke ${row.recipient}...`
                    );

                    await delay(3000); // Tahan status mengetik selama 3 detik

                    // Kirim pesan ke penerima
                    //           await sock.sendMessage(jid, {
                    //             text: `📢 *Notifikasi Absensi Sekolah* 📢

                    // Yth. Orang Tua/Wali dari *${row.nama}*,

                    // Kami informasikan bahwa *${row.nama}* telah melakukan absensi masuk sekolah hari ini.

                    //   📅 Tanggal: ${tanggal}
                    //   ⏰ Waktu: ${waktu}

                    // Terima kasih atas perhatiannya.

                    // Hormat kami,
                    // 📚 *[Nama Sekolah]*`,
                    //           });

                    await sock.sendMessage(jid, { text: row.message });

                    console.log(`✅ Pesan terkirim ke ${row.recipient}`);
                    io.emit("status", `✅ Pesan terkirim ke ${row.recipient}`);

                    // Update status send di database
                    await db
                        .promise()
                        .query(
                            "UPDATE send_messages SET send = 1 WHERE id = ?",
                            [row.id]
                        );

                    await delay(5000); // Delay 5 detik sebelum pesan berikutnya
                } catch (error) {
                    console.error(
                        `❌ Gagal mengirim ke ${row.recipient}:`,
                        error
                    );
                    io.emit(
                        "status",
                        `❌ Gagal mengirim ke ${row.recipient}: ${error.message}`
                    );
                }
            }
        } catch (error) {
            console.error("❌ Error saat membaca database:", error);
            io.emit(
                "status",
                `❌ Error saat membaca database: ${error.message}`
            );
        }

        isProcessing = false;
    }, 5000); // Cek database setiap 10 detik
}

module.exports = sendMessages;
