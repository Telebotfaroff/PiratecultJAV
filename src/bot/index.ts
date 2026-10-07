import { Telegraf, Markup } from 'telegraf';
import { config, isAdmin } from '../config.ts';
import { normalizeCode, extractCodes } from '../services/code.ts';
import { searchVideos, getVideoById, upsertVideoFromProvider, countVideos } from '../services/videos.ts';
import { createIndexJob, countJobs } from '../services/indexJobs.ts';
import { upsertUser, isUserBlocked, setUserBlocked, countUsers, getBroadcastUserIds } from '../services/users.ts';
import { checkUserForceSub } from '../services/forceSub.ts';
import { getAdminSession, setAdminSession, clearAdminSession } from '../services/adminSessions.ts';
import { javtifulProvider } from '../providers/javtiful/index.ts';
import { sendDumpVideoToUser, storeThumbnailInDumpChannel } from '../services/dump.ts';
import { installMessageDeleteTimer } from '../services/messageDeleteTimer.ts';
import { getSetting, setSetting } from '../services/settings.ts';

let botInstance: Telegraf | null = null;
let isPollingActive = false;

export function getBot(): Telegraf | null {
  if (botInstance) return botInstance;

  if (!config.botToken) {
    return null;
  }

  const bot = new Telegraf(config.botToken);

  // Automatically delete bot-created messages according to the admin-configured timer.
  // Dump-channel storage messages are excluded so indexed videos remain available.
  installMessageDeleteTimer(bot);

  // Global error handler to catch and report errors gracefully
  bot.catch((err: unknown, ctx) => {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TelegramBot] Handled bot error for update #${ctx?.update?.update_id || 'unknown'}:`, errMsg);
    try {
      ctx.reply(`⚠️ An error occurred: ${errMsg}`).catch(() => {});
    } catch {
      // Ignore reply errors
    }
  });

  // 1. User tracking & blocked filter middleware
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

  // 2. Start command
  bot.command('start', async (ctx) => {
    const welcome = `👋 *Welcome to PiratecultJAV Bot*\n\nSend any JAV code (e.g. \`ADN-001\`, \`STAR-765\`, \`JUR-270\`) or keyword to search the catalog.\n\nType your code below:`;
    return ctx.replyWithMarkdown(welcome);
  });

  // 3. Cancel command
  bot.command('cancel', async (ctx) => {
    if (ctx.from) {
      await clearAdminSession(ctx.from.id);
    }
    return ctx.reply('Current operation canceled.');
  });

  // 4. Admin stats command
  bot.command('stats', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.reply('Unauthorized: Admin access required.');
    }

    const [userCount, videoCount, jobsCount] = await Promise.all([
      countUsers(),
      countVideos(),
      countJobs(),
    ]);

    const msg = [
      `📊 *PiratecultJAV Statistics*`,
      `\n👥 *Users:* \`${userCount}\``,
      `🎬 *Cataloged Videos:* \`${videoCount}\``,
      `\n⚙️ *Index Jobs Queue:*`,
      `• Queued: \`${jobsCount.queued}\``,
      `• Processing: \`${jobsCount.processing}\``,
      `• Completed: \`${jobsCount.completed}\``,
      `• Failed: \`${jobsCount.failed}\``,
      `• Total: \`${jobsCount.total}\``,
    ].join('\n');

    return ctx.replyWithMarkdown(msg);
  });

  // 5. Admin /post workflow
  bot.command('post', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.reply('Unauthorized: Admin access required.');
    }

    await setAdminSession(ctx.from.id, 'post', 'awaiting_code');
    return ctx.reply('📝 *Admin Post:* Please enter the JAV code to post (e.g. `ADN-001`):', {
      parse_mode: 'Markdown',
    });
  });

  // 6. Admin user blocking commands
  bot.command('block', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.reply('Unauthorized.');
    }

    const parts = ctx.message.text.split(' ');
    const targetId = parseInt(parts[1], 10);
    if (!targetId || isNaN(targetId)) {
      return ctx.reply('Usage: /block <telegram_user_id>');
    }

    await setUserBlocked(targetId, true);
    return ctx.reply(`User ${targetId} has been blocked.`);
  });

  bot.command('unblock', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) {
      return ctx.reply('Unauthorized.');
    }

    const parts = ctx.message.text.split(' ');
    const targetId = parseInt(parts[1], 10);
    if (!targetId || isNaN(targetId)) {
      return ctx.reply('Usage: /unblock <telegram_user_id>');
    }

    await setUserBlocked(targetId, false);
    return ctx.reply(`User ${targetId} has been unblocked.`);
  });

  // 7. Admin broadcast command (web dashboard is the primary UI)
  bot.command('broadcast', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    const text = ctx.message.text.replace(/^\\/broadcast\\s*/i, '').trim();
    if (!text) return ctx.reply('Usage: /broadcast <message>');
    const userIds = await getBroadcastUserIds();
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < userIds.length; i += 25) {
      const batch = userIds.slice(i, i + 25);
      await Promise.all(batch.map(async (userId) => {
        try { await bot.telegram.sendMessage(userId, text); sent++; }
        catch { failed++; }
      }));
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    return ctx.reply(`📣 Broadcast finished.\\n\\n✅ Sent: ${sent}\\n❌ Failed: ${failed}`);
  });

  // Admin command center
  bot.command('settings', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    return showAdminSettings(ctx);
  });

  bot.action('settings:main', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return showAdminSettings(ctx);
  });

  bot.action('settings:delete_timer', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const seconds = await getSetting<number>('delete_timer_seconds', 0);
    return ctx.editMessageText('🗑️ *Auto-delete Timer*\n\nCurrent: *' + formatTimer(seconds) + '*\n\nChoose a timer:', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('⏱ 10 seconds', 'settings:timer:10'), Markup.button.callback('⏱ 30 seconds', 'settings:timer:30')],
        [Markup.button.callback('⏱ 1 minute', 'settings:timer:60'), Markup.button.callback('⏱ 5 minutes', 'settings:timer:300')],
        [Markup.button.callback('⏱ 10 minutes', 'settings:timer:600'), Markup.button.callback('⏱ 30 minutes', 'settings:timer:1800')],
        [Markup.button.callback('⏱ 1 hour', 'settings:timer:3600'), Markup.button.callback('⏱ 24 hours', 'settings:timer:86400')],
        [Markup.button.callback('🔴 OFF', 'settings:timer:0')],
        [Markup.button.callback('⬅️ Back', 'settings:main')],
      ]),
    });
  });

  bot.action(/^settings:timer:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const seconds = Number.parseInt(ctx.match[1], 10);
    await setSetting('delete_timer_seconds', seconds);
    await ctx.answerCbQuery(seconds > 0 ? 'Timer updated.' : 'Timer disabled.');
    return showAdminSettings(ctx);
  });

  bot.action('settings:broadcast', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return ctx.editMessageText('📣 *Broadcast*\n\nUse the web dashboard for the full broadcast composer, or use /broadcast followed by your message.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings:main')]]),
    });
  });

  bot.action('settings:forcesub', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const enabled = await getSetting<boolean>('force_sub_enabled', false);
    return ctx.editMessageText('🔒 *Force Subscribe*\n\nStatus: *' + (enabled ? 'ENABLED' : 'DISABLED') + '*\n\nUse the web dashboard to manage channels and request mode.', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(enabled ? '🔴 Disable' : '🟢 Enable', 'settings:forcesub:toggle')],
        [Markup.button.callback('⬅️ Back', 'settings:main')],
      ]),
    });
  });

  bot.action('settings:forcesub:toggle', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const current = await getSetting<boolean>('force_sub_enabled', false);
    await setSetting('force_sub_enabled', !current);
    await ctx.answerCbQuery(!current ? 'Force-sub enabled.' : 'Force-sub disabled.');
    return showAdminSettings(ctx);
  });

  bot.action('settings:maintenance', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const enabled = await getSetting<boolean>('maintenance_mode', false);
    return ctx.editMessageText('🛠️ *Maintenance Mode*\n\nStatus: *' + (enabled ? 'ENABLED' : 'DISABLED') + '*', {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback(enabled ? '🟢 Turn Off' : '🔴 Turn On', 'settings:maintenance:toggle')],
        [Markup.button.callback('⬅️ Back', 'settings:main')],
      ]),
    });
  });

  bot.action('settings:maintenance:toggle', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const current = await getSetting<boolean>('maintenance_mode', false);
    await setSetting('maintenance_mode', !current);
    await ctx.answerCbQuery(!current ? 'Maintenance mode enabled.' : 'Maintenance mode disabled.');
    return showAdminSettings(ctx);
  });

  bot.action('settings:stats', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const [userCount, videoCount, jobs] = await Promise.all([countUsers(), countVideos(), countJobs()]);
    return ctx.editMessageText('📊 *Statistics*\n\n👥 Users: *' + userCount + '*\n🎬 Videos: *' + videoCount + '*\n\n⚙️ Jobs\n• Queued: ' + jobs.queued + '\n• Processing: ' + jobs.processing + '\n• Completed: ' + jobs.completed + '\n• Failed: ' + jobs.failed + '\n• Total: ' + jobs.total, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'settings:stats')], [Markup.button.callback('⬅️ Back', 'settings:main')]]),
    });
  });

  bot.action('settings:system', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const deleteTimer = await getSetting<number>('delete_timer_seconds', 0);
    const forceSub = await getSetting<boolean>('force_sub_enabled', false);
    const maintenance = await getSetting<boolean>('maintenance_mode', false);
    return ctx.editMessageText('🔧 *System Settings*\n\n🗑️ Delete timer: ' + formatTimer(deleteTimer) + '\n🔒 Force-sub: ' + (forceSub ? 'ON' : 'OFF') + '\n🛠️ Maintenance: ' + (maintenance ? 'ON' : 'OFF'), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'settings:main')]]),
    });
  });

  bot.action('settings:close', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return ctx.deleteMessage().catch(() => undefined);
  });
  // 8. Video download callback query
  bot.action(/^download:(.+)$/, async (ctx) => {
    const videoId = ctx.match[1];
    await ctx.answerCbQuery('Fetching video...');

    // Verify force-sub before delivering
    if (ctx.from) {
      const forceSub = await checkUserForceSub(bot, ctx.from.id);
      if (!forceSub.passed) {
        const buttons: any[] = forceSub.missingChannels.map(ch =>
          Markup.button.url(`Join ${ch.title}`, ch.invite_link || `https://t.me/${ch.channel_id.replace('@', '')}`)
        );
        buttons.push(Markup.button.callback('🔄 Check Membership', `download:${videoId}`));
        return ctx.reply(
          '⚠️ Please join our channels to download videos:',
          Markup.inlineKeyboard(buttons.map(b => [b]))
        );
      }
    }

    const video = await getVideoById(videoId);
    if (!video) {
      return ctx.reply('Sorry, this video record was not found.');
    }

    if (video.status !== 'available') {
      return ctx.reply(`This video is currently marked as ${video.status}.`);
    }

    try {
      await sendDumpVideoToUser(
        bot,
        ctx.chat!.id,
        video.dump_chat_id,
        video.video_message_id,
        `🎬 *${video.code}* - ${video.title}`
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return ctx.reply(`Failed retrieving video from storage: ${errMsg}`);
    }
  });

  // 9. Force-sub membership recheck
  bot.action('check_sub', async (ctx) => {
    await ctx.answerCbQuery('Checking membership...');
    if (!ctx.from) return;

    const forceSub = await checkUserForceSub(bot, ctx.from.id);
    if (forceSub.passed) {
      return ctx.reply('✅ Membership verified. You can now search for videos.');
    }

    const buttons: any[] = forceSub.missingChannels.map(ch =>
      Markup.button.url(
        ch.request_mode ? `📨 Request to Join ${ch.title}` : `Join ${ch.title}`,
        ch.invite_link || `https://t.me/${ch.channel_id.replace('@', '')}`
      )
    );
    buttons.push(Markup.button.callback('🔄 Check Again', 'check_sub'));

    return ctx.reply(
      '⚠️ You still need to join the required channel(s).',
      Markup.inlineKeyboard(buttons.map(b => [b]))
    );
  });

  // 10. Pagination callback query for search results
  bot.action(/^search:(.+):(\d+)$/, async (ctx) => {
    const query = ctx.match[1];
    const page = parseInt(ctx.match[2], 10) || 0;
    await ctx.answerCbQuery();

    await handleSearchQuery(ctx, query, page);
  });

  // 11. Dump Channel listener for automated indexing
  bot.on('channel_post', async (ctx) => {
    const post = ctx.channelPost;
    const chatId = String(ctx.chat.id);

    // Only process dump channel or configured channels
    if (config.dumpChatId && chatId !== config.dumpChatId) {
      return;
    }

    // Must be a media item (video, document, animation)
    const hasMedia = 'video' in post || 'document' in post || 'animation' in post;
    const caption = ('caption' in post ? post.caption : ('text' in post ? post.text : '')) || '';

    if (!hasMedia || !caption) {
      return;
    }

    // Extract JAV codes
    const codes = extractCodes(caption);
    if (codes.length === 0) {
      return;
    }

    const primaryCode = codes[0];
    const messageId = post.message_id;

    console.log(`[DumpPost] Detected media message #${messageId} with code ${primaryCode}`);

    // Create index job with strict duplicate prevention
    const result = await createIndexJob({
      code: primaryCode,
      dumpChatId: chatId,
      videoMessageId: messageId,
    });

    if (result.created) {
      console.log(`[DumpPost] Successfully queued index job #${result.job.id} for ${primaryCode}`);
    } else {
      console.log(`[DumpPost] Skipped duplicate media: ${result.reason}`);
    }
  });

  // 12. Admin session handler for incoming text/video
  bot.on('message', async (ctx, next) => {
    if (!ctx.from || !isAdmin(ctx.from.id)) {
      return next();
    }

    const session = await getAdminSession(ctx.from.id);
    if (!session || session.action !== 'post') {
      return next();
    }

    // Step 1: Admin entered code
    if (session.step === 'awaiting_code' && 'text' in ctx.message) {
      const code = normalizeCode(ctx.message.text);
      if (!code) {
        return ctx.reply('Invalid JAV code format. Please try again or use /cancel.');
      }

      await ctx.reply(`🔍 Fetching metadata from Javtiful for \`${code}\`...`, { parse_mode: 'Markdown' });

      try {
        const metadata = await javtifulProvider.getMetadata(code);
        await setAdminSession(ctx.from.id, 'post', 'awaiting_video', { code, metadata });

        const preview = [
          `✅ *Metadata Found:*`,
          `\n*Code:* \`${metadata.code}\``,
          `*Title:* ${metadata.title}`,
          `*Actresses:* ${metadata.actresses.join(', ') || 'N/A'}`,
          `*Duration:* ${metadata.duration || 'N/A'}`,
          `*Date:* ${metadata.date || 'N/A'}`,
          `\n📤 *Now please send or forward the video file:*`,
        ].join('\n');

        return ctx.replyWithMarkdown(preview);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return ctx.reply(`⚠️ Could not fetch metadata: ${errMsg}\nEnter another code or /cancel.`);
      }
    }

    // Step 2: Admin sent video file
    if (session.step === 'awaiting_video') {
      const msg = ctx.message;
      const isVideo = 'video' in msg || 'document' in msg;

      if (!isVideo) {
        return ctx.reply('Please send a video or document file, or type /cancel.');
      }

      const { code, metadata } = session.payload as { code: string; metadata: any };
      await ctx.reply('⏳ Uploading / Copying video to Telegram Dump Channel...');

      try {
        // Forward video to dump channel
        const forwarded = await ctx.telegram.copyMessage(config.dumpChatId, ctx.chat.id, msg.message_id, {
          caption: `${code} - ${metadata.title}`,
        });

        const dumpVideoMessageId = forwarded.message_id;

        // Optionally send thumbnail to dump channel
        let thumbRef = null;
        if (metadata.thumbnailUrl) {
          thumbRef = await storeThumbnailInDumpChannel(bot, metadata.thumbnailUrl, code);
        }

        // Upsert into Supabase videos
        await upsertVideoFromProvider({
          code,
          dump_chat_id: config.dumpChatId,
          video_message_id: dumpVideoMessageId,
          metadata,
          thumbnail_message_id: thumbRef?.messageId,
          thumbnail_file_id: thumbRef?.fileId,
          status: 'available',
        });

        await clearAdminSession(ctx.from.id);

        return ctx.replyWithMarkdown(
          `🎉 *Success!* Video \`${code}\` has been published and linked to Dump Channel message \`#${dumpVideoMessageId}\`.`
        );
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return ctx.reply(`❌ Failed to post video: ${errMsg}`);
      }
    }

    return next();
  });

  // 13. Generic text search handler
  bot.on('text', async (ctx) => {
    // Check force-sub for normal users
    if (ctx.from) {
      const forceSub = await checkUserForceSub(bot, ctx.from.id);
      if (!forceSub.passed) {
        const buttons: any[] = forceSub.missingChannels.map(ch =>
          Markup.button.url(`Join ${ch.title}`, ch.invite_link || `https://t.me/${ch.channel_id.replace('@', '')}`)
        );
        buttons.push(Markup.button.callback('✅ Check Membership', 'check_sub'));
        return ctx.reply(
          '⚠️ You must join our channel(s) before searching:',
          Markup.inlineKeyboard(buttons.map(b => [b]))
        );
      }
    }

    await handleSearchQuery(ctx, ctx.message.text, 0);
  });

  botInstance = bot;
  return botInstance;
}

