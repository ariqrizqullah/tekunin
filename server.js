require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const cors = require('cors'); 
const db = require('./db');

const app = express();
app.use(cors()); 
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Fungsi Kirim Notifikasi WhatsApp ke Admin
async function sendWhatsAppNotification(customerId, message) {
  const token = process.env.WA_TOKEN;
  const adminPhone = process.env.ADMIN_PHONE;
  if (!token || !adminPhone) return;

  const text = `🔔 *NOTIFIKASI PELANGGAN BARU*\n\nPelanggan: ${customerId}\nPesan: "${message}"\n\nSegera buka dashboard admin!`;
  try {
    await axios.post('https://api.fonnte.com/send', { target: adminPhone, message: text }, {
      headers: { Authorization: token }
    });
  } catch (error) {
    console.error('Gagal mengirim WA:', error.response?.data || error.message);
  }
}

// Fungsi Panggil Groq AI dengan Format Instruksi (System Prompt) yang Rapi & Terstruktur
async function getGroqResponseWithRetry(chatHistory, retries = 3, delayMs = 2000) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error("CRITICAL: GROQ_API_KEY belum disetel di file .env!");
    throw new Error("GROQ_API_KEY belum disetel");
  }

  // Instruksi sistem untuk memastikan bot menjawab dengan format rapi, paragraf pendek, dan poin-poin
  const messages = [
    {
      role: "system",
      content: `Kamu adalah asisten Customer Service e-commerce Tekunin CCTV yang ramah, sopan, dan sangat membantu dalam bahasa Indonesia. 
PENTING DALAM FORMATTING JAWABAN:
1. Berikan jawaban yang terstruktur dengan rapi dan enak dibaca.
2. Gunakan poin-poin (bullet points) dengan simbol dash (-) jika menjelaskan spesifikasi produk, fitur, atau langkah-langkah.
3. Gunakan teks tebal (**teks**) untuk menyoroti informasi penting seperti harga, nama produk, atau status.
4. Gunakan paragraf pendek dan pisahkan dengan baris baru agar tidak menumpuk menjadi satu teks yang panjang dan berantakan.`
    },
    ...chatHistory.map(r => ({
      role: r.role === 'model' ? 'assistant' : 'user',
      content: r.parts && r.parts[0] ? r.parts[0].text : String(r.parts)
    }))
  ];

  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model: 'openai/gpt-oss-120b', // Model yang aktif di akun Groq Anda
          messages: messages,
          temperature: 0.7,
          max_tokens: 1024
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );
      
      if (response.data && response.data.choices && response.data.choices[0]) {
        return response.data.choices[0].message.content;
      } else {
        throw new Error("Format respons dari Groq tidak valid");
      }
    } catch (error) {
      console.error(`[Peringatan] Groq API Error (Percobaan ${i+1}/${retries}):`, error.response?.data || error.message);
      if (i < retries - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      } else {
        throw error;
      }
    }
  }
}

