import { Telegraf, Markup } from "telegraf";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import dotenv from "dotenv";

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);
const CREATOR_TELEGRAM_ID = BigInt(process.env.CREATOR_TELEGRAM_ID || "0");
const PRIVATE_CHAT_ID = process.env.PRIVATE_CHAT_ID;

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
        ...(isCreator ? { role: "CREATOR" } : {}),
      },
      create: {
        telegram_id: BigInt(id),
        username,
        first_name,
        role: isCreator ? "CREATOR" : "USER",
      },
    });

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

// ====== Функции для администраторов группы ======
async function isGroupAdmin(userId) {
  if (!PRIVATE_CHAT_ID) {
    console.log("⚠️ PRIVATE_CHAT_ID не настроен в .env файле");
    return false;
  }

  try {
    const member = await bot.telegram.getChatMember(PRIVATE_CHAT_ID, userId);
    console.log(`Проверка администратора ${userId}: статус = ${member.status}`);
    return ["administrator", "creator"].includes(member.status);
  } catch (err) {
    console.error("Ошибка проверки администратора:", err.message);
    return false;
  }
}

async function getGroupRequests() {
  try {
    return await prisma.roomRequest.findMany({
      where: {
        status: { in: ["PENDING", "APPROVED"] },
      },
      include: {
        user: true,
        room: {
          include: {
            leader: true,
          },
        },
      },
      orderBy: { created_at: "desc" },
    });
  } catch (err) {
    console.error("Ошибка получения заявок группы:", err);
    return [];
  }
}

async function adminRejectRequest(requestId) {
  try {
    const request = await prisma.roomRequest.findUnique({
      where: { id: requestId },
      include: { room: true, user: true },
    });

    if (!request) {
      return { success: false, message: "Заявка не найдена" };
    }

    const updated = await prisma.roomRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED" },
      include: { user: true, room: true },
    });

    return { success: true, request: updated };
  } catch (err) {
    console.error("Ошибка adminRejectRequest:", err);
    return { success: false, message: "Ошибка при отклонении заявки" };
  }
}

