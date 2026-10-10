import type { Telegraf } from 'telegraf';
import { config } from '../config.ts';
import { classifyTelegramError, withTelegramRetry } from './telegramErrors.ts';

const DELETE_AFTER_SECONDS = 60;

export function installMessageDeleteTimer(bot: Telegraf): void {
  const telegram = bot.telegram as any;
  if (telegram.__piratecultDeleteTimerInstalled) return;
  telegram.__piratecultDeleteTimerInstalled = true;
  const originalCallApi = telegram.callApi.bind(telegram);

  telegram.callApi = async (method: string, ...args: any[]) => {
    const result = await originalCallApi(method, ...args);
    if (method === 'deleteMessage' || method === 'deleteMessages' || method === 'answerCallbackQuery') return result;

    const chatId = args[0]?.chat_id;
    // Only auto-delete messages sent to private user chats. Group, channel, and
    // dump-channel messages must remain untouched so stored media references survive.
    if (chatId === undefined || Number(chatId) <= 0 || String(chatId) === String(config.dumpChatId)) {
      return result;
    }

    const messageIds = extractMessageIds(result);
    if (messageIds.length === 0) return result;

    const timer = setTimeout(() => {
      void Promise.allSettled(messageIds.map(async messageId => {
        try {
          await withTelegramRetry(
            () => originalCallApi('deleteMessage', { chat_id: chatId, message_id: messageId }),
            { maxRetries: 1, label: `delete:${chatId}:${messageId}` },
          );
        } catch (error) {
          const info = classifyTelegramError(error);
          // Deleted/already-missing messages are expected and should stay silent.
          if (info.kind !== 'not_found') {
            console.warn(`[Telegram] auto-delete ${info.kind} for ${chatId}:${messageId}: ${info.message}`);
          }
        }
      }));
    }, DELETE_AFTER_SECONDS * 1000);
    timer.unref?.();
    return result;
  };
}

function extractMessageIds(result: any): number[] {
  if (!result) return [];
  if (Array.isArray(result)) {
    return result.map(item => item?.message_id).filter((id): id is number => Number.isInteger(id));
  }
  if (Number.isInteger(result.message_id)) return [result.message_id];
  return [];
}
