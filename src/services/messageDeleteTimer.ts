import type { Telegraf } from 'telegraf';
import { config } from '../config.ts';
import { getSetting } from './settings.ts';
import { classifyTelegramError, withTelegramRetry } from './telegramErrors.ts';

const DELETE_TIMER_KEY = 'delete_timer_seconds';
const MAX_TIMER_SECONDS = 86400;
let cachedSeconds = 0;
let cacheExpiresAt = 0;
let cacheRefresh: Promise<number> | null = null;

async function getDeleteTimerSeconds(): Promise<number> {
  const now = Date.now();
  if (now < cacheExpiresAt) return cachedSeconds;
  if (cacheRefresh) return cacheRefresh;
  cacheRefresh = getSetting<number>(DELETE_TIMER_KEY, 0)
    .then(value => {
      const seconds = Number(value);
      cachedSeconds = Number.isFinite(seconds) ? Math.max(0, Math.min(MAX_TIMER_SECONDS, Math.floor(seconds))) : 0;
      cacheExpiresAt = Date.now() + 2000;
      return cachedSeconds;
    })
    .catch(() => { cacheExpiresAt = Date.now() + 2000; return cachedSeconds; })
    .finally(() => { cacheRefresh = null; });
  return cacheRefresh;
}

export function installMessageDeleteTimer(bot: Telegraf): void {
  const telegram = bot.telegram as any;
  if (telegram.__piratecultDeleteTimerInstalled) return;
  telegram.__piratecultDeleteTimerInstalled = true;
  const originalCallApi = telegram.callApi.bind(telegram);

  telegram.callApi = async (method: string, ...args: any[]) => {
    const result = await originalCallApi(method, ...args);
    if (method === 'deleteMessage' || method === 'deleteMessages' || method === 'answerCallbackQuery') return result;

    const chatId = args[0]?.chat_id;
    // Never delete dump-channel storage messages; the database references them.
    if (chatId === undefined || String(chatId) === String(config.dumpChatId)) return result;

    const messageIds = extractMessageIds(result);
    if (messageIds.length === 0) return result;
    const seconds = await getDeleteTimerSeconds();
    if (seconds <= 0) return result;

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
    }, seconds * 1000);
    timer.unref?.();
    return result;
  };
}

function extractMessageIds(result: any): number[] {
  if (!result) return [];
  if (Array.isArray(result)) return result.map(item => item?.message_id).filter((id): id is number => Number.isInteger(id));
  if (Number.isInteger(result.message_id)) return [result.message_id];
  return [];
}