import { Telegraf, Markup } from "telegraf";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const CREATOR_TELEGRAM_ID = BigInt(process.env.CREATOR_TELEGRAM_ID || "0");
const PRIVATE_CHAT_ID = process.env.PRIVATE_CHAT_ID; // ID закрытого чата

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ====== Функции для работы с БД ======
async function getUser(telegramId) {
  try {
    return await prisma.user.findUnique({
      where: { telegram_id: BigInt(telegramId) },
      include: {
        room_requests: {
          include: { room: true },
          orderBy: { created_at: "desc" },
        },
        managed_rooms: true,
      },
    });
  } catch (err) {
    console.error("Ошибка getUser:", err);
    return null;
  }
}

async function createUser(ctx) {
  const { id, username, first_name } = ctx.from;
  const isCreator = BigInt(id) === CREATOR_TELEGRAM_ID;
  try {
    const user = await prisma.user.upsert({
      where: { telegram_id: BigInt(id) },
      update: {
        username,
        first_name,
        // Обновляем роль, если пользователь является создателем
        ...(isCreator ? { role: "CREATOR" } : {}),
      },
      create: {
        telegram_id: BigInt(id),
        username,
        first_name,
        role: isCreator ? "CREATOR" : "USER",
      },
    });

    // Дополнительная проверка: если пользователь создатель, но роль не CREATOR - обновляем
    if (isCreator && user.role !== "CREATOR") {
      await prisma.user.update({
        where: { telegram_id: BigInt(id) },
        data: { role: "CREATOR" },
      });
      user.role = "CREATOR";
    }

    return user;
  } catch (err) {
    console.error("Ошибка createUser:", err);
    return null;
  }
}

async function saveGameId(telegramId, gameId) {
  try {
    await prisma.user.update({
      where: { telegram_id: BigInt(telegramId) },
      data: { game_id: gameId },
    });
    return true;
  } catch (err) {
    console.error("Ошибка saveGameId:", err);
    return false;
  }
}

async function getAllRooms() {
  try {
    return await prisma.room.findMany({
      include: {
        leader: true,
        _count: {
          select: {
            requests: {
              where: { status: "APPROVED" },
            },
          },
        },
      },
      orderBy: { created_at: "desc" },
    });
  } catch (err) {
    console.error("Ошибка getAllRooms:", err);
    return [];
  }
}

async function getRoomByGameId(gameId) {
  try {
    return await prisma.room.findUnique({
      where: { game_id: gameId },
      include: {
        leader: true,
        _count: {
          select: {
            requests: {
              where: { status: "APPROVED" },
            },
          },
        },
      },
    });
  } catch (err) {
    console.error("Ошибка getRoomByGameId:", err);
    return null;
  }
}

async function createRoomRequest(userTelegramId, roomId) {
  try {
    // Проверяем, нет ли уже активной заявки
    const existing = await prisma.roomRequest.findFirst({
      where: {
        user_telegram_id: BigInt(userTelegramId),
        room_id: roomId,
        status: "PENDING",
      },
    });
    if (existing) {
      return {
        success: false,
        message: "У тебя уже есть активная заявка на эту комнату",
      };
    }

    const request = await prisma.roomRequest.create({
      data: {
        user_telegram_id: BigInt(userTelegramId),
        room_id: roomId,
        status: "PENDING",
      },
      include: {
        room: { include: { leader: true } },
        user: true,
      },
    });
    return { success: true, request };
  } catch (err) {
    console.error("Ошибка createRoomRequest:", err);
    return { success: false, message: "Ошибка при создании заявки" };
  }
}

async function approveRoomRequest(requestId, leaderTelegramId) {
  try {
    const request = await prisma.roomRequest.findUnique({
      where: { id: requestId },
      include: { room: true },
    });

    if (!request) {
      return { success: false, message: "Заявка не найдена" };
    }

    if (request.room.leader_telegram_id !== BigInt(leaderTelegramId)) {
      return { success: false, message: "Ты не руководитель этой комнаты" };
    }

    // Проверяем лимит 60 пользователей
    const approvedCount = await prisma.roomRequest.count({
      where: {
        room_id: request.room_id,
        status: "APPROVED",
      },
    });

    if (approvedCount >= 60) {
      return {
        success: false,
        message: "В комнате уже максимум пользователей (60)",
      };
    }

    const updated = await prisma.roomRequest.update({
      where: { id: requestId },
      data: {
        status: "APPROVED",
        approved_at: new Date(),
      },
      include: {
        user: true,
        room: true,
      },
    });

    return { success: true, request: updated };
  } catch (err) {
    console.error("Ошибка approveRoomRequest:", err);
    return { success: false, message: "Ошибка при подтверждении заявки" };
  }
}