// Функция для исключения одобренного пользователя (для руководителей комнат)
async function removeApprovedUser(requestId, leaderTelegramId) {
  try {
    const request = await prisma.roomRequest.findUnique({
      where: { id: requestId },
      include: { room: true, user: true },
    });

    if (!request) {
      return { success: false, message: "Заявка не найдена" };
    }

    if (request.room.leader_telegram_id !== BigInt(leaderTelegramId)) {
      return { success: false, message: "Ты не руководитель этой комнаты" };
    }

    if (request.status !== "APPROVED") {
      return {
        success: false,
        message: "Можно исключить только одобренных пользователей",
      };
    }

    const updated = await prisma.roomRequest.update({
      where: { id: requestId },
      data: { status: "REJECTED" },
      include: { user: true, room: true },
    });

    return { success: true, request: updated };
  } catch (err) {
    console.error("Ошибка removeApprovedUser:", err);
    return { success: false, message: "Ошибка при исключении пользователя" };
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

  await ctx.reply(
    `✅ Твой игровой ID: ${user.game_id}\n\nПроверяю доступные комнаты...`,
  );

  if (user.is_in_chat) {
    return showRoomSelection(ctx, user);
  } else {
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

// Обработка выбора комнаты
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

    try {
      await bot.telegram.sendMessage(
        leader.telegram_id.toString(),
        `🔥 Новая заявка на вступление в комнату ${room.game_id}\n\n` +
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

// Обработка "Я вступил"
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
        leader.telegram_id.toString(),
        `🔥 Новая заявка на вступление в комнату ${room.game_id}\n\n` +
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
      `✅ Заявка отправлена! Ожидай подтверждения от руководителя комнаты ${room.game_id}.\n\n` +
        `Когда заявка будет одобрена, ты получишь приглашение в закрытый чат.`,
    );
  } else {
    return ctx.reply(`❌ ${result.message}`);
  }
});

// Обработка одобрения заявки
bot.action(/^APPROVE_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const requestId = ctx.match[1].toString();
  const result = await approveRoomRequest(requestId, ctx.from.id);

  if (result.success) {
    const request = result.request;

    try {
      if (PRIVATE_CHAT_ID) {
        const inviteLink = await bot.telegram.createChatInviteLink(
          PRIVATE_CHAT_ID.toString(),
          {
            member_limit: 1,
            expires_at: Math.floor(Date.now() / 1000) + 86400,
          },
        );

        await bot.telegram.sendMessage(
          request.user.telegram_id.toString(),
          `🎉 Твоя заявка одобрена!\n\n` +
            `Комната: ${request.room.game_id}\n` +
            `Приглашение в закрытый чат:`,
          Markup.inlineKeyboard([
            Markup.button.url("🔗 Вступить в чат", inviteLink.invite_link),
          ]),
        );

        await prisma.user.update({
          where: { telegram_id: request.user.telegram_id.toString() },
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

// Обработка отклонения заявки
bot.action(/^REJECT_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const requestId = ctx.match[1].toString();
  const result = await rejectRoomRequest(requestId, ctx.from.id);

  if (result.success) {
    try {
      await bot.telegram.sendMessage(
        result.request.user.telegram_id.toString(),
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

// Обработка исключения одобренного пользователя
bot.action(/^REMOVE_APPROVED_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const requestId = ctx.match[1].toString();
  const result = await removeApprovedUser(requestId, ctx.from.id);

  if (result.success) {
    const request = result.request;

    // Уведомляем пользователя об исключении
    try {
      await bot.telegram.sendMessage(
        request.user.telegram_id.toString(),
        `❌ Тебя исключили из комнаты ${request.room.game_id}.\n\n` +
          `Руководитель комнаты отменил твоё одобрение.`,
      );
    } catch (err) {
      console.error("Ошибка отправки уведомления:", err);
    }

    return ctx.editMessageText(
      `✅ Пользователь ${request.user.first_name || request.user.username || "Без имени"} ` +
        `исключён из комнаты ${request.room.game_id}.\n\n` +
        `Используй /requests для просмотра остальных заявок.`,
    );
  } else {
    return ctx.reply(`❌ ${result.message}`);
  }
});

// ====== Команды для администраторов группы ======
bot.command("group_requests", async (ctx) => {
  console.log(`Команда /group_requests вызвана пользователем ${ctx.from.id}`);
  console.log(`PRIVATE_CHAT_ID = ${PRIVATE_CHAT_ID || "не установлен"}`);

  const isAdmin = await isGroupAdmin(ctx.from.id);

  if (!isAdmin) {
    if (!PRIVATE_CHAT_ID) {
      return ctx.reply(
        "⚠️ Функционал администраторов группы не настроен.\n\n" +
          "Администратору бота нужно:\n" +
          "1. Добавить бота в группу\n" +
          "2. Выполнить команду /chat_id в группе\n" +
          "3. Добавить полученный ID в .env файл как PRIVATE_CHAT_ID\n" +
          "4. Перезапустить бота",
      );
    }

    return ctx.reply(
      "❌ Эта команда доступна только администраторам группы.\n\n" +
        "Убедись, что:\n" +
        "1. Ты администратор в группе с ID: " +
        PRIVATE_CHAT_ID +
        "\n" +
        "2. Бот добавлен в эту группу\n" +
        "3. Ты вызываешь команду в личных сообщениях с ботом",
    );
  }

  const requests = await getGroupRequests();

  if (requests.length === 0) {
    return ctx.reply("📋 Нет активных заявок в группе.");
  }

  // Группируем заявки по статусу
  const pending = requests.filter((r) => r.status === "PENDING");
  const approved = requests.filter((r) => r.status === "APPROVED");

  let message = `📋 Заявки в группе:\n\n`;

  if (pending.length > 0) {
    message += `⏳ Ожидают одобрения (${pending.length}):\n`;
    for (const req of pending.slice(0, 10)) {
      message +=
        `  • ${req.user.first_name || req.user.username || "Без имени"} ` +
        `(ID: ${req.user.game_id}) → Комната ${req.room.game_id}\n`;
    }
    if (pending.length > 10) {
      message += `  ... и ещё ${pending.length - 10}\n`;
    }
    message += "\n";
  }

  if (approved.length > 0) {
    message += `✅ Одобренные (${approved.length}):\n`;
    for (const req of approved.slice(0, 10)) {
      message +=
        `  • ${req.user.first_name || req.user.username || "Без имени"} ` +
        `(ID: ${req.user.game_id}) → Комната ${req.room.game_id}\n`;
    }
    if (approved.length > 10) {
      message += `  ... и ещё ${approved.length - 10}\n`;
    }
  }

  // Добавляем кнопки для управления заявками
  if (pending.length > 0) {
    const buttons = pending
      .slice(0, 5)
      .map((req) => [
        Markup.button.callback(
          `❌ Отклонить: ${req.user.first_name || req.user.username || "Без имени"} (${req.room.game_id})`,
          `ADMIN_REJECT_${req.id}`,
        ),
      ]);

    return ctx.reply(message, Markup.inlineKeyboard(buttons));
  }

  return ctx.reply(message);
});

// Обработка отклонения заявки администратором
bot.action(/^ADMIN_REJECT_(.+)$/, async (ctx) => {
  const isAdmin = await isGroupAdmin(ctx.from.id);

  if (!isAdmin) {
    await ctx.answerCbQuery("❌ Только для администраторов группы");
    return;
  }

  await ctx.answerCbQuery();
  const requestId = ctx.match[1].toString();
  const result = await adminRejectRequest(requestId);

  if (result.success) {
    const request = result.request;

    // Уведомляем пользователя
    try {
      await bot.telegram.sendMessage(
        request.user.telegram_id.toString(),
        `❌ Твоя заявка на вступление в комнату ${request.room.game_id} отклонена администратором группы.`,
      );
    } catch (err) {
      console.error("Ошибка отправки уведомления:", err);
    }

    // Уведомляем руководителя комнаты
    try {
      await bot.telegram.sendMessage(
        request.room.leader_telegram_id.toString(),
        `ℹ️ Администратор группы отклонил заявку пользователя ${request.user.first_name || request.user.username || "Без имени"} (ID: ${request.user.game_id}) на вступление в комнату ${request.room.game_id}.`,
      );
    } catch (err) {
      console.error("Ошибка отправки уведомления руководителю:", err);
    }

    return ctx.editMessageText(
      `✅ Заявка пользователя ${request.user.first_name || request.user.username || "Без имени"} отклонена.\n\n` +
        `Используй /group_requests для просмотра остальных заявок.`,
    );
  } else {
    return ctx.reply(`❌ ${result.message}`);
  }
});

// Команда помощи для администраторов
bot.command("group_admin_help", async (ctx) => {
  console.log(`Команда /group_admin_help вызвана пользователем ${ctx.from.id}`);

  const isAdmin = await isGroupAdmin(ctx.from.id);

  if (!isAdmin) {
    if (!PRIVATE_CHAT_ID) {
      return ctx.reply(
        "⚠️ Функционал администраторов группы не настроен.\n\n" +
          "Обратись к администратору бота для настройки.",
      );
    }

    return ctx.reply("❌ Эта команда доступна только администраторам группы.");
  }

  return ctx.reply(
    "📖 Команды для администраторов группы:\n\n" +
      "🔹 /group_requests - Просмотр всех заявок в группе\n" +
      "   Показывает список ожидающих и одобренных заявок\n" +
      "   Позволяет отклонить заявку одним нажатием\n\n" +
      "🔹 /group_admin_help - Эта справка\n\n" +
      "💡 Как администратор группы, ты можешь:\n" +
      "• Просматривать все заявки на вступление\n" +
      "• Отклонять заявки пользователей\n" +
      "• Контролировать состав участников\n\n" +
      "ℹ️ Отклонённые заявки:\n" +
      "• Пользователь получит уведомление об отклонении\n" +
      "• Руководитель комнаты также будет уведомлён\n" +
      "• Пользователь сможет подать новую заявку",
  );
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

  const roomGameId = leader.game_id;
  const result = await assignRoomLeader(leaderTelegramId, roomGameId);

  if (result.success) {
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

// Команда для просмотра всех комнат
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

// Команда для статистики
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

// Команда для просмотра пользователей
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
      "🔹 /rooms - Просмотр всех комнат и их статуса\n" +
      "🔹 /stats - Статистика системы\n" +
      "🔹 /users - Список пользователей (первые 50)\n\n" +
      "💡 После назначения руководителя комната создаётся автоматически.\n" +
      "💡 Название комнаты = игровой ID руководителя.",
  );
});

// Справка для руководителей комнат
bot.command("help_leader", async (ctx) => {
  const user = await getUser(ctx.from.id);

  if (!user || user.role !== "ROOM_LEADER") {
    return ctx.reply("❌ Эта команда доступна только руководителям комнат.");
  }

  return ctx.reply(
    "📖 Справка для руководителя комнаты:\n\n" +
      "🔹 /requests - Просмотр всех заявок в твоих комнатах\n" +
      "   Показывает:\n" +
      "   • ⏳ Ожидающие одобрения заявки\n" +
      "   • ✅ Уже одобренные пользователи\n\n" +
      "💡 Что ты можешь делать:\n" +
      "• Одобрить ожидающую заявку (кнопка ✅)\n" +
      "• Отклонить ожидающую заявку (кнопка ❌)\n" +
      "• Исключить одобренного пользователя (кнопка ❌)\n\n" +
      "ℹ️ При исключении:\n" +
      "• Пользователь получит уведомление\n" +
      "• Заявка будет помечена как отклонённая\n" +
      "• Пользователь сможет подать новую заявку",
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
        where: { status: { in: ["PENDING", "APPROVED"] } },
        include: { user: true },
        orderBy: { created_at: "desc" },
      },
    },
  });

  if (rooms.length === 0) {
    return ctx.reply("❌ У тебя нет комнат для управления.");
  }

  let hasPending = false;
  let hasApproved = false;
  let message = "📋 Заявки на вступление:\n\n";

  for (const room of rooms) {
    if (room.requests.length === 0) {
      message += `🎮 Комната ${room.game_id}: нет заявок\n\n`;
      continue;
    }

    const pending = room.requests.filter((r) => r.status === "PENDING");
    const approved = room.requests.filter((r) => r.status === "APPROVED");

    message += `🎮 Комната ${room.game_id}:\n`;

    if (pending.length > 0) {
      hasPending = true;
      message += `\n⏳ Ожидают одобрения (${pending.length}):\n`;
      for (const request of pending) {
        message +=
          `  • ${request.user.first_name || request.user.username || "Без имени"} ` +
          `(ID: ${request.user.game_id})\n`;
      }
    }

    if (approved.length > 0) {
      hasApproved = true;
      message += `\n✅ Одобренные (${approved.length}):\n`;
      for (const request of approved) {
        message +=
          `  • ${request.user.first_name || request.user.username || "Без имени"} ` +
          `(ID: ${request.user.game_id})\n`;
      }
    }

    message += "\n";
  }

  // Создаем кнопки для управления заявками
  const buttons = [];

  for (const room of rooms) {
    const pending = room.requests.filter((r) => r.status === "PENDING");
    const approved = room.requests.filter((r) => r.status === "APPROVED");

    // Кнопки для одобрения ожидающих заявок
    for (const request of pending.slice(0, 3)) {
      buttons.push([
        Markup.button.callback(
          `✅ Одобрить: ${request.user.first_name || request.user.username} (${room.game_id})`,
          `APPROVE_${request.id}`,
        ),
      ]);
    }

    // Кнопки для отклонения/исключения одобренных заявок
    for (const request of approved.slice(0, 3)) {
      buttons.push([
        Markup.button.callback(
          `❌ Исключить: ${request.user.first_name || request.user.username} (${room.game_id})`,
          `REMOVE_APPROVED_${request.id}`,
        ),
      ]);
    }
  }

  if (buttons.length > 0) {
    return ctx.reply(message, Markup.inlineKeyboard(buttons));
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

// Обработчики кнопок администратора
bot.action("ADMIN_ASSIGN_LEADER", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await getUser(ctx.from.id);
  const isCreator = BigInt(ctx.from.id) === CREATOR_TELEGRAM_ID;

  if (!isCreator && (!user || user.role !== "CREATOR")) {
    return ctx.reply(
      "❌ У тебя нет прав.\n\nИспользуй /update_role для обновления роли.",
    );
  }

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

// Обработка ввода игрового ID
bot.on("message", async (ctx) => {
  if (ctx.chat.type !== "private") return;
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

    const existingRequest = await prisma.roomRequest.findFirst({
      where: {
        user_telegram_id: BigInt(telegramId),
        status: { in: ["PENDING", "APPROVED"] },
      },
    });

    if (existingRequest) {
      return ctx.reply(
        `❌ У тебя уже активная заявка. Ввод нового ID невозможен.`,
      );
    }

    const saved = await saveGameId(telegramId, text);
    if (!saved)
      return ctx.reply("❌ Ошибка при сохранении ID. Попробуй ещё раз.");

    user = await getUser(telegramId);
    if (!user) return ctx.reply("❌ Ошибка при получении данных пользователя.");

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
        CREATE TYPE "UserRole" AS ENUM ('CREATOR', 'ROOM_LEADER', 'ADMIN', 'USER');
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
    console.log("🤖 Bot started with Prisma and Group Admin features");
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
