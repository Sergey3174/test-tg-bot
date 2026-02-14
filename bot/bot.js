import { Telegraf, Markup } from "telegraf";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

const pool = new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT),
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
});

async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        game_id TEXT
      )
    `);
    console.log("✅ Таблица users готова");
  } catch (err) {
    console.error("Ошибка инициализации БД:", err);
  }
}

async function getUser(telegramId) {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM users WHERE telegram_id = $1",
      [telegramId],
    );
    return rows[0];
  } catch (err) {
    console.error("Ошибка getUser:", err);
    return null;
  }
}

async function createUser(ctx) {
  const { id, username, first_name } = ctx.from;
  try {
    const res = await pool.query(
      `
      INSERT INTO users (telegram_id, username, first_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (telegram_id) DO NOTHING
      RETURNING *
      `,
      [id, username, first_name],
    );
    if (res.rows.length) console.log("✅ Пользователь создан:", res.rows[0]);
  } catch (err) {
    console.error("Ошибка createUser:", err);
  }
}

async function saveGameId(telegramId, gameId) {
  try {
    await pool.query("UPDATE users SET game_id = $1 WHERE telegram_id = $2", [
      gameId,
      telegramId,
    ]);
    console.log(`✅ Game ID сохранён: ${gameId} для ${telegramId}`);
  } catch (err) {
    console.error("Ошибка saveGameId:", err);
  }
}

bot.start(async (ctx) => {
  await createUser(ctx);

  await ctx.reply(
    "🎮 Проверь свой ID в игре\n\nЕсли ты ещё не отправлял ID — нажми кнопку ниже 👇",
    Markup.inlineKeyboard([
      Markup.button.callback("✅ Проверить ID", "CHECK_GAME_ID"),
    ]),
  );
});

bot.action("CHECK_GAME_ID", async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const user = await getUser(telegramId);

    await ctx.answerCbQuery();

    if (user?.game_id) {
      return ctx.reply(
        `✅ Твой ID уже сохранён:\n🎮 ${user.game_id}`,
        Markup.inlineKeyboard([
          Markup.button.callback("✏️ Изменить ID", "EDIT_GAME_ID"),
        ]),
      );
    }

    return ctx.reply(
      "❗ Пришли свой ID из игры одним сообщением (только цифры)",
    );
  } catch (err) {
    console.error("Ошибка кнопки CHECK_GAME_ID:", err);
    return ctx.reply("⚠️ Произошла ошибка. Попробуй позже.");
  }
});

// ====== Кнопка Изменить ID ======
bot.action("EDIT_GAME_ID", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    "✏️ Введи новый ID из игры, чтобы перезаписать старый (только цифры)",
  );
});

// ====== Ввод ID ======
bot.on("text", async (ctx) => {
  try {
    const telegramId = ctx.from.id;
    const text = ctx.message.text.trim();

    // проверяем, что ID только цифры
    if (!/^\d+$/.test(text)) {
      return ctx.reply(
        "❌ ID должен состоять только из цифр. Попробуй ещё раз.",
      );
    }

    let user = await getUser(telegramId);

    if (!user) {
      await createUser(ctx);
      user = await getUser(telegramId);
    }

    await saveGameId(telegramId, text);
    return ctx.reply(
      `✅ ID сохранён!\n🎮 Твой ID: ${text}`,
      Markup.inlineKeyboard([
        Markup.button.callback("✅ Проверить ID", "CHECK_GAME_ID"),
        Markup.button.callback("✏️ Изменить ID", "EDIT_GAME_ID"),
      ]),
    );
  } catch (err) {
    console.error("Ошибка обработки текста:", err);
    return ctx.reply("⚠️ Произошла ошибка. Попробуй позже.");
  }
});

// ====== Команда /menu ======
bot.command("menu", async (ctx) => {
  try {
    await ctx.reply(
      "🎮 Проверка ID в игре:",
      Markup.inlineKeyboard([
        Markup.button.callback("✅ Проверить ID", "CHECK_GAME_ID"),
      ]),
    );
  } catch (err) {
    console.error("Ошибка команды /menu:", err);
  }
});

// ====== Запуск бота ======
(async () => {
  try {
    await initDB(); // создаём таблицу при старте
    await bot.launch();
    console.log("🤖 Bot started");
  } catch (err) {
    console.error("Ошибка запуска бота:", err);
  }
})();

function mainMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Проверить ID", "CHECK_GAME_ID")],
    [Markup.button.callback("✏️ Изменить ID", "EDIT_GAME_ID")],
    [Markup.button.callback("ℹ️ Справка", "HELP")],
  ]);
}

// Команда /menu
bot.command("menu", async (ctx) => {
  try {
    await ctx.reply("🎮 Главное меню:", mainMenu());
  } catch (err) {
    console.error("Ошибка команды /menu:", err);
  }
});

// Кнопка Справка
bot.action("HELP", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
    "ℹ️ Это бот для проверки и сохранения твоего ID в игре.\n\n" +
      "Используй кнопки меню для проверки или изменения ID.",
  );
});

// ====== Graceful stop ======
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
