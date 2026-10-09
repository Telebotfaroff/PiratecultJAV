import { Telegraf } from 'telegraf';
import { classifyTelegramError } from '../../services/telegramErrors.ts';

/** Installs one global handler for Telegram update errors. */
export function registerTelegramErrorHandler(bot: Telegraf): void {
  bot.catch((err: unknown, ctx) => {
    const info = classifyTelegramError(err);

    if (info.kind === 'not_modified') return;

    console.error(
      `[TelegramBot] ${info.kind} on update #${ctx?.update?.update_id || 'unknown'}:`,
      info.message,
    );

    if (info.kind === 'blocked' || info.kind === 'not_found' || info.kind === 'invalid_chat') {
      return;
    }

    try {
      void ctx.reply('⚠️ Telegram request failed. Please try again.').catch(() => {});
    } catch {
      // Ignore secondary reply failures.
    }
  });
}