// REST API Admin untuk Daftar Customer
app.get('/api/customers', (req, res) => {
  const query = `
    SELECT s.customer_id, s.is_bot_active,
      (SELECT text FROM messages WHERE customer_id = s.customer_id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE customer_id = s.customer_id ORDER BY id DESC LIMIT 1) AS last_time
    FROM sessions s ORDER BY last_time DESC
  `;
  db.all(query, [], (err, rows) => {
    if (err) {
      console.error("DB Error /api/customers:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true, customers: rows || [] });
  });
});

// REST API Admin untuk Riwayat Chat
app.get('/api/chat-history/:customerId', (req, res) => {
  const { customerId } = req.params;
  db.all(`SELECT sender, text, created_at FROM messages WHERE customer_id = ? ORDER BY id ASC`, [customerId], (err, rows) => {
    if (err) {
      console.error("DB Error /api/chat-history:", err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
    res.json({ success: true, customerId, messages: rows || [] });
  });
});

// Socket.io Real-time
io.on('connection', (socket) => {
  console.log('Client terhubung via Socket.io:', socket.id);

  socket.on('customer_join', (customerId) => {
    if (!customerId) return;
    socket.join(customerId);
    db.run(`INSERT OR IGNORE INTO sessions (customer_id, is_bot_active) VALUES (?, 1)`, [customerId]);
  });

  socket.on('customer_message', async (data) => {
    const { customerId, message } = data;
    if (!customerId || !message) return;

    console.log(`Pesan diterima dari [${customerId}]: ${message}`);

    db.run(`INSERT INTO messages (customer_id, sender, text) VALUES (?, ?, ?)`, [customerId, 'customer', message], async (err) => {
      if (err) console.error("Gagal simpan pesan customer:", err);

      io.emit('admin_notification', { customerId, message, sender: 'customer' });
      io.emit('update_customer_list');

      db.get(`SELECT is_bot_active FROM sessions WHERE customer_id = ?`, [customerId], async (err, row) => {
        if (row && row.is_bot_active === 1) {
          
          sendWhatsAppNotification(customerId, message).catch(console.error);

          db.all(`SELECT sender, text FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT 10`, [customerId], async (err, rows) => {
            if (err) return;

            const chronologicalRows = (rows || []).reverse();
            const chatHistory = chronologicalRows.map(r => ({
              role: r.sender === 'customer' ? 'user' : 'model',
              parts: [{ text: r.text }]
            }));

            try {
              const botReply = await getGroqResponseWithRetry(chatHistory);
              
              db.run(`INSERT INTO messages (customer_id, sender, text) VALUES (?, ?, ?)`, [customerId, 'bot', botReply], (err) => {
                if (err) console.error("Gagal simpan balasan bot:", err);
                
                io.to(customerId).emit('chat_reply', { sender: 'bot', text: botReply });
                io.emit('admin_notification', { customerId, message: botReply, sender: 'bot' });
                io.emit('update_customer_list');
              });

            } catch (error) {
              console.error("Groq AI Error Final:", error.message);
              const errorReply = "Maaf, sistem AI kami sedang sibuk atau mengalami kendala koneksi. Silakan coba sebentar lagi.";
              
              db.run(`INSERT INTO messages (customer_id, sender, text) VALUES (?, ?, ?)`, [customerId, 'bot', errorReply]);
              io.to(customerId).emit('chat_reply', { sender: 'bot', text: errorReply });
              io.emit('admin_notification', { customerId, message: errorReply, sender: 'bot' });
              io.emit('update_customer_list');
            }
          });
        }
      });
    });
  });

  socket.on('admin_takeover', (customerId) => {
    db.run(`UPDATE sessions SET is_bot_active = 0 WHERE customer_id = ?`, [customerId]);
    io.to(customerId).emit('chat_reply', { sender: 'system', text: 'Admin manusia telah bergabung dalam percakapan.' });
    io.emit('update_customer_list');
  });

  socket.on('admin_message', (data) => {
    const { customerId, message } = data;
    if (!customerId || !message) return;

    db.run(`UPDATE sessions SET is_bot_active = 0 WHERE customer_id = ?`, [customerId]);
    db.run(`INSERT INTO messages (customer_id, sender, text) VALUES (?, ?, ?)`, [customerId, 'admin', message], () => {
      io.to(customerId).emit('chat_reply', { sender: 'admin', text: message });
      io.emit('update_customer_list');
    });
  });

  socket.on('admin_return_to_bot', (customerId) => {
    db.run(`UPDATE sessions SET is_bot_active = 1 WHERE customer_id = ?`, [customerId]);
    io.to(customerId).emit('chat_reply', { sender: 'system', text: 'Sesi dengan admin selesai. Asisten AI kembali aktif.' });
    io.emit('update_customer_list');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server berjalan sempurna di port ${PORT} menggunakan Groq AI`));