async function handleSearchQuery(ctx: any, rawQuery: string, page = 0) {
  const pageSize = 5;
  const offset = page * pageSize;

  try {
    const { videos, total } = await searchVideos(rawQuery, pageSize, offset);

    if (videos.length === 0) {
      return ctx.reply(`No videos found for "${rawQuery}". Try another code or keyword.`);
    }

    const totalPages = Math.ceil(total / pageSize);

    // Format list of results
    let text = `🔍 *Search Results for* \`${rawQuery}\` (${total} found - Page ${page + 1}/${totalPages}):\n\n`;

    const keyboardButtons: any[] = [];

    videos.forEach((v, idx) => {
      const actresses = Array.isArray(v.metadata?.actresses) ? v.metadata.actresses.join(', ') : '';
      text += `*${offset + idx + 1}.* \`${v.code}\` — ${v.title.slice(0, 50)}${v.title.length > 50 ? '...' : ''}\n`;
      if (actresses) {
        text += `   _Actresses: ${actresses.slice(0, 40)}_\n`;
      }
      text += `\n`;

      keyboardButtons.push([Markup.button.callback(`📥 Download ${v.code}`, `download:${v.id}`)]);
    });

    // Pagination row
    const navRow: any[] = [];
    if (page > 0) {
      navRow.push(Markup.button.callback('⬅️ Previous', `search:${rawQuery}:${page - 1}`));
    }
    if (page + 1 < totalPages) {
      navRow.push(Markup.button.callback('Next ➡️', `search:${rawQuery}:${page + 1}`));
    }

    if (navRow.length > 0) {
      keyboardButtons.push(navRow);
    }

    return ctx.replyWithMarkdown(text, Markup.inlineKeyboard(keyboardButtons));
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return ctx.reply(`Search error: ${errMsg}`);
  }
}