async function rejectRoomRequest(requestId, leaderTelegramId) {
  try {
    const request = await prisma.roomRequest.findUnique({
      where: { id: requestId },
      include: { room: true },
    });

    if (!request) {
      return { success: false, message: "Заявка не найдена" };
    }

    if (request.room.leader_telegram_id !== BigInt(leaderTelegramId)) {
      return { success: false, message: "Ты не руководитель этой комнаты" };
    }

    const updated = await prisma.roomRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED" },
      include: { user: true },
    });

    return { success: true, request: updated };
  } catch (err) {
    console.error("Ошибка rejectRoomRequest:", err);
    return { success: false, message: "Ошибка при отклонении заявки" };
  }
}

async function assignRoomLeader(leaderTelegramId, roomGameId) {
  try {
    const leader = await getUser(leaderTelegramId);
    if (!leader) {
      return { success: false, message: "Пользователь не найден" };
    }

    const room = await prisma.room.upsert({
      where: { game_id: roomGameId },
      update: {
        leader_telegram_id: BigInt(leaderTelegramId),
      },
      create: {
        game_id: roomGameId,
        leader_telegram_id: BigInt(leaderTelegramId),
      },
      include: { leader: true },
    });

    await prisma.user.update({
      where: { telegram_id: BigInt(leaderTelegramId) },
      data: { role: "ROOM_LEADER" },
    });

    // Преобразуем BigInt в строки для безопасной передачи
    const safeRoom = {
      ...room,
      leader_telegram_id: room.leader_telegram_id.toString(),
      leader: room.leader
        ? { ...room.leader, telegram_id: room.leader.telegram_id.toString() }
        : null,
    };

    return { success: true, room: safeRoom };
  } catch (err) {
    console.error("Ошибка assignRoomLeader:", err);
    return { success: false, message: "Ошибка при назначении руководителя" };
  }
}

// ====== Старт бота ======
bot.start(async (ctx) => {
  await createUser(ctx);
  const user = await getUser(ctx.from.id);

  let isInChat = false;

  try {
    const member = await bot.telegram.getChatMember(
      PRIVATE_CHAT_ID,
      ctx.from.id,
    );

    if (["member", "administrator", "creator"].includes(member.status)) {
      isInChat = true;
    }
  } catch (e) {
    isInChat = false;
  }

  await prisma.user.update({
    where: { telegram_id: BigInt(ctx.from.id) },
    data: { is_in_chat: isInChat },
  });

  if (!user?.game_id) {
    return ctx.reply(
      "👋 Привет! Сначала нужно ввести твой игровой ID.\n\n" +
        "Отправь свой ID из игры (только цифры):",
    );
  }

  // Пользователь уже ввёл ID - показываем информацию о комнатах
  await ctx.reply(
    `✅ Твой игровой ID: ${user.game_id}\n\nПроверяю доступные комнаты...`,
  );

  if (user.is_in_chat) {
    // Пользователь в чате - показываем выбор комнаты
    return showRoomSelection(ctx, user);
  } else {
    // Новый пользователь - показываем комнату для вступления
    return showRoomForNewUser(ctx, user);
  }
});

// Показать выбор комнаты для пользователей в чате
async function showRoomSelection(ctx, user) {
  const rooms = await getAllRooms();

  if (rooms.length === 0) {
    return ctx.reply(
      "❌ Пока нет доступных комнат.\n\n" +
        "Ожидай, когда создатель назначит руководителей комнат.",
    );
  }

  // Фильтруем только комнаты с доступными местами
  const availableRooms = rooms.filter((r) => r._count.requests < 60);

  if (availableRooms.length === 0) {
    return ctx.reply(
      "❌ Все комнаты заполнены (максимум 60 пользователей в каждой).\n\n" +
        "Попробуй позже или дождись создания новых комнат.",
    );
  }

  const buttons = availableRooms.map((room) => [
    Markup.button.callback(
      `🎮 Комната ${room.game_id} (${room._count.requests}/60)`,
      `SELECT_ROOM_${room.id}`,
    ),
  ]);

  return ctx.reply(
    `🎮 Доступные комнаты (${availableRooms.length}):\n\n` +
      `Выбери комнату, в которую хочешь вступить:`,
    Markup.inlineKeyboard(buttons),
  );
}

// Показать комнату для нового пользователя
async function showRoomForNewUser(ctx, user) {
  const rooms = await getAllRooms();

  if (rooms.length === 0) {
    return ctx.reply(
      `🎮 Твой игровой ID: ${user.game_id}\n\n` +
        `⏳ Пока нет доступных комнат.\n\n` +
        `Ожидай, когда появится комната для вступления. ` +
        `Ты получишь уведомление, когда комната будет готова.`,
    );
  }

  // Берём первую комнату с доступными местами
  const availableRoom = rooms.find((r) => r._count.requests < 60);

  if (!availableRoom) {
    return ctx.reply(
      `🎮 Твой игровой ID: ${user.game_id}\n\n` +
        `❌ Все комнаты заполнены (максимум 60 пользователей в каждой).\n\n` +
        `Попробуй позже или дождись создания новых комнат.`,
    );
  }

  return ctx.reply(
    `🎮 Твой игровой ID: ${user.game_id}\n\n` +
      `📋 Тебе нужно вступить в комнату с ID: **${availableRoom.game_id}**\n\n` +
      `После вступления в комнату нажми кнопку ниже:`,
    Markup.inlineKeyboard([
      Markup.button.callback(
        "✅ Я вступил в комнату",
        `JOINED_ROOM_${availableRoom.id}`,
      ),
    ]),
  );
}

