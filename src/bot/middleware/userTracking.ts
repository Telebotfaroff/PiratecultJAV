import { Telegraf } from 'telegraf';
import { upsertUser, isUserBlocked } from '../../services/users.ts';

/** Saves user identity updates and stops blocked users before command handlers run. */
export function registerUserTrackingMiddleware(bot: Telegraf): void {
  bot.use(async (ctx, next) => {
      if (ctx.from) {
        await upsertUser({
          id: ctx.from.id,
          username: ctx.from.username,
          first_name: ctx.from.first_name,
          last_name: ctx.from.last_name,
        });
  
        const blocked = await isUserBlocked(ctx.from.id);
        if (blocked) {
          return; // Silently drop updates from blocked users
        }
      }
      return next();
    });
}
