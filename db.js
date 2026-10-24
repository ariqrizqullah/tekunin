const Database = require('better-sqlite3');

// Menggunakan database in-memory atau membuat fallback otomatis yang aman di memori/temporary
let db;
try {
  // Coba buat file database di direktori saat ini
  db = new Database('./chat_history.db');
  console.log('Berhasil terhubung ke database file lokal.');
} catch (err) {
  console.warn('Peringatan: Gagal akses file disk, beralih ke SQLite In-Memory database.');
  db = new Database(':memory:');
}

// Inisialisasi Tabel
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    customer_id TEXT PRIMARY KEY, 
    is_bot_active BOOLEAN DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT,
    sender TEXT,
    text TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Wrapper agar kompatibel dengan syntax callback lama (db.run, db.get, db.all)
db.run = function (sql, params = [], callback) {
  try {
    const stmt = db.prepare(sql);
    const info = stmt.run(params);
    if (typeof callback === 'function') callback.call(info, null);
  } catch (err) {
    if (typeof callback === 'function') callback(err);
  }
};

db.get = function (sql, params = [], callback) {
  try {
    const stmt = db.prepare(sql);
    const row = stmt.get(params);
    if (typeof callback === 'function') callback(null, row);
  } catch (err) {
    if (typeof callback === 'function') callback(err, null);
  }
};

db.all = function (sql, params = [], callback) {
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all(params);
    if (typeof callback === 'function') callback(null, rows);
  } catch (err) {
    if (typeof callback === 'function') callback(err, null);
  }
};

module.exports = db;