async function showAdminSettings(ctx: any) {
  const [users, videos, jobs, deleteTimer, forceSub, maintenance] = await Promise.all([
    countUsers(), countVideos(), countJobs(),
    getSetting<number>('delete_timer_seconds', 0),
    getSetting<boolean>('force_sub_enabled', false),
    getSetting<boolean>('maintenance_mode', false),
  ]);
  const text = [
    '⚙️ *PIRATECULTJAV ADMIN*', '',
    '👥 Users: *' + users + '*',
    '🎬 Videos: *' + videos + '*',
    '🟢 Bot: *Online*', '',
    '🗑️ Auto Delete: *' + formatTimer(deleteTimer) + '*',
    '🔒 Force Sub: *' + (forceSub ? 'ON' : 'OFF') + '*',
    '🛠️ Maintenance: *' + (maintenance ? 'ON' : 'OFF') + '*', '',
    '⚙️ Jobs: *' + jobs.queued + ' queued*',
  ].join('\n');
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📣 Broadcast', 'settings:broadcast'), Markup.button.callback('🗑️ Delete Timer', 'settings:delete_timer')],
    [Markup.button.callback('🔒 Force Sub', 'settings:forcesub'), Markup.button.callback('🛠️ Maintenance', 'settings:maintenance')],
    [Markup.button.callback('📊 Statistics', 'settings:stats'), Markup.button.callback('🔧 System', 'settings:system')],
    [Markup.button.callback('❌ Close', 'settings:close')],
  ]);
  if (ctx.callbackQuery) return ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
  return ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
}
function formatTimer(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'OFF';
  if (seconds % 86400 === 0) return seconds / 86400 + ' day(s)';
  if (seconds % 3600 === 0) return seconds / 3600 + ' hour(s)';
  if (seconds % 60 === 0) return seconds / 60 + ' minute(s)';
  return seconds + ' second(s)';
}

/**
 * Starts Telegram bot polling safely ensuring only one instance runs.
 */
export async function startBotPolling(): Promise<boolean> {
  const bot = getBot();
  if (!bot) {
    console.log('[TelegramBot] BOT_TOKEN not set. Polling not started.');
    return false;
  }

  if (isPollingActive) {
    console.log('[TelegramBot] Polling already active.');
    return true;
  }

  try {
    console.log('[TelegramBot] Launching bot polling...');
    bot.launch({
      dropPendingUpdates: true,
    }).catch(err => {
      console.error('[TelegramBot] Polling error:', err.message);
      isPollingActive = false;
    });

    isPollingActive = true;
    console.log('[TelegramBot] Bot polling started successfully.');
    return true;
  } catch (err: unknown) {
    console.error('[TelegramBot] Failed to launch bot:', err);
    isPollingActive = false;
    return false;
  }
}

export function stopBotPolling(): void {
  if (botInstance && isPollingActive) {
    try {
      botInstance.stop('Stopping bot instance');
    } catch {
      // Ignore
    }
    isPollingActive = false;
    console.log('[TelegramBot] Bot polling stopped.');
  }
}

export function isBotActive(): boolean {
  return isPollingActive;
}