// Обработка выбора комнаты (для пользователей в чате)
bot.action(/^SELECT_ROOM_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const roomId = ctx.match[1];
  const user = await getUser(ctx.from.id);

  if (!user?.game_id) {
    return ctx.reply("❌ Сначала введи свой игровой ID.");
  }

  if (!user.is_in_chat) {
    return ctx.reply(
      "❌ Ты не в чате. Используй команду /start для вступления.",
    );
  }

  const result = await createRoomRequest(ctx.from.id, roomId);

  if (result.success) {
    const room = result.request.room;
    const leader = room.leader;

    // --- Уведомляем лидера комнаты ---
    try {
      await bot.telegram.sendMessage(
        leader.telegram_id.toString(),
        `📥 Новая заявка на вступление в комнату ${room.game_id}\n\n` +
          `👤 Пользователь: ${user.first_name || user.username || "Без имени"}\n` +
          `🎮 Игровой ID: ${user.game_id}\n\n` +
          `Подтверди или отклони заявку:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "✅ Одобрить",
              `APPROVE_${result.request.id.toString()}`,
            ),
            Markup.button.callback(
              "❌ Отклонить",
              `REJECT_${result.request.id.toString()}`,
            ),
          ],
        ]),
      );
    } catch (err) {
      console.error("Ошибка отправки уведомления руководителю:", err);
    }

    return ctx.reply(
      `✅ Заявка на вступление отправлена!\nОжидай подтверждения от руководителя комнаты ${room.game_id}.`,
    );
  } else {
    return ctx.reply(`❌ ${result.message}`);
  }
});

// Обработка "Я вступил" (для новых пользователей)
bot.action(/^JOINED_ROOM_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const roomId = ctx.match[1];
  const user = await getUser(ctx.from.id);

  if (!user?.game_id) {
    return ctx.reply("❌ Сначала введи свой игровой ID.");
  }

  const result = await createRoomRequest(ctx.from.id, roomId);

  if (result.success) {
    const room = result.request.room;
    const leader = room.leader;

    try {
      await bot.telegram.sendMessage(
        leader.telegram_id.toString(), // 👈 ID лидера в строку
        `📥 Новая заявка на вступление в комнату ${room.game_id}\n\n` +
          `👤 Пользователь: ${user.first_name || user.username || "Без имени"}\n` +
          `🎮 Игровой ID: ${user.game_id}\n\n` +
          `Подтверди или отклони заявку:`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "✅ Одобрить",
              `APPROVE_${result.request.id.toString()}`, // 👈 конвертация BigInt
            ),
            Markup.button.callback(
              "❌ Отклонить",
              `REJECT_${result.request.id.toString()}`, // 👈 конвертация BigInt
            ),
          ],
        ]),
      );
    } catch (err) {
      console.error("Ошибка отправки уведомления руководителю:", err);
    }

    return ctx.reply(
      `✅ Заявка отправлена! Ожидай подтверждения от руководителя комнаты ${room.game_id}.\n\n` +
        `Когда заявка будет одобрена, ты получишь приглашение в закрытый чат.`,
    );
  } else {
    return ctx.reply(`❌ ${result.message}`);
  }
});

// Обработка одобрения заявки (для руководителей)
bot.action(/^APPROVE_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const requestId = ctx.match[1].toString(); // 👈 строка
  const result = await approveRoomRequest(requestId, ctx.from.id);

  if (result.success) {
    const request = result.request;

    try {
      if (PRIVATE_CHAT_ID) {
        const inviteLink = await bot.telegram.createChatInviteLink(
          PRIVATE_CHAT_ID.toString(), // 👈 строка
          {
            member_limit: 1,
            expires_at: Math.floor(Date.now() / 1000) + 86400,
          },
        );

        await bot.telegram.sendMessage(
          request.user.telegram_id.toString(), // 👈 строка
          `🎉 Твоя заявка одобрена!\n\n` +
            `Комната: ${request.room.game_id}\n` +
            `Приглашение в закрытый чат:`,
          Markup.inlineKeyboard([
            Markup.button.url("🔗 Вступить в чат", inviteLink.invite_link),
          ]),
        );

        await prisma.user.update({
          where: { telegram_id: request.user.telegram_id.toString() }, // 👈 строка
          data: { is_in_chat: true },
        });
      } else {
        await bot.telegram.sendMessage(
          request.user.telegram_id.toString(),
          `🎉 Твоя заявка одобрена!\n\n` +
            `Комната: ${request.room.game_id}\n` +
            `Ожидай приглашения в закрытый чат.`,
        );
      }
    } catch (err) {
      console.error("Ошибка отправки приглашения:", err);
    }

    return ctx.reply(
      `✅ Заявка одобрена! Пользователю отправлено приглашение.`,
    );
  } else {
    return ctx.reply(`❌ ${result.message}`);
  }
});

// Обработка отклонения заявки (для руководителей)
bot.action(/^REJECT_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const requestId = ctx.match[1].toString(); // 👈 строка
  const result = await rejectRoomRequest(requestId, ctx.from.id);

  if (result.success) {
    // Уведомляем пользователя
    try {
      await bot.telegram.sendMessage(
        result.request.user.telegram_id.toString(), // 👈 строка
        `❌ Твоя заявка на вступление в комнату отклонена.`,
      );
    } catch (err) {
      console.error("Ошибка отправки уведомления:", err);
    }

    return ctx.reply(`❌ Заявка отклонена.`);
  } else {
    return ctx.reply(`❌ ${result.message}`);
  }
});

// Меню для создателя
bot.command("admin", async (ctx) => {
  const user = await getUser(ctx.from.id);

  if (!user || user.role !== "CREATOR") {
    return ctx.reply("❌ У тебя нет прав для выполнения этой команды.");
  }

  return ctx.reply(
    "👑 Панель администратора\n\n" +
      "📋 Доступные команды:\n\n" +
      "• /assign_leader - Выбрать руководителя из пользователей чата\n" +
      "• /rooms - Просмотр всех комнат\n" +
      "• /stats - Статистика системы\n" +
      "• /users - Список пользователей\n" +
      "• /help_admin - Подробная справка",
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "⭐ Назначить руководителя",
          "ADMIN_ASSIGN_LEADER",
        ),
      ],
      [Markup.button.callback("📊 Статистика", "ADMIN_STATS")],
      [Markup.button.callback("🏠 Все комнаты", "ADMIN_ROOMS")],
      [Markup.button.callback("👥 Пользователи", "ADMIN_USERS")],
    ]),
  );
});

// Команда для выбора руководителя из пользователей чата
bot.command("assign_leader", async (ctx) => {
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав для выполнения этой команды.\n\n" +
        "Используй /update_role для обновления роли.",
    );
  }

  // Получаем пользователей из чата, у которых есть игровой ID
  try {
    const chatUsers = await prisma.user.findMany({
      where: {
        is_in_chat: true,
        game_id: { not: null },
        role: { not: "CREATOR" }, // Исключаем создателя
      },
      orderBy: { first_name: "asc" },
    });

    if (chatUsers.length === 0) {
      return ctx.reply(
        "❌ Нет пользователей в чате с указанным игровым ID.\n\n" +
          "Пользователи должны:\n" +
          "1. Быть в закрытом чате\n" +
          "2. Иметь сохранённый игровой ID",
      );
    }

    // Показываем список пользователей для выбора
    const buttons = chatUsers.map((u) => {
      const isLeader = u.role === "ROOM_LEADER";
      const emoji = isLeader ? "⭐" : "👤";
      return [
        Markup.button.callback(
          `${emoji} ${u.first_name || u.username || "Без имени"} (ID: ${u.game_id})${isLeader ? " [Уже руководитель]" : ""}`,
          `SELECT_LEADER_${u.telegram_id}`,
        ),
      ];
    });

    return ctx.reply(
      "👥 Выбери пользователя для назначения руководителем комнаты:\n\n" +
        "💡 Номер комнаты будет автоматически установлен как игровой ID выбранного пользователя.",
      Markup.inlineKeyboard(buttons),
    );
  } catch (err) {
    console.error("Ошибка получения пользователей:", err);
    return ctx.reply("❌ Ошибка при получении списка пользователей.");
  }
});

// Обработка выбора руководителя
bot.action(/^SELECT_LEADER_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const leaderTelegramId = ctx.match[1];
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply("❌ У тебя нет прав для выполнения этой команды.");
  }

  // Получаем информацию о выбранном пользователе
  const leader = await getUser(leaderTelegramId);

  if (!leader) {
    return ctx.reply("❌ Пользователь не найден.");
  }

  if (!leader.game_id) {
    return ctx.reply(
      "❌ У этого пользователя не указан игровой ID.\n\n" +
        "Попроси пользователя ввести свой игровой ID через бота.",
    );
  }

  // Используем игровой ID как номер комнаты
  const roomGameId = leader.game_id;

  const result = await assignRoomLeader(leaderTelegramId, roomGameId);

  if (result.success) {
    // Уведомляем нового руководителя
    try {
      await bot.telegram.sendMessage(
        result.room.leader_telegram_id.toString(),
        `🎉 Тебя назначили руководителем комнаты ${roomGameId}!\n\n` +
          `Твой игровой ID (${roomGameId}) используется как номер комнаты.\n\n` +
          `Теперь ты можешь одобрять заявки на вступление в эту комнату.\n` +
          `Используй команду /requests для просмотра заявок.`,
      );
    } catch (err) {
      console.error("Ошибка отправки уведомления:", err);
    }

    return ctx.reply(
      `✅ Пользователь ${leader.first_name || leader.username || "Без имени"} назначен руководителем комнаты ${roomGameId}.\n\n` +
        `Номер комнаты: ${roomGameId} (игровой ID пользователя)\n` +
        `Руководитель получил уведомление.`,
    );
  } else {
    return ctx.reply(`❌ ${result.message}`);
  }
});

// Старая команда для ручного назначения (оставляем для совместимости)
bot.command("assign_leader_manual", async (ctx) => {
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав для выполнения этой команды.\n\n" +
        "Используй /update_role для обновления роли.",
    );
  }

  const args = ctx.message.text.split(" ").slice(1);
  if (args.length < 2) {
    return ctx.reply(
      "📝 Использование: /assign_leader_manual <telegram_id> <room_game_id>\n\n" +
        "Пример: /assign_leader_manual 123456789 987654321\n\n" +
        "💡 <telegram_id> - Telegram ID пользователя\n" +
        "💡 <room_game_id> - Игровой ID комнаты (будет использован как название комнаты)\n\n" +
        "💡 Рекомендуется использовать /assign_leader для выбора из списка пользователей чата.",
    );
  }

  const [leaderTelegramId, roomGameId] = args;

  if (!/^\d+$/.test(leaderTelegramId) || !/^\d+$/.test(roomGameId)) {
    return ctx.reply("❌ ID должны состоять только из цифр.");
  }

  const result = await assignRoomLeader(leaderTelegramId, roomGameId);

  if (result.success) {
    // Уведомляем нового руководителя
    try {
      await bot.telegram.sendMessage(
        BigInt(leaderTelegramId),
        `🎉 Тебя назначили руководителем комнаты ${roomGameId}!\n\n` +
          `Теперь ты можешь одобрять заявки на вступление в эту комнату.\n` +
          `Используй команду /requests для просмотра заявок.`,
      );
    } catch (err) {
      console.error("Ошибка отправки уведомления:", err);
    }

    return ctx.reply(
      `✅ Пользователь ${leaderTelegramId} назначен руководителем комнаты ${roomGameId}.\n\n` +
        `Руководитель получил уведомление.`,
    );
  } else {
    return ctx.reply(`❌ ${result.message}`);
  }
});

// Команда для просмотра всех комнат (для создателя)
bot.command("rooms", async (ctx) => {
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав для выполнения этой команды.\n\nИспользуй /update_role для обновления роли.",
    );
  }

  const rooms = await getAllRooms();

  if (rooms.length === 0) {
    return ctx.reply("❌ Пока нет созданных комнат.");
  }

  let message = "🏠 Все комнаты:\n\n";

  for (const room of rooms) {
    const approvedCount = room._count.requests || 0;
    const pendingCount = await prisma.roomRequest.count({
      where: {
        room_id: room.id,
        status: "PENDING",
      },
    });

    message += `🎮 Комната: ${room.game_id}\n`;
    message += `   👤 Руководитель: ${room.leader.first_name || room.leader.username || "Без имени"}\n`;
    message += `   ✅ Одобрено: ${approvedCount}/60\n`;
    message += `   ⏳ Ожидает: ${pendingCount}\n\n`;
  }

  return ctx.reply(message);
});

// Команда для статистики (для создателя)
bot.command("stats", async (ctx) => {
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав для выполнения этой команды.\n\nИспользуй /update_role для обновления роли.",
    );
  }

  try {
    const totalUsers = await prisma.user.count();
    const usersInChat = await prisma.user.count({
      where: { is_in_chat: true },
    });
    const totalRooms = await prisma.room.count();
    const totalLeaders = await prisma.user.count({
      where: { role: "ROOM_LEADER" },
    });
    const totalRequests = await prisma.roomRequest.count();
    const pendingRequests = await prisma.roomRequest.count({
      where: { status: "PENDING" },
    });
    const approvedRequests = await prisma.roomRequest.count({
      where: { status: "APPROVED" },
    });

    return ctx.reply(
      "📊 Статистика системы:\n\n" +
        `👥 Всего пользователей: ${totalUsers}\n` +
        `✅ В чате: ${usersInChat}\n` +
        `🏠 Комнат: ${totalRooms}\n` +
        `👑 Руководителей: ${totalLeaders}\n` +
        `📝 Всего заявок: ${totalRequests}\n` +
        `⏳ Ожидают: ${pendingRequests}\n` +
        `✅ Одобрено: ${approvedRequests}`,
    );
  } catch (err) {
    console.error("Ошибка получения статистики:", err);
    return ctx.reply("❌ Ошибка при получении статистики.");
  }
});

// Команда для просмотра пользователей (для создателя)
bot.command("users", async (ctx) => {
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав для выполнения этой команды.\n\nИспользуй /update_role для обновления роли.",
    );
  }

  try {
    const users = await prisma.user.findMany({
      take: 50,
      orderBy: { created_at: "desc" },
      include: {
        _count: {
          select: { room_requests: true },
        },
      },
    });

    if (users.length === 0) {
      return ctx.reply("❌ Пока нет пользователей.");
    }

    let message = `👥 Пользователи (показано ${users.length}):\n\n`;

    for (const u of users) {
      const roleEmoji =
        u.role === "CREATOR" ? "👑" : u.role === "ROOM_LEADER" ? "⭐" : "👤";
      const inChatEmoji = u.is_in_chat ? "✅" : "❌";
      message += `${roleEmoji} ${u.first_name || u.username || "Без имени"}\n`;
      message += `   ID: ${u.telegram_id}\n`;
      message += `   Игровой ID: ${u.game_id || "не указан"}\n`;
      message += `   В чате: ${inChatEmoji}\n`;
      message += `   Заявок: ${u._count.room_requests}\n\n`;
    }

    return ctx.reply(message);
  } catch (err) {
    console.error("Ошибка получения пользователей:", err);
    return ctx.reply("❌ Ошибка при получении списка пользователей.");
  }
});

// Справка для администратора
bot.command("help_admin", async (ctx) => {
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав для выполнения этой команды.\n\nИспользуй /update_role для обновления роли.",
    );
  }

  return ctx.reply(
    "📖 Справка для администратора:\n\n" +
      "🔹 /admin - Панель администратора\n\n" +
      "🔹 /assign_leader - Выбрать руководителя из пользователей чата\n" +
      "   Показывает список пользователей из закрытого чата с игровыми ID.\n" +
      "   Номер комнаты автоматически устанавливается как игровой ID выбранного пользователя.\n\n" +
      "🔹 /assign_leader_manual <telegram_id> <room_game_id> - Ручное назначение\n" +
      "   Пример: /assign_leader_manual 123456789 987654321\n\n" +
      "🔹 /rooms - Просмотр всех комнат и их статуса\n" +
      "🔹 /stats - Статистика системы\n" +
      "🔹 /users - Список пользователей (первые 50)\n\n" +
      "💡 После назначения руководителя комната создаётся автоматически.\n" +
      "💡 Название комнаты = игровой ID руководителя.\n" +
      "💡 Рекомендуется использовать /assign_leader для удобного выбора из списка.",
  );
});

// Команда для просмотра заявок (для руководителей)
bot.command("requests", async (ctx) => {
  const user = await getUser(ctx.from.id);

  if (!user || user.role !== "ROOM_LEADER") {
    return ctx.reply(
      "❌ Только руководители комнат могут просматривать заявки.",
    );
  }

  const rooms = await prisma.room.findMany({
    where: { leader_telegram_id: BigInt(ctx.from.id) },
    include: {
      requests: {
        where: { status: "PENDING" },
        include: { user: true },
        orderBy: { created_at: "desc" },
      },
    },
  });

  if (rooms.length === 0) {
    return ctx.reply("❌ У тебя нет комнат для управления.");
  }

  let message = "📋 Заявки на вступление:\n\n";

  for (const room of rooms) {
    if (room.requests.length === 0) {
      message += `🎮 Комната ${room.game_id}: нет заявок\n\n`;
      continue;
    }

    message += `🎮 Комната ${room.game_id}:\n`;
    for (const request of room.requests) {
      message +=
        `  • ${request.user.first_name || request.user.username || "Без имени"} ` +
        `(ID: ${request.user.game_id})\n`;
    }
    message += "\n";
  }

  return ctx.reply(message);
});

// Команда для получения ID чата
bot.command("chat_id", async (ctx) => {
  try {
    const chatId = ctx.chat.id;
    const chatType = ctx.chat.type;
    const chatTitle =
      ctx.chat.title ||
      ctx.chat.first_name ||
      ctx.chat.username ||
      "Личные сообщения";

    console.log(`Chat ID запрошен: ${chatId}, тип: ${chatType}`);

    await ctx.reply(
      `📋 Информация о чате:\n\n` +
        `🆔 ID чата: ${chatId}\n` +
        `📝 Тип: ${chatType === "private" ? "Личные сообщения" : chatType === "group" ? "Группа" : chatType === "supergroup" ? "Супергруппа" : "Канал"}\n` +
        `📌 Название: ${chatTitle}\n\n` +
        `💡 Скопируй ID и добавь в .env файл как:\n` +
        `PRIVATE_CHAT_ID=${chatId}`,
    );
  } catch (err) {
    console.error("Ошибка команды chat_id:", err);
    await ctx.reply("❌ Ошибка при получении ID чата");
  }
});

// Обработчик кнопки назначения руководителя
bot.action("ADMIN_ASSIGN_LEADER", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав.\n\nИспользуй /update_role для обновления роли.",
    );
  }

  // Получаем пользователей из чата, у которых есть игровой ID
  try {
    const chatUsers = await prisma.user.findMany({
      where: {
        is_in_chat: true,
        game_id: { not: null },
        role: { not: "CREATOR" },
      },
      orderBy: { first_name: "asc" },
    });

    if (chatUsers.length === 0) {
      return ctx.reply(
        "❌ Нет пользователей в чате с указанным игровым ID.\n\n" +
          "Пользователи должны:\n" +
          "1. Быть в закрытом чате\n" +
          "2. Иметь сохранённый игровой ID",
      );
    }

    // Показываем список пользователей для выбора
    const buttons = chatUsers.map((u) => {
      const isLeader = u.role === "ROOM_LEADER";
      const emoji = isLeader ? "⭐" : "👤";
      return [
        Markup.button.callback(
          `${emoji} ${u.first_name || u.username || "Без имени"} (ID: ${u.game_id})${isLeader ? " [Уже руководитель]" : ""}`,
          `SELECT_LEADER_${u.telegram_id}`,
        ),
      ];
    });

    return ctx.reply(
      "👥 Выбери пользователя для назначения руководителем комнаты:\n\n" +
        "💡 Номер комнаты будет автоматически установлен как игровой ID выбранного пользователя.",
      Markup.inlineKeyboard(buttons),
    );
  } catch (err) {
    console.error("Ошибка получения пользователей:", err);
    return ctx.reply("❌ Ошибка при получении списка пользователей.");
  }
});

// Обработчики кнопок администратора
bot.action("ADMIN_STATS", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав.\n\nИспользуй /update_role для обновления роли.",
    );
  }

  try {
    const totalUsers = await prisma.user.count();
    const usersInChat = await prisma.user.count({
      where: { is_in_chat: true },
    });
    const totalRooms = await prisma.room.count();
    const totalLeaders = await prisma.user.count({
      where: { role: "ROOM_LEADER" },
    });
    const totalRequests = await prisma.roomRequest.count();
    const pendingRequests = await prisma.roomRequest.count({
      where: { status: "PENDING" },
    });
    const approvedRequests = await prisma.roomRequest.count({
      where: { status: "APPROVED" },
    });

    return ctx.reply(
      "📊 Статистика системы:\n\n" +
        `👥 Всего пользователей: ${totalUsers}\n` +
        `✅ В чате: ${usersInChat}\n` +
        `🏠 Комнат: ${totalRooms}\n` +
        `👑 Руководителей: ${totalLeaders}\n` +
        `📝 Всего заявок: ${totalRequests}\n` +
        `⏳ Ожидают: ${pendingRequests}\n` +
        `✅ Одобрено: ${approvedRequests}`,
    );
  } catch (err) {
    console.error("Ошибка получения статистики:", err);
    return ctx.reply("❌ Ошибка при получении статистики.");
  }
});

bot.action("ADMIN_ROOMS", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав.\n\nИспользуй /update_role для обновления роли.",
    );
  }

  const rooms = await getAllRooms();

  if (rooms.length === 0) {
    return ctx.reply("❌ Пока нет созданных комнат.");
  }

  let message = "🏠 Все комнаты:\n\n";

  for (const room of rooms) {
    const approvedCount = room._count.requests || 0;
    const pendingCount = await prisma.roomRequest.count({
      where: {
        room_id: room.id,
        status: "PENDING",
      },
    });

    message += `🎮 Комната: ${room.game_id}\n`;
    message += `   👤 Руководитель: ${room.leader.first_name || room.leader.username || "Без имени"}\n`;
    message += `   ✅ Одобрено: ${approvedCount}/60\n`;
    message += `   ⏳ Ожидает: ${pendingCount}\n\n`;
  }

  return ctx.reply(message);
});

bot.action("ADMIN_USERS", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав.\n\nИспользуй /update_role для обновления роли.",
    );
  }

  try {
    const users = await prisma.user.findMany({
      take: 50,
      orderBy: { created_at: "desc" },
      include: {
        _count: {
          select: { room_requests: true },
        },
      },
    });

    if (users.length === 0) {
      return ctx.reply("❌ Пока нет пользователей.");
    }

    let message = `👥 Пользователи (показано ${users.length}):\n\n`;

    for (const u of users) {
      const roleEmoji =
        u.role === "CREATOR" ? "👑" : u.role === "ROOM_LEADER" ? "⭐" : "👤";
      const inChatEmoji = u.is_in_chat ? "✅" : "❌";
      message += `${roleEmoji} ${u.first_name || u.username || "Без имени"}\n`;
      message += `   ID: ${u.telegram_id}\n`;
      message += `   Игровой ID: ${u.game_id || "не указан"}\n`;
      message += `   В чате: ${inChatEmoji}\n`;
      message += `   Заявок: ${u._count.room_requests}\n\n`;
    }

    return ctx.reply(message);
  } catch (err) {
    console.error("Ошибка получения пользователей:", err);
    return ctx.reply("❌ Ошибка при получении списка пользователей.");
  }
});

// Альтернативный способ получения ID - просто отправить любое сообщение в чат
// bot.on("message", async (ctx) => {
//   // Если это команда /get_chat_id (альтернатива)
//   if (ctx.message.text === "/get_chat_id" || ctx.message.text === "!chat_id") {
//     try {
//       const chatId = ctx.chat.id;
//       await ctx.reply(
//         `🆔 ID этого чата: ${chatId}\n\n` +
//           `Добавь в .env:\nPRIVATE_CHAT_ID=${chatId}`,
//       );
//     } catch (err) {
//       console.error("Ошибка:", err);
//     }
//     return;
//   }
// });

// Обработка ввода игрового ID
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;
  // Пропускаем команды
  if (ctx.message.text.startsWith("/")) return;

  try {
    const telegramId = ctx.from.id;
    const text = ctx.message.text.trim();

    if (!/^\d+$/.test(text)) {
      return ctx.reply(
        "❌ ID должен состоять только из цифр. Попробуй ещё раз.",
      );
    }

    let user = await getUser(telegramId);
    if (!user) {
      user = await createUser(ctx);
    }

    if (!user) return ctx.reply("❌ Ошибка при создании пользователя.");

    // =========================
    // Проверка существующей заявки
    // =========================
    const existingRequest = await prisma.roomRequest.findFirst({
      where: {
        user_telegram_id: BigInt(telegramId),
        status: { in: ["PENDING", "APPROVED"] },
      },
    });

    if (existingRequest) {
      return ctx.reply(
        `❌ У тебя уже "активная заявка". Ввод нового ID невозможен.`,
      );
    }
    // =========================

    const saved = await saveGameId(telegramId, text);
    if (!saved)
      return ctx.reply("❌ Ошибка при сохранении ID. Попробуй ещё раз.");

    user = await getUser(telegramId);
    if (!user) return ctx.reply("❌ Ошибка при получении данных пользователя.");

    // После сохранения ID показываем информацию о комнатах
    await ctx.reply(
      `✅ Твой игровой ID сохранён: ${text}\n\nПроверяю доступные комнаты...`,
    );

    if (user.is_in_chat) {
      return showRoomSelection(ctx, user);
    } else {
      return showRoomForNewUser(ctx, user);
    }
  } catch (err) {
    console.error("Ошибка обработки текста:", err);
    return ctx.reply("⚠️ Произошла ошибка. Попробуй позже.");
  }
});

// Инициализация таблиц
async function initTables() {
  try {
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE "UserRole" AS ENUM ('CREATOR', 'ROOM_LEADER', 'USER');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
    await pool.query(`
      DO $$ BEGIN
        CREATE TYPE "RoomRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);
  } catch (err) {
    console.error("Ошибка создания типов:", err.message);
  }

  // Создаём или обновляем таблицу User
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "User" (
        telegram_id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        game_id VARCHAR(255),
        role "UserRole" DEFAULT 'USER',
        "is_in_chat" BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Добавляем недостающие колонки, если таблица уже существовала
    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='User' AND column_name='role') THEN
          ALTER TABLE "User" ADD COLUMN role "UserRole" DEFAULT 'USER';
        END IF;
      END $$;
    `);

    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='User' AND column_name='is_in_chat') THEN
          ALTER TABLE "User" ADD COLUMN "is_in_chat" BOOLEAN DEFAULT false;
        END IF;
      END $$;
    `);

    await pool.query(`
      DO $$ 
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='User' AND column_name='created_at') THEN
          ALTER TABLE "User" ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
        END IF;
      END $$;
    `);
  } catch (err) {
    console.error("Ошибка создания/обновления таблицы User:", err.message);
  }

  // Создаём таблицу Room
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "Room" (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        game_id VARCHAR(255) UNIQUE NOT NULL,
        leader_telegram_id BIGINT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (leader_telegram_id) REFERENCES "User"(telegram_id) ON DELETE CASCADE
      );
    `);
  } catch (err) {
    console.error("Ошибка создания таблицы Room:", err.message);
  }

  // Создаём таблицу RoomRequest
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "RoomRequest" (
        id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_telegram_id BIGINT NOT NULL,
        room_id TEXT NOT NULL,
        status "RoomRequestStatus" DEFAULT 'PENDING',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        approved_at TIMESTAMP,
        FOREIGN KEY (user_telegram_id) REFERENCES "User"(telegram_id) ON DELETE CASCADE,
        FOREIGN KEY (room_id) REFERENCES "Room"(id) ON DELETE CASCADE
      );
    `);
    console.log("✅ Таблицы инициализированы");
  } catch (err) {
    console.error("Ошибка создания таблицы RoomRequest:", err.message);
  }
}

// ====== Запуск бота ======
(async () => {
  try {
    await initTables();
    await bot.launch();
    console.log("🤖 Bot started with Prisma");
  } catch (err) {
    console.error("Ошибка запуска бота:", err);
  }
})();

// Корректное завершение работы
process.once("SIGINT", async () => {
  await bot.stop("SIGINT");
  await prisma.$disconnect();
  process.exit(0);
});
process.once("SIGTERM", async () => {
  await bot.stop("SIGTERM");
  await prisma.$disconnect();
  process.exit(0);
});
