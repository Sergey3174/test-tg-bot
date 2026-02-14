const { Pool } = require("pg");

const pool = new Pool({
  host: "localhost",
  port: 5433,
  user: "u0_a329",
  password: "1234",
  database: "botdb",
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username VARCHAR(255),
        first_name VARCHAR(255),
        game_id VARCHAR(255)
      )
    `);
    console.log("✅ Таблица users готова");
  } catch (err) {
    console.error("❌ Ошибка создания таблицы:", err.message);
  }
}

initDB();

module.exports = pool;
