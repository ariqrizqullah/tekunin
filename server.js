require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { GoogleGenAI } = require('@google/genai');
const cors = require('cors'); 
const db = require('./db');

const app = express();
app.use(cors()); 
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Inisialisasi Gemini AI
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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

// Fungsi Panggil AI dengan Sistem Auto-Retry (Anti 503 & 404 Error)
async function getGeminiResponseWithRetry(chatHistory, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await ai.models.generateContent({
          // PENTING: Menggunakan model yang sudah terbukti kompatibel dengan API Anda
          model: 'gemini-3.8-flash', 
          contents: chatHistory,
          config: { 
            systemInstruction: "Kamu adalah asisten Customer Service e-commerce yang ramah, sopan, dan membantu dalam bahasa Indonesia." 
          }
      });
      return response.text;
    } catch (error) {
      if (error.status === 503 && i < retries - 1) {
        console.log(`[Peringatan] Server Google sibuk (503). Mencoba ulang dalam ${delayMs/1000} detik... (Percobaan ${i+1} dari ${retries})`);
        await new Promise(resolve => setTimeout(resolve, delayMs)); // Tunggu sebelum coba lagi
      } else {
        throw error; // Lempar error jika bukan 503 atau jatah retry habis
      }
    }
  }
}

// REST API Admin
app.get('/api/customers', (req, res) => {
  const query = `
    SELECT s.customer_id, s.is_bot_active,
      (SELECT text FROM messages WHERE customer_id = s.customer_id ORDER BY id DESC LIMIT 1) AS last_message,
      (SELECT created_at FROM messages WHERE customer_id = s.customer_id ORDER BY id DESC LIMIT 1) AS last_time
    FROM sessions s ORDER BY last_time DESC
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, customers: rows || [] });
  });
});

app.get('/api/chat-history/:customerId', (req, res) => {
  const { customerId } = req.params;
  db.all(`SELECT sender, text, created_at FROM messages WHERE customer_id = ? ORDER BY id ASC`, [customerId], (err, rows) => {
    if (err) return res.status(500).json({ success: false });
    res.json({ success: true, customerId, messages: rows || [] });
  });
});

// Socket.io Real-time
io.on('connection', (socket) => {
  console.log('Client terhubung:', socket.id);

  socket.on('customer_join', (customerId) => {
    socket.join(customerId);
    db.run(`INSERT OR IGNORE INTO sessions (customer_id, is_bot_active) VALUES (?, 1)`, [customerId]);
  });

  socket.on('customer_message', async (data) => {
    const { customerId, message } = data;
    if (!customerId || !message) return;

    db.run(`INSERT INTO messages (customer_id, sender, text) VALUES (?, ?, ?)`, [customerId, 'customer', message]);
    
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
            // Gunakan fungsi Auto-Retry
            const botReply = await getGeminiResponseWithRetry(chatHistory);
            
            db.run(`INSERT INTO messages (customer_id, sender, text) VALUES (?, ?, ?)`, [customerId, 'bot', botReply]);
            
            io.to(customerId).emit('chat_reply', { sender: 'bot', text: botReply });
            io.emit('admin_notification', { customerId, message: botReply, sender: 'bot' });
            io.emit('update_customer_list');
          } catch (error) {
            console.error("Gemini AI Error Final:", error);
            const errorReply = "Maaf, sistem AI kami sedang sangat sibuk saat ini. Mohon tunggu sebentar lalu coba kirim pesan lagi.";
            io.to(customerId).emit('chat_reply', { sender: 'bot', text: errorReply });
          }
        });
      }
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
    db.run(`INSERT INTO messages (customer_id, sender, text) VALUES (?, ?, ?)`, [customerId, 'admin', message]);
    
    io.to(customerId).emit('chat_reply', { sender: 'admin', text: message });
    io.emit('update_customer_list');
  });

  socket.on('admin_return_to_bot', (customerId) => {
    db.run(`UPDATE sessions SET is_bot_active = 1 WHERE customer_id = ?`, [customerId]);
    io.to(customerId).emit('chat_reply', { sender: 'system', text: 'Sesi dengan admin selesai. Asisten AI kembali aktif.' });
    io.emit('update_customer_list');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server berjalan sempurna di port ${PORT}`));