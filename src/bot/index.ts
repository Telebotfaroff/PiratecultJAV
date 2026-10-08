import { Telegraf, Markup } from 'telegraf';
import { config, isAdmin } from '../config.ts';
import { normalizeCode, extractCodes, cleanActressList, cleanTitle } from '../services/code.ts';
import { searchVideos, getVideoById, getVideoByCode, upsertVideoFromProvider, countVideos, updateVideoMetadata, deleteVideo, updateVideoStatus } from '../services/videos.ts';
import { createIndexJob, countJobs, getRecentJobs, retryJob } from '../services/indexJobs.ts';
import { upsertUser, isUserBlocked, setUserBlocked, countUsers, getBroadcastUserIds, getUser, getUserDashboard, getReferralLeaderboard, redeemPromoCode, createPromoCode, completeStarPremiumPayment, consumeVideoDownload, registerReferral, completeReferral, setUserPlan } from '../services/users.ts';
import { checkUserForceSub, getAllForceSubChannels, upsertForceSubChannel, updateForceSubChannel, deleteForceSubChannel, createForceSubInviteLink } from '../services/forceSub.ts';
import { getAdminSession, setAdminSession, clearAdminSession } from '../services/adminSessions.ts';
import { javtifulProvider } from '../providers/javtiful/index.ts';
import { sendDumpVideoToUser, storeThumbnailInDumpChannel } from '../services/dump.ts';
import { installMessageDeleteTimer } from '../services/messageDeleteTimer.ts';
import { getSetting, setSetting } from '../services/settings.ts';
import { classifyTelegramError, withTelegramRetry } from '../services/telegramErrors.ts';

let botInstance: Telegraf | null = null;
let isPollingActive = false;
let activeBotRole: 'primary' | 'backup' = config.activeBot;

function tokenForRole(role: 'primary' | 'backup'): string {
  return role === 'backup' ? config.backupBotToken : config.botToken;
}

function availableRole(preferred: 'primary' | 'backup'): 'primary' | 'backup' | null {
  if (tokenForRole(preferred)) return preferred;
  const fallback = preferred === 'primary' ? 'backup' : 'primary';
  return tokenForRole(fallback) ? fallback : null;
}

const PREMIUM_PACKAGES = [
  { days: 7, stars: config.premium7Stars, label: '7 Days' },
  { days: 30, stars: config.premium30Stars, label: '30 Days' },
  { days: 90, stars: config.premium90Stars, label: '90 Days' },
] as const;

function parsePremiumPayload(payload: string): { days: number; stars: number; userId: number } | null {
  const match = /^premium:(\\d+):(\\d+):(\\d+)$/.exec(payload);
  if (!match) return null;
  const days = Number(match[1]);
  const stars = Number(match[2]);
  const userId = Number(match[3]);
  const pkg = PREMIUM_PACKAGES.find(item => item.days === days && item.stars === stars);
  if (!pkg || !Number.isSafeInteger(userId)) return null;
  return { days, stars, userId };
}

async function sendPremiumStore(ctx: any) {
  if (!ctx.from) return;
  const rows = PREMIUM_PACKAGES.map(pkg => [
    Markup.button.callback(`💎 ${pkg.label} — ${pkg.stars} ⭐`, `premium:buy:${pkg.days}`),
  ]);
  rows.push([Markup.button.callback('⬅️ My Dashboard', 'user:plan')]);
  return ctx.reply(
    '💎 <b>Premium Access</b>\\n\\nPremium gives you unlimited video downloads for the selected period.\\n\\nChoose a package:',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
  );
}

async function sendPremiumInvoice(ctx: any, days: number) {
  if (!ctx.from) return;
  const pkg = PREMIUM_PACKAGES.find(item => item.days === days);
  if (!pkg) return ctx.reply('❌ Invalid Premium package.');

  const payload = `premium:${pkg.days}:${pkg.stars}:${ctx.from.id}`;
  return ctx.replyWithInvoice({
    title: `Premium — ${pkg.label}`,
    description: `Unlimited video access for ${pkg.days} days.`,
    payload,
    currency: 'XTR',
    prices: [{ label: `Premium ${pkg.days} days`, amount: pkg.stars }],
  });
}

function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  bot.on('pre_checkout_query', async (ctx) => {
    const query = ctx.preCheckoutQuery;
    const parsed = parsePremiumPayload(query.invoice_payload);
    const valid = Boolean(
      parsed &&
      parsed.userId === query.from.id &&
      query.currency === 'XTR' &&
      query.total_amount === parsed.stars
    );
    if (!valid) {
      return ctx.answerPreCheckoutQuery(false, 'This Premium invoice is invalid or has expired.');
    }
    return ctx.answerPreCheckoutQuery(true);
  });

  bot.on('successful_payment', async (ctx) => {
    if (!ctx.from || !('successful_payment' in ctx.message)) return;
    const payment = ctx.message.successful_payment;
    const parsed = parsePremiumPayload(payment.invoice_payload);
    if (!parsed || parsed.userId !== ctx.from.id) {
      console.error('[Payment] Rejected malformed successful payment payload.');
      return;
    }

    try {
      const result = await completeStarPremiumPayment({
        userId: ctx.from.id,
        payload: payment.invoice_payload,
        durationDays: parsed.days,
        amountStars: payment.total_amount,
        currency: payment.currency,
        telegramChargeId: payment.telegram_payment_charge_id,
        providerChargeId: payment.provider_payment_charge_id,
      });

      if (!result.success) {
        return ctx.reply(`⚠️ Payment received but Premium activation failed: ${escapeHtml(result.message)}`);
      }

      return ctx.reply(
        `🎉 <b>Premium activated!</b>\\n\\n💎 Unlimited access: <b>${parsed.days} days</b>\\n📅 Until: <b>${escapeHtml(result.plan_expires_at ? new Date(result.plan_expires_at).toLocaleString() : 'your current Premium expiry')}</b>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📊 My Dashboard', 'user:plan')]]) },
      );
    } catch (err) {
      console.error('[Payment] Processing failed:', err);
      return ctx.reply('⚠️ Your payment was received by Telegram, but activation could not be completed automatically. Please contact an admin with your payment receipt.');
    }
  });

  // Automatically delete bot-created messages according to the admin-configured timer.
  // Dump-channel storage messages are excluded so indexed videos remain available.
  installMessageDeleteTimer(bot);

  bot.catch((err: unknown, ctx) => {
    const info = classifyTelegramError(err);
    console.error(`[TelegramBot] ${info.kind} on update #${ctx?.update?.update_id || 'unknown'}:`, info.message);
    if (info.kind === 'blocked' || info.kind === 'not_found' || info.kind === 'invalid_chat') return;
    try {
      void ctx.reply('⚠️ Telegram request failed. Please try again.').catch(() => {});
    } catch { /* ignore secondary reply failures */ }
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
  bot.command('dashboard', async (ctx) => sendUserPlan(ctx));
  bot.command('leaderboard', async (ctx) => sendReferralLeaderboard(ctx));
  bot.command('plan', async (ctx) => sendUserPlan(ctx));

bot.command('start', async (ctx) => {
    const startText = 'text' in ctx.message ? ctx.message.text : '';
    let payload = startText.replace(/^\/start(?:@\w+)?\s*/i, '').trim();

    if (payload && /^ref_\d+$/i.test(payload) && ctx.from) {
      const referrerId = Number(payload.slice(4));
      try {
        const referral = await registerReferral(referrerId, ctx.from.id);
        if (referral.success) {
          await ctx.reply('✅ Referral tracked! The inviter will receive +1 day of unlimited access after you successfully receive your first video.');
        }
      } catch (err) {
        console.warn('[Referral] Failed:', err instanceof Error ? err.message : String(err));
      }
      // Referral payload is not a video code.
      if (payload.toLowerCase().startsWith('ref_')) {
        payload = '';
      }
    }

    if (payload) {
      return deliverVideoToUser(bot, ctx, payload);
    }

    const welcome = `👋 *Welcome to PiratecultJAV Bot*\\n\\nSend any JAV code (e.g. \`ADN-001\`, \`STAR-765\`, \`JUR-270\`) or keyword to search the catalog.\\n\\nType your code below:`;
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

  bot.command('createpromo', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');

    const parts = ctx.message.text.trim().split(/\\s+/);
    const code = parts[1]?.trim().toUpperCase();
    const reward = parts[2]?.toLowerCase();
    const days = Number(parts[3]);
    const maxUsesRaw = parts[4];
    const expiryRaw = parts[5];

    if (!code || !['premium', 'semi_premium', 'unlimited'].includes(reward) || !Number.isInteger(days) || days <= 0) {
      return ctx.reply(
        'Usage:\\n/createpromo <CODE> <premium|semi_premium|unlimited> <days> [max_uses] [expiry_iso]\\n\\nExample: /createpromo WELCOME30 premium 30 100'
      );
    }

    const maxUses = maxUsesRaw && maxUsesRaw !== '-' ? Number(maxUsesRaw) : null;
    if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses <= 0)) {
      return ctx.reply('❌ max_uses must be a positive integer.');
    }

    let expiresAt: string | null = null;
    if (expiryRaw && expiryRaw !== '-') {
      const parsed = new Date(expiryRaw);
      if (Number.isNaN(parsed.getTime())) return ctx.reply('❌ Invalid expiry. Use ISO format, e.g. 2026-12-31T23:59:59Z.');
      expiresAt = parsed.toISOString();
    }

    const rewardType = reward === 'unlimited' ? 'unlimited' : 'plan';
    const rewardPlan = rewardType === 'plan' ? reward as 'premium' | 'semi_premium' : null;

    try {
      const ok = await createPromoCode(code, rewardType, rewardPlan, days, maxUses, expiresAt, ctx.from!.id);
      if (!ok) return ctx.reply('❌ Could not create promo. The code may already exist or the reward settings are invalid.');

      return ctx.reply(
        `✅ <b>Promo created</b>\\n\\n🎟️ Code: <code>${escapeHtml(code)}</code>\\n🎁 Reward: <b>${rewardType === 'unlimited' ? `Unlimited for ${days} day(s)` : `${rewardPlan} for ${days} day(s)`}</b>\\n👥 Uses: <b>${maxUses ?? 'Unlimited'}</b>${expiresAt ? `\\n⏰ Expires: <b>${escapeHtml(new Date(expiresAt).toLocaleString())}</b>` : ''}`,
        { parse_mode: 'HTML' },
      );
    } catch (err) {
      console.error('[Promo] Create failed:', err);
      return ctx.reply('❌ Failed to create promo code.');
    }
  });

  bot.command('user', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const userId = Number(ctx.message.text.trim().split(/\s+/)[1]);
    if (!Number.isSafeInteger(userId)) return ctx.reply('Usage: /user <telegram_user_id>');
    try {
      const dashboard = await getUserDashboard(userId);
      if (!dashboard) return ctx.reply('❌ User not found.');
      const plan = dashboard.plan === 'premium' ? '💎 Premium' : dashboard.plan === 'semi_premium' ? '⚡ Semi Premium' : '🆓 Free';
      const expiry = dashboard.plan_expires_at ? new Date(dashboard.plan_expires_at).toLocaleString() : '—';
      const bonus = dashboard.unlimited_until ? new Date(dashboard.unlimited_until).toLocaleString() : '—';
      return ctx.reply(
        '👤 <b>User Details</b>\\n\\n' +
        `🆔 ID: <code>${userId}</code>\\n` +
        `⭐ Plan: <b>${plan}</b>\\n` +
        `📅 Plan expiry: <b>${escapeHtml(expiry)}</b>\\n` +
        `🎁 Unlimited bonus: <b>${escapeHtml(bonus)}</b>\\n` +
        `🎬 Today: <b>${dashboard.daily_used}/${dashboard.daily_limit}</b>\\n` +
        `🤝 Referrals: <b>${dashboard.completed_referral_count}/${dashboard.referral_count}</b>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Admin Center', 'settings:main')]]) },
      );
    } catch (err) {
      return ctx.reply('❌ Could not load user: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
    }
  });

  bot.command('setplan', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const parts = ctx.message.text.trim().split(/\s+/);
    const userId = Number(parts[1]);
    const plan = parts[2] as 'free' | 'semi_premium' | 'premium';
    if (!Number.isSafeInteger(userId) || !['free', 'semi_premium', 'premium'].includes(plan)) {
      return ctx.reply('Usage: /setplan <telegram_user_id> <free|semi_premium|premium>');
    }
    const ok = await setUserPlan(userId, plan);
    return ctx.reply(ok ? `✅ User ${userId} set to ${plan}.` : '❌ User not found.');
  });

  bot.command('premium', async (ctx) => {
    return sendPremiumStore(ctx);
  });

  bot.command('promo', async (ctx) => {
    if (!ctx.from) return;
    const parts = ctx.message.text.trim().split(/\\s+/);
    const code = parts[1]?.trim();
    if (!code) return ctx.reply('Usage: /promo <CODE>');

    try {
      const result = await redeemPromoCode(ctx.from.id, code);
      if (!result.success) {
        return ctx.reply(`❌ ${escapeHtml(result.message)}`, { parse_mode: 'HTML' });
      }

      const reward = result.reward_type === 'unlimited'
        ? `∞ Unlimited access for ${result.reward_days} day(s)`
        : `${result.reward_plan === 'premium' ? '💎 Premium' : '⚡ Semi Premium'} for ${result.reward_days} day(s)`;

      return ctx.reply(
        `🎉 <b>Promo redeemed!</b>\\n\\n🎟️ Code: <code>${escapeHtml(code.toUpperCase())}</code>\\n🎁 Reward: <b>${reward}</b>\\n📅 Until: <b>${result.expires_at ? escapeHtml(new Date(result.expires_at).toLocaleString()) : 'active'}</b>`,
        { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📊 My Dashboard', 'user:plan')]]) },
      );
    } catch (err) {
      console.error('[Promo] Redemption failed:', err);
      return ctx.reply('⚠️ Could not redeem this promo code right now. Please try again later.');
    }
  });

  bot.command('plan', async (ctx) => {
    if (!ctx.from) return;
    return sendUserPlan(ctx);
  });

  bot.command('referral', async (ctx) => {
    if (!ctx.from) return;
    return sendReferralInfo(ctx);
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
    const text = ctx.message.text.replace(/^\/broadcast\s*/i, '').trim();
    if (!text) return ctx.reply('Usage: /broadcast <message>');
    const userIds = await getBroadcastUserIds();
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < userIds.length; i += 25) {
      const batch = userIds.slice(i, i + 25);
      await Promise.all(batch.map(async (userId) => {
        try {
          await withTelegramRetry(() => bot.telegram.sendMessage(userId, text), { label: `broadcast:${userId}` });
          sent++;
        } catch (error) {
          const info = classifyTelegramError(error);
          if (info.kind === 'blocked') {
            try { await setUserBlocked(userId, true); } catch { /* keep broadcast running */ }
          }
          failed++;
        }
      }));
      await new Promise(resolve => setTimeout(resolve, 1100));
    }
    return ctx.reply(`📣 Broadcast finished.\\n\\n✅ Sent: ${sent}\\n❌ Failed: ${failed}`);
  });

  bot.command('jobs', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    try {
      const jobs = await getRecentJobs(undefined, 15);
      if (!jobs.length) return ctx.reply('⚙️ No index jobs found.');
      const lines = jobs.map(j => `#${j.id} · <code>${escapeHtml(j.code)}</code> · <b>${j.status}</b> · attempts ${j.attempts}${j.error ? '\n   ❌ ' + escapeHtml(j.error.slice(0, 120)) : ''}`);
      return ctx.reply('⚙️ <b>Recent Index Jobs</b>\n\n' + lines.join('\n'), { parse_mode: 'HTML' });
    } catch (err: unknown) {
      return ctx.reply('❌ ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  bot.command('retryjob', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const id = Number(ctx.message.text.split(/\s+/)[1]);
    if (!Number.isInteger(id)) return ctx.reply('Usage: /retryjob <job_id>');
    try {
      const job = await retryJob(id);
      return ctx.reply(`🔄 Job #${job.id} for ${job.code} has been queued again.`);
    } catch (err: unknown) {
      return ctx.reply('❌ ' + (err instanceof Error ? err.message : String(err)));
    }
  });

  bot.command('test', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const code = normalizeCode(ctx.message.text.replace(/^\/test\s*/i, ''));
    if (!code) return ctx.reply('Usage: /test <JAV-CODE>');
    try {
      const metadata = await javtifulProvider.getMetadata(code);
      return ctx.reply(`🧪 <b>Javtiful Test</b>\n\n<b>Code:</b> <code>${escapeHtml(metadata.code)}</code>\n<b>Title:</b> ${escapeHtml(metadata.title)}\n<b>Actresses:</b> ${escapeHtml(metadata.actresses.join(', ') || 'N/A')}\n<b>Studio:</b> ${escapeHtml(metadata.studio || 'N/A')}\n<b>Duration:</b> ${escapeHtml(metadata.duration || 'N/A')}\n<b>Date:</b> ${escapeHtml(metadata.date || 'N/A')}\n<b>Genres:</b> ${escapeHtml(metadata.genres.join(', ') || 'N/A')}`, { parse_mode: 'HTML' });
    } catch (err: unknown) {
      return ctx.reply('❌ Provider test failed: ' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
    }
  });

  bot.command('addfs', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const raw = ctx.message.text.replace(/^\/addfs\s*/i, '').trim();
    const parts = raw.split('|').map(v => v.trim());
    const channelId = parts[0];
    const requestMode = /^(true|yes|1)$/i.test((parts[1] || '').replace(/^request\s*:\s*/i, ''));
    if (!channelId) return ctx.reply('Usage: /addfs <channel_id> [| request:true|false]');
    try {
      const invite = await createForceSubInviteLink(bot, channelId, requestMode);
      const channel = await upsertForceSubChannel({
        channelId,
        title: invite.title,
        inviteLink: invite.inviteLink,
        requestMode,
        isActive: true,
      });
      return ctx.reply(
        `✅ <b>Force-sub channel added</b>\\n\\n📢 <b>${escapeHtml(channel.title)}</b>\\n🆔 <code>${escapeHtml(channel.channel_id)}</code>\\n🔗 <code>${escapeHtml(channel.invite_link || '')}</code>\\n📨 Request mode: <b>${channel.request_mode ? 'ON' : 'OFF'}</b>`,
        { parse_mode: 'HTML' },
      );
    } catch (err: unknown) {
      return ctx.reply('❌ Could not add channel. Make sure the bot is an administrator and can create invite links.\\n\\n' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
    }
  });

  bot.command('removefs', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized.');
    const id = ctx.message.text.split(/\s+/)[1];
    if (!id) return ctx.reply('Usage: /removefs <channel_record_id>');
    try { await deleteForceSubChannel(id); return ctx.reply('✅ Force-sub channel removed.'); }
    catch (err: unknown) { return ctx.reply('❌ ' + (err instanceof Error ? err.message : String(err))); }
  });

  bot.command('help', async (ctx) => {
    const admin = Boolean(ctx.from && isAdmin(ctx.from.id));
    const userHelp = [
      '🤖 <b>PiratecultJAV Bot Help</b>',
      '',
      '🔎 <b>Search</b>',
      'Send a JAV code or keyword, for example:',
      '<code>ROE-324</code>',
      '<code>ABW-004</code>',
      '',
      '🎬 Tap <b>Get</b> on a result to receive the video.',
      '🔗 You can also open a direct bot link with the video code.',
      '',
      '📌 <b>Commands</b>',
      '/start — Start the bot',
      '/help — Show this help',
      '/plan — Show your plan and daily allowance',
      '/premium — View Premium packages',
      '/promo <CODE> — Redeem a promo code',
      '/referral — Get your referral link',
      '/leaderboard — Referral leaderboard',
      '/settings — Admin panel (admins only)',
      '',
      'If a download is unavailable, try searching the code again later.'
    ].join('\\n');

    if (!admin) return ctx.reply(userHelp, { parse_mode: 'HTML' });

    const adminHelp = [
      userHelp,
      '',
      '━━━━━━━━━━━━━━━━',
      '👑 <b>ADMIN COMMANDS</b>',
      '',
      '/admin — Open the admin command center',
      '/settings — Open the admin command center (alias)',
      '/stats — Quick system statistics',
      '/post — Add/publish a video',
      '/broadcast &lt;message&gt; — Broadcast to users',
      '/user &lt;user_id&gt; — View a user dashboard',
      '/setplan &lt;user_id&gt; &lt;free|semi_premium|premium&gt; — Set a plan',
      '/createpromo &lt;CODE&gt; &lt;premium|semi_premium|unlimited&gt; &lt;days&gt; [max_uses] [expiry]',
      '/block &lt;user_id&gt; — Block a user',
      '/unblock &lt;user_id&gt; — Unblock a user',
      '/jobs — View recent index jobs',
      '/retryjob &lt;job_id&gt; — Retry an index job',
      '/test &lt;code&gt; — Test Javtiful metadata',
      '/addfs &lt;channel_id&gt; [| request:true|false] — Add force-sub; invite link is automatic',
      '/removefs &lt;record_id&gt; — Remove force-sub channel',
      '/cancel — Cancel the current admin operation',
      '',
      '🧭 <b>Dashboard sections</b>: Overview · Users · Monetization · Content · Broadcast · Force Sub · System · Recovery.',
      '',
      '🔐 Only Telegram IDs listed in <code>ADMIN_IDS</code> can use admin functions.'
    ].join('\\n');

    return ctx.reply(adminHelp, { parse_mode: 'HTML' });
  });

  // Admin command center
  bot.command('settings', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    return showAdminSettings(ctx);
  });

  bot.command('admin', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.reply('Unauthorized: Admin access required.');
    return showAdminSettings(ctx);
  });

  bot.action('settings:main', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return showAdminSettings(ctx);
  });

  bot.action('admin:overview', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return showAdminSettings(ctx);
  });

  bot.action('admin:users', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const users = await countUsers();
    return ctx.editMessageText(
      '👥 <b>User Management</b>\\n\\n' +
      `Total users: <b>${users}</b>\\n\\n` +
      'Use the commands below for direct actions:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📣 Broadcast', 'settings:broadcast')],
          [Markup.button.callback('⬅️ Back', 'settings:main')],
        ]),
      },
    );
  });

  bot.action('admin:monetization', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '💰 <b>Monetization</b>\\n\\n' +
      `💎 Premium 7d: <b>${config.premium7Stars} ⭐</b>\\n` +
      `💎 Premium 30d: <b>${config.premium30Stars} ⭐</b>\\n` +
      `💎 Premium 90d: <b>${config.premium90Stars} ⭐</b>\\n\\n` +
      '🎟️ Promo codes are managed with <code>/createpromo</code>.\\n' +
      '👤 Manual access is managed with <code>/setplan</code>.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🎟️ Promo Help', 'admin:promo_help')],
          [Markup.button.callback('⬅️ Back', 'settings:main')],
        ]),
      },
    );
  });

  bot.action('admin:promo_help', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '🎟️ <b>Promo Management</b>\\n\\n' +
      '<code>/createpromo CODE premium 30 100</code>\\n' +
      '<code>/createpromo CODE semi_premium 7</code>\\n' +
      '<code>/createpromo CODE unlimited 1 50</code>\\n\\n' +
      'Optional expiry: add an ISO timestamp as the last argument.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin:monetization')]]) },
    );
  });

  bot.action('admin:content', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const jobs = await countJobs();
    return ctx.editMessageText(
      '🎬 <b>Content & Indexing</b>\\n\\n' +
      'Use these tools to manage the catalog and indexing pipeline.',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('📝 Post Video', 'admin:post_help'), Markup.button.callback('🧪 Provider Test', 'admin:test_help')],
          [Markup.button.callback('⚙️ Jobs', 'admin:jobs')],
          [Markup.button.callback('⬅️ Back', 'settings:main')],
        ]),
      },
    );
  });

  bot.action('admin:post_help', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '📝 <b>Post Video</b>\\n\\nUse <code>/post</code>, enter the JAV code, then send/forward the video.\\n\\nThe bot fetches metadata, stores the video in the dump channel, and creates/updates the catalog record.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin:content')]]) },
    );
  });

  bot.action('admin:test_help', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '🧪 <b>Provider Test</b>\\n\\nUse <code>/test JAV-CODE</code> to fetch and display provider metadata without publishing a video.',
      { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin:content')]]) },
    );
  });

  bot.action('admin:jobs', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const jobs = await getRecentJobs(undefined, 10);
    const lines = jobs.length
      ? jobs.map(j => `#${j.id} · <code>${escapeHtml(j.code)}</code> · <b>${escapeHtml(j.status)}</b>`)
      : ['No recent jobs.'];
    return ctx.editMessageText('⚙️ <b>Recent Jobs</b>\\n\\n' + lines.join('\\n'), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back', 'admin:content')], [Markup.button.callback('🔄 Refresh', 'admin:jobs')]]),
    });
  });

  bot.action('admin:system', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return ctx.editMessageText(
      '🛠️ <b>System</b>\\n\\nChoose a system control:',
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🗑️ Delete Timer', 'settings:delete_timer')],
          [Markup.button.callback('🛠️ Maintenance', 'settings:maintenance')],
          [Markup.button.callback('🔄 Recovery', 'settings:recovery')],
          [Markup.button.callback('⬅️ Back', 'settings:main')],
        ]),
      },
    );
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
    await setAdminSession(ctx.from.id, 'broadcast', 'awaiting_message');
    return ctx.editMessageText('📣 *Broadcast*\n\nSend the message to broadcast to all users.\n\nUse /cancel to abort.', { parse_mode: 'Markdown' });
  });

  bot.action('settings:forcesub', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const enabled = await getSetting<boolean>('force_sub_enabled', false);
    return showForceSubAdminMenu(ctx);
  });

  bot.action('settings:forcesub:add', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await setAdminSession(ctx.from.id, 'force_sub_add', 'awaiting_channel');
    await ctx.answerCbQuery();
    return ctx.reply(
      '➕ <b>Add Force-Sub Channel</b>\\n\\n' +
      'Add the bot as an administrator in the channel first.\\n\\n' +
      'Then send:\\n<code>channel_id</code>\\n\\n' +
      'Optional request mode:\\n<code>channel_id | request:true</code>\\n<code>channel_id | request:false</code>\\n\\n' +
      'The bot will automatically read the channel title and create the correct invite link.',
      { parse_mode: 'HTML' },
    );
  });

  bot.action(/^settings:forcesub:toggle-channel:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const channels = await getAllForceSubChannels();
    const channel = channels.find(ch => ch.id === ctx.match[1]);
    if (!channel) return ctx.answerCbQuery('Channel not found.', { show_alert: true });
    await updateForceSubChannel(channel.id, { is_active: !channel.is_active });
    await ctx.answerCbQuery(channel.is_active ? 'Disabled.' : 'Enabled.');
    return showForceSubAdminMenu(ctx);
  });

  bot.action(/^settings:forcesub:request:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const channels = await getAllForceSubChannels();
    const channel = channels.find(ch => ch.id === ctx.match[1]);
    if (!channel) return ctx.answerCbQuery('Channel not found.', { show_alert: true });

    const nextMode = !channel.request_mode;
    try {
      // Regenerate the invite so the link itself matches the selected join mode.
      const invite = await createForceSubInviteLink(bot, channel.channel_id, nextMode);
      await updateForceSubChannel(channel.id, {
        request_mode: nextMode,
        invite_link: invite.inviteLink,
        title: invite.title,
      });
      await ctx.answerCbQuery(nextMode ? 'Request mode enabled.' : 'Request mode disabled.');
      return showForceSubAdminMenu(ctx);
    } catch (err: unknown) {
      return ctx.answerCbQuery(
        'Could not update invite. Check bot admin permissions.',
        { show_alert: true },
      );
    }
  });

  bot.action(/^settings:forcesub:delete:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await deleteForceSubChannel(ctx.match[1]);
    await ctx.answerCbQuery('Deleted.');
    return showForceSubAdminMenu(ctx);
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

  bot.action('settings:recovery', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const primary = Boolean(config.botToken);
    const backup = Boolean(config.backupBotToken);
    const active = activeBotRole === 'primary' ? 'PRIMARY' : 'BACKUP';
    return ctx.editMessageText(
      '🔄 *Bot Recovery*\\n\\n' +
      '🟢 Active: *' + active + '*\\n' +
      'Primary token: *' + (primary ? 'configured' : 'missing') + '*\\n' +
      'Backup token: *' + (backup ? 'configured' : 'missing') + '*\\n\\n' +
      'The backup bot must be added to the same dump and force-sub channels with the required permissions.',
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🟢 Use Primary', 'settings:recovery:primary')],
          [Markup.button.callback('🟢 Use Backup', 'settings:recovery:backup')],
          [Markup.button.callback('⬅️ Back', 'settings:main')],
        ]),
      }
    );
  });

  bot.action(/^settings:recovery:(primary|backup)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const role = ctx.match[1] as 'primary' | 'backup';
    if (!tokenForRole(role)) return ctx.answerCbQuery(`${role === 'primary' ? 'Primary' : 'Backup'} token is not configured.`);
    await ctx.answerCbQuery('Switching bot...');
    stopBotPolling();
    botInstance = null;
    activeBotRole = role;
    const started = await startBotPolling();
    if (!started) {
      return ctx.reply('❌ Could not start the selected bot. Check its token and Telegram channel permissions.');
    }
    return showAdminSettings(ctx);
  });

  bot.action('settings:close', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return ctx.deleteMessage().catch(() => undefined);
  });
  // 8. Video download callback query
  bot.action(/^download:(.+)$/, async (ctx) => {
    const identifier = ctx.match[1];
    await ctx.answerCbQuery('Fetching video...');
    return deliverVideoToUser(bot, ctx, identifier);
  });

  bot.action('premium:store', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendPremiumStore(ctx);
  });

  bot.action(/^premium:buy:(\d+)$/, async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendPremiumInvoice(ctx, Number(ctx.match[1]));
  });

  bot.action('user:promo', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return ctx.reply('🎟️ <b>Redeem Promo</b>\\n\\nUse <code>/promo YOUR_CODE</code> to redeem a promo code.', { parse_mode: 'HTML' });
  });

  bot.action('user:leaderboard', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendReferralLeaderboard(ctx);
  });

  bot.action('user:plan', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendUserPlan(ctx);
  });

  bot.action('user:referral', async (ctx) => {
    if (!ctx.from) return ctx.answerCbQuery();
    await ctx.answerCbQuery();
    return sendReferralInfo(ctx);
  });

  // Admin video management callbacks
  bot.action(/^admin:vid:edit:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    return showAdminVideoEditMenu(ctx, ctx.match[1]);
  });

  bot.action(/^admin:vid:refresh:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const videoId = ctx.match[1];
    const video = await getVideoById(videoId);
    if (!video) return ctx.answerCbQuery('Video not found.', { show_alert: true });

    await ctx.answerCbQuery('Refreshing metadata...');
    try {
      const metadata = await javtifulProvider.getMetadata(video.code);
      const updated = await updateVideoMetadata(video.id, {
        title: metadata.title,
        description: metadata.description,
        duration: metadata.duration,
        date: metadata.date,
        actresses: metadata.actresses,
        studio: metadata.studio,
        genres: metadata.genres,
      });

      await showAdminVideoEditMenu(ctx, updated.id);
      return ctx.reply(
        `✅ Metadata refreshed for <code>${escapeHtml(updated.code)}</code>.\nThe record now uses fresh Javtiful data.`,
        { parse_mode: 'HTML' },
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return ctx.reply(
        `❌ Could not refresh <code>${escapeHtml(video.code)}</code>.\n${escapeHtml(message)}`,
        { parse_mode: 'HTML' },
      );
    }
  });

  bot.action(/^admin:vid:toggle_status:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const videoId = ctx.match[1];
    const video = await getVideoById(videoId);
    if (!video) return ctx.answerCbQuery('Video not found.');
    const nextStatus = video.status === 'available' ? 'disabled' : 'available';
    await updateVideoStatus(videoId, nextStatus);
    await ctx.answerCbQuery(`Status set to ${nextStatus}.`);
    return showAdminVideoEditMenu(ctx, videoId);
  });

  bot.action(/^admin:vid:set:(title|actresses|studio|duration):(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const field = ctx.match[1];
    const videoId = ctx.match[2];
    const video = await getVideoById(videoId);
    if (!video) return ctx.reply('Video not found.');

    await setAdminSession(ctx.from!.id, 'edit_video', field, { videoId: video.id, code: video.code });

    let prompt = '';
    if (field === 'title') {
      prompt = `📝 <b>Send the new title for</b> <code>${escapeHtml(video.code)}</code>:\n\n<i>(Send /cancel to abort)</i>`;
    } else if (field === 'actresses') {
      prompt = `💃 <b>Send actress name(s) separated by commas</b> for <code>${escapeHtml(video.code)}</code>:\n<i>Example: Meguri, Ootsuki Hibiki</i>\n\n<i>(Send /cancel to abort)</i>`;
    } else if (field === 'studio') {
      prompt = `🏢 <b>Send the studio/maker name for</b> <code>${escapeHtml(video.code)}</code>:\n\n<i>(Send /cancel to abort)</i>`;
    } else if (field === 'duration') {
      prompt = `⏱ <b>Send video duration</b> (e.g. <code>02:15:30</code>) for <code>${escapeHtml(video.code)}</code>:\n\n<i>(Send /cancel to abort)</i>`;
    }

    return ctx.reply(prompt, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([[Markup.button.callback('⬅️ Back to Menu', `admin:vid:edit:${videoId}`)]]),
    });
  });

  bot.action(/^admin:vid:del_confirm:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery();
    const videoId = ctx.match[1];
    const video = await getVideoById(videoId);
    if (!video) return ctx.reply('Video not found.');

    const prompt = [
      `⚠️ <b>Delete Video Confirmation</b>`,
      ``,
      `Are you sure you want to delete this video?`,
      `🏷️ <b>Code:</b> <code>${escapeHtml(video.code)}</code>`,
      `📌 <b>Title:</b> <i>${escapeHtml(video.title)}</i>`,
      ``,
      `🚨 <i>This will permanently remove it from catalog and search!</i>`,
    ].join('\n');

    return ctx.editMessageText(prompt, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔴 Yes, Delete Video', `admin:vid:del_exec:${video.id}`)],
        [Markup.button.callback('⬅️ Cancel', `admin:vid:edit:${video.id}`)],
      ]),
    }).catch(() => {
      return ctx.reply(prompt, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          [Markup.button.callback('🔴 Yes, Delete Video', `admin:vid:del_exec:${video.id}`)],
          [Markup.button.callback('⬅️ Cancel', `admin:vid:edit:${video.id}`)],
        ]),
      });
    });
  });

  bot.action(/^admin:vid:del_exec:(.+)$/, async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    const videoId = ctx.match[1];
    const video = await getVideoById(videoId);
    const code = video?.code || videoId;

    try {
      await deleteVideo(videoId);
      await ctx.answerCbQuery('Deleted.');
      return ctx.editMessageText(`🗑️ <b>Deleted:</b> Video <code>${escapeHtml(code)}</code> has been deleted from catalog.`, {
        parse_mode: 'HTML',
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return ctx.reply(`❌ Delete failed: ${errMsg}`);
    }
  });

  bot.action('admin:vid:cancel', async (ctx) => {
    if (!isAdmin(ctx.from?.id)) return ctx.answerCbQuery('Unauthorized.');
    await ctx.answerCbQuery('Closed.');
    return ctx.deleteMessage().catch(() => undefined);
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
    if (!session) {
      return next();
    }

    // Step 0: Admin editing video metadata
    if (session.action === 'edit_video' && 'text' in ctx.message) {
      const text = ctx.message.text.trim();
      if (text === '/cancel') {
        await clearAdminSession(ctx.from.id);
        return ctx.reply('Edit cancelled.');
      }

      const videoId = String(session.payload.videoId);
      const code = String(session.payload.code || 'Video');

      try {
        if (session.step === 'title') {
          await updateVideoMetadata(videoId, { title: text });
          await clearAdminSession(ctx.from.id);
          return ctx.reply(
            `✅ Title updated for <code>${escapeHtml(code)}</code>:\n<i>${escapeHtml(text)}</i>`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Menu', `admin:vid:edit:${videoId}`)]]),
            }
          );
        } else if (session.step === 'actresses') {
          const actresses = text.split(/[,/]/).map(s => s.trim()).filter(Boolean);
          await updateVideoMetadata(videoId, { actresses });
          await clearAdminSession(ctx.from.id);
          return ctx.reply(
            `✅ Actresses updated for <code>${escapeHtml(code)}</code>:\n<b>${escapeHtml(actresses.join(', '))}</b>`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Menu', `admin:vid:edit:${videoId}`)]]),
            }
          );
        } else if (session.step === 'studio') {
          await updateVideoMetadata(videoId, { studio: text });
          await clearAdminSession(ctx.from.id);
          return ctx.reply(
            `✅ Studio updated for <code>${escapeHtml(code)}</code>:\n<b>${escapeHtml(text)}</b>`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Menu', `admin:vid:edit:${videoId}`)]]),
            }
          );
        } else if (session.step === 'duration') {
          await updateVideoMetadata(videoId, { duration: text });
          await clearAdminSession(ctx.from.id);
          return ctx.reply(
            `✅ Duration updated for <code>${escapeHtml(code)}</code>:\n<b>${escapeHtml(text)}</b>`,
            {
              parse_mode: 'HTML',
              ...Markup.inlineKeyboard([[Markup.button.callback('✏️ Edit Menu', `admin:vid:edit:${videoId}`)]]),
            }
          );
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return ctx.reply(`❌ Update failed: ${errMsg}\nPlease try again or send /cancel.`);
      }
    }

    if (session.action === 'broadcast' && session.step === 'awaiting_message' && 'text' in ctx.message) {
      const message = ctx.message.text.trim();
      if (!message) return ctx.reply('Send a non-empty message or /cancel.');
      if (message.length > 4096) return ctx.reply('Message exceeds Telegram 4096-character limit.');
      await clearAdminSession(ctx.from.id);
      const userIds = await getBroadcastUserIds();
      let sent = 0, failed = 0;
      for (let i = 0; i < userIds.length; i += 25) {
        const batch = userIds.slice(i, i + 25);
        await Promise.all(batch.map(async userId => {
          try { await withTelegramRetry(() => bot.telegram.sendMessage(userId, message), { label: 'broadcast:' + userId }); sent++; }
          catch (error) { failed++; if (classifyTelegramError(error).kind === 'blocked') { try { await setUserBlocked(userId, true); } catch {} } }
        }));
        if (i + 25 < userIds.length) await new Promise(resolve => setTimeout(resolve, 1100));
      }
      return ctx.reply('📣 Broadcast finished.\\n\\n✅ Sent: ' + sent + '\\n❌ Failed: ' + failed);
    }

    if (session.action === 'force_sub_add' && session.step === 'awaiting_channel' && 'text' in ctx.message) {
      const parts = ctx.message.text.trim().split('|').map(v => v.trim());
      const channelId = parts[0];
      const requestMode = /^(true|yes|1)$/i.test((parts[1] || '').replace(/^request\s*:\s*/i, ''));
      if (!channelId) return ctx.reply('Format: channel_id | request:true|false');
      try {
        const invite = await createForceSubInviteLink(bot, channelId, requestMode);
        const channel = await upsertForceSubChannel({
          channelId,
          title: invite.title,
          inviteLink: invite.inviteLink,
          requestMode,
          isActive: true,
        });
        await clearAdminSession(ctx.from.id);
        return ctx.reply(
          `✅ <b>Force-sub channel saved</b>\\n\\n📢 <b>${escapeHtml(channel.title)}</b>\\n🔗 <code>${escapeHtml(channel.invite_link || '')}</code>\\n📨 Request mode: <b>${channel.request_mode ? 'ON' : 'OFF'}</b>`,
          { parse_mode: 'HTML' },
        );
      } catch (err: unknown) {
        return ctx.reply('❌ Could not configure channel. Make sure the bot is an administrator with permission to create invite links.\\n\\n' + escapeHtml(err instanceof Error ? err.message : String(err)), { parse_mode: 'HTML' });
      }
    }

    if (session.action !== 'post') {
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

  return bot;
}

export function getActiveBotRole(): 'primary' | 'backup' {
  return activeBotRole;
}

let cachedBotUsername: string | null = null;

export async function getBotUsername(): Promise<string | null> {
  if (cachedBotUsername) return cachedBotUsername;
  const bot = getBot();
  if (!bot) return null;

  try {
    const me = await bot.telegram.getMe();
    cachedBotUsername = me.username || null;
    return cachedBotUsername;
  } catch {
    return null;
  }
}

export function getBot(): Telegraf | null {
  if (botInstance) return botInstance;

  const role = availableRole(activeBotRole);
  if (!role) return null;
  activeBotRole = role;

  const token = tokenForRole(role);
  botInstance = createBot(token);

  return botInstance;
}


async function deliverVideoToUser(bot: Telegraf, ctx: any, identifier: string) {
  try {
    const rawCode = identifier.trim();
    const norm = normalizeCode(rawCode);

    // 1. Try finding video by exact code or normalized code or database ID
    let video = await getVideoByCode(rawCode);
    if (!video && norm) {
      video = await getVideoByCode(norm);
    }
    if (!video) {
      video = await getVideoById(rawCode);
    }

    // 2. If not found by direct lookup, search catalog
    if (!video) {
      const { videos } = await searchVideos(norm || rawCode, 5, 0);
      if (videos.length === 1) {
        video = videos[0];
      } else if (videos.length > 1) {
        return handleSearchQuery(ctx, rawCode, 0);
      } else {
        return ctx.reply(`❌ Video with code "${rawCode}" was not found in catalog.`);
      }
    }

    if (video.status !== 'available') {
      return ctx.reply(`⚠️ Video *${video.code}* is currently marked as ${video.status}. Please check back later.`, {
        parse_mode: 'Markdown',
      });
    }

    // 3. Force-sub check
    if (ctx.from) {
      const forceSub = await checkUserForceSub(bot, ctx.from.id);
      if (!forceSub.passed) {
        const buttons: any[] = forceSub.missingChannels.map(ch =>
          Markup.button.url(
            ch.request_mode ? `📨 Request to Join ${ch.title}` : `Join ${ch.title}`,
            ch.invite_link || `https://t.me/${ch.channel_id.replace('@', '')}`
          )
        );
        buttons.push(Markup.button.callback('🔄 Get Video', `download:${video.id}`));
        return ctx.reply(
          `⚠️ *Access Required*\nPlease join our channel(s) below to receive *${video.code}*:`,
          {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard(buttons.map(b => [b])),
          }
        );
      }
    }

    // 4. Enforce the user's daily video allowance only after force-sub passes.
    // Admins are exempt. This also covers direct /start CODE links.
    if (ctx.from && !isAdmin(ctx.from.id)) {
      try {
        const allowance = await consumeVideoDownload(ctx.from.id);
        if (!allowance.allowed) {
          const planText = allowance.plan === 'semi_premium' ? 'Semi Premium (40/day)' : 'Free (20/day)';
          return ctx.reply(
            `🚫 <b>Daily video limit reached</b>\n\nYour plan: <b>${planText}</b>\nCome back tomorrow or upgrade to Premium for unlimited videos.`,
            { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('📊 My Plan', 'user:plan')], [Markup.button.callback('🔗 Refer & Earn', 'user:referral')]]) }
          );
        }
      } catch (err) {
        console.error('[Quota] Failed:', err);
        return ctx.reply('⚠️ Could not verify your daily download limit. Please try again.');
      }
    }

    // 5. Directly deliver the stored video to the user
    await sendDumpVideoToUser(
      bot,
      ctx.chat!.id,
      video.dump_chat_id,
      video.video_message_id,
      `🎬 *${video.code}* - ${video.title}`
    );

    // Referral reward is granted only after the referred user actually receives
    // their first video. The database function is atomic and one-time.
    if (ctx.from && !isAdmin(ctx.from.id)) {
      try {
        const referral = await completeReferral(ctx.from.id);
        if (referral.success) {
          await ctx.reply(
            '🎉 Referral completed! Your inviter earned +1 day of unlimited video access.'
          );
        }
      } catch (err) {
        console.warn('[Referral] Completion failed:', err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[TelegramBot] Failed direct video delivery for ${identifier}:`, errMsg);
    return ctx.reply(`⚠️ Failed retrieving video from storage: ${errMsg}`);
  }
}

async function showAdminVideoEditMenu(ctx: any, videoId: string) {
  const video = await getVideoById(videoId);
  if (!video) {
    return ctx.reply('Video not found.');
  }

  const actresses = cleanActressList(video.metadata?.actresses);
  const text = [
    `✏️ <b>Admin Edit:</b> <code>${escapeHtml(video.code)}</code>`,
    ``,
    `📌 <b>Title:</b> <i>${escapeHtml(video.title)}</i>`,
    `💃 <b>Cast:</b> ${escapeHtml(actresses.join(', ') || 'None')}`,
    `🏢 <b>Studio:</b> ${escapeHtml(video.metadata?.studio || 'None')}`,
    `⏱ <b>Duration:</b> ${escapeHtml(video.metadata?.duration || 'None')}`,
    `📊 <b>Status:</b> ${video.status === 'available' ? '🟢 Available' : '🔴 Disabled'}`,
    ``,
    `<i>Tap a button below to update:</i>`,
  ].join('\n');

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('📝 Edit Title', `admin:vid:set:title:${video.id}`),
      Markup.button.callback('💃 Edit Cast', `admin:vid:set:actresses:${video.id}`),
    ],
    [
      Markup.button.callback('🏢 Edit Studio', `admin:vid:set:studio:${video.id}`),
      Markup.button.callback('⏱ Edit Duration', `admin:vid:set:duration:${video.id}`),
    ],
    [
      Markup.button.callback('🔄 Refresh Metadata', `admin:vid:refresh:${video.id}`),
      Markup.button.callback(video.status === 'available' ? '🔴 Disable Video' : '🟢 Enable Video', `admin:vid:toggle_status:${video.id}`),
    ],
    [
      Markup.button.callback('🗑️ Delete Video', `admin:vid:del_confirm:${video.id}`),
    ],
    [
      Markup.button.callback('❌ Close', 'admin:vid:cancel'),
    ],
  ]);

  if (ctx.callbackQuery) {
    return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard }).catch(() => {
      return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
    });
  }
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
}

async function sendReferralLeaderboard(ctx: any) {
  if (!ctx.from) return;

  try {
    const entries = await getReferralLeaderboard(10);
    if (!entries.length) {
      return ctx.reply(
        '🏆 <b>Referral Leaderboard</b>\\n\\nNo completed referrals yet. Be the first to invite someone!',
        {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard([[Markup.button.callback('🔗 Refer & Earn', 'user:referral')], [Markup.button.callback('⬅️ My Dashboard', 'user:plan')]]),
        },
      );
    }

    const lines = ['🏆 <b>Referral Leaderboard</b>', '', '<i>Ranked by completed referrals</i>', ''];
    entries.forEach((entry, index) => {
      const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `<b>#${index + 1}</b>`;
      lines.push(
        `${medal} <b>${escapeHtml(entry.display_name)}</b> — <b>${entry.completed_referrals}</b> completed / ${entry.total_referrals} invited`,
      );
    });

    const mine = entries.findIndex(entry => entry.telegram_user_id === ctx.from.id);
    if (mine >= 0) {
      lines.push('', `📍 <b>Your rank:</b> #${mine + 1}`);
    } else {
      lines.push('', '📍 <b>Your rank:</b> outside the top 10');
    }

    return ctx.reply(lines.join('\\n'), {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('🔗 Refer & Earn', 'user:referral')],
        [Markup.button.callback('⬅️ My Dashboard', 'user:plan')],
      ]),
    });
  } catch (err) {
    console.error('[Referral] Leaderboard failed:', err);
    return ctx.reply('⚠️ Could not load the referral leaderboard. Please try again later.');
  }
}

async function sendUserPlan(ctx: any) {
  if (!ctx.from) return;
  const dashboard = await getUserDashboard(ctx.from.id);
  if (!dashboard) return ctx.reply('⚠️ Your account is not ready yet. Please send /start again.');

  const planName = dashboard.plan === 'premium' ? '💎 Premium'
    : dashboard.plan === 'semi_premium' ? '⚡ Semi Premium'
    : '🆓 Free';

  const expiry = dashboard.plan_expires_at
    ? `\n📅 Plan expires: <b>${escapeHtml(new Date(dashboard.plan_expires_at).toLocaleString())}</b>`
    : dashboard.plan === 'premium' ? '\n📅 Plan: <b>Permanent</b>' : '';

  const bonus = dashboard.unlimited_until && new Date(dashboard.unlimited_until).getTime() > Date.now()
    ? `\n🎁 Unlimited bonus until: <b>${escapeHtml(new Date(dashboard.unlimited_until).toLocaleString())}</b>`
    : '';

  const remaining = dashboard.is_unlimited ? '∞' : String(dashboard.daily_remaining);
  const referrals = dashboard.referral_count;
  const completed = dashboard.completed_referral_count;

  const text = [
    '📊 <b>Your Dashboard</b>',
    '',
    `👤 User ID: <code>${ctx.from.id}</code>`,
    `⭐ Plan: <b>${planName}</b>`,
    `🎬 Today: <b>${remaining}</b> downloads remaining${dashboard.is_unlimited ? '' : ` / ${dashboard.daily_limit}`}`,
    `📈 Used today: <b>${dashboard.daily_used}</b>`,
    expiry,
    bonus,
    '',
    '🤝 <b>Referrals</b>',
    `👥 Invited: <b>${referrals}</b>`,
    `✅ Completed: <b>${completed}</b>`,
    '',
    '<i>A referral becomes completed only after the invited user successfully receives their first video.</i>',
  ].filter(Boolean).join('\n');

  return ctx.reply(text, {
    parse_mode: 'HTML',
    ...Markup.inlineKeyboard([
      [Markup.button.callback('🔗 Refer & Earn', 'user:referral')],
      [Markup.button.callback('🎟️ Promo Code', 'user:promo')],
      [Markup.button.callback('💎 Buy Premium', 'premium:store'), Markup.button.callback('🏆 Leaderboard', 'user:leaderboard')],
      [Markup.button.callback('🔄 Refresh', 'user:plan')],
    ]),
  });
}

async function sendReferralInfo(ctx: any) {
  if (!ctx.from) return;
  const username = await getBotUsername();
  if (!username) return ctx.reply('⚠️ Referral link is temporarily unavailable.');
  const link = `https://t.me/${username}?start=ref_${ctx.from.id}`;
  return ctx.reply(
    `🔗 <b>Refer & Earn</b>\n\nInvite a new user with your personal link. After the new user passes required membership checks and successfully receives their first video, you receive <b>1 day of unlimited video access</b>.\n\n🎬 Free: 20 videos/day\n⚡ Semi Premium: 40 videos/day\n💎 Premium: Unlimited\n\n<b>Your referral link:</b>\n<code>${escapeHtml(link)}</code>`,
    { parse_mode: 'HTML' }
  );
}

function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function handleSearchQuery(ctx: any, rawQuery: string, page = 0) {
  const pageSize = 5;
  const offset = page * pageSize;

  try {
    const { videos, total } = await searchVideos(rawQuery, pageSize, offset);

    if (videos.length === 0) {
      const msg = `❌ No videos found matching <b>${escapeHtml(rawQuery)}</b>.\n\n💡 <i>Try searching with a code (e.g. <code>ADN-001</code>, <code>ROYD-312</code>) or keyword.</i>`;
      if (ctx.callbackQuery) {
        return ctx.editMessageText(msg, { parse_mode: 'HTML' }).catch(() => ctx.reply(msg, { parse_mode: 'HTML' }));
      }
      return ctx.reply(msg, { parse_mode: 'HTML' });
    }

    const totalPages = Math.ceil(total / pageSize);

    let html = `🔍 <b>Search Results for:</b> <code>${escapeHtml(rawQuery)}</code>\n`;
    html += `📊 <b>Found:</b> ${total} video${total === 1 ? '' : 's'} · <b>Page:</b> ${page + 1}/${totalPages}\n`;
    html += `─────────────────────────\n\n`;

    const keyboardButtons: any[] = [];

    const userIsAdmin = Boolean(ctx.from && isAdmin(ctx.from.id));

    videos.forEach((v, idx) => {
      const num = offset + idx + 1;
      const displayTitle = cleanTitle(v.title, v.code);
      const truncatedTitle = displayTitle.length > 70 ? displayTitle.slice(0, 67) + '...' : displayTitle;
      const actresses = cleanActressList(v.metadata?.actresses);

      html += `<b>${num}.</b> 🏷️ <code>${escapeHtml(v.code)}</code>\n`;
      html += `📌 <i>${escapeHtml(truncatedTitle)}</i>\n`;

      if (actresses.length > 0) {
        html += `💃 <b>Cast:</b> ${escapeHtml(actresses.join(', '))}\n`;
      }

      const metaParts: string[] = [];
      if (v.metadata?.duration) {
        metaParts.push(`⏱ ${escapeHtml(v.metadata.duration)}`);
      }
      if (v.metadata?.studio) {
        metaParts.push(`🏢 ${escapeHtml(v.metadata.studio)}`);
      }
      if (metaParts.length > 0) {
        html += `ℹ️ ${metaParts.join(' · ')}\n`;
      }

      html += `\n`;

      if (userIsAdmin) {
        keyboardButtons.push([
          Markup.button.callback(`🎬 Get ${v.code}`, `download:${v.id}`),
          Markup.button.callback(`✏️ Edit`, `admin:vid:edit:${v.id}`),
          Markup.button.callback(`🗑️ Delete`, `admin:vid:del_confirm:${v.id}`),
        ]);
      } else {
        keyboardButtons.push([Markup.button.callback(`🎬 Get ${v.code}`, `download:${v.id}`)]);
      }
    });

    html += `─────────────────────────\n`;
    html += `👇 <i>Tap a button below to get the video directly:</i>`;

    // Pagination row
    const navRow: any[] = [];
    if (page > 0) {
      navRow.push(Markup.button.callback('⬅️ Prev', `search:${rawQuery}:${page - 1}`));
    }
    if (totalPages > 1) {
      navRow.push(Markup.button.callback(`📄 ${page + 1}/${totalPages}`, `search:${rawQuery}:${page}`));
    }
    if (page + 1 < totalPages) {
      navRow.push(Markup.button.callback('Next ➡️', `search:${rawQuery}:${page + 1}`));
    }

    if (navRow.length > 0) {
      keyboardButtons.push(navRow);
    }

    if (ctx.callbackQuery) {
      return ctx.editMessageText(html, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard(keyboardButtons),
      }).catch(() => {
        return ctx.reply(html, {
          parse_mode: 'HTML',
          ...Markup.inlineKeyboard(keyboardButtons),
        });
      });
    }

    return ctx.reply(html, {
      parse_mode: 'HTML',
      ...Markup.inlineKeyboard(keyboardButtons),
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return ctx.reply(`⚠️ Search error: ${errMsg}`);
  }
}

async function showForceSubAdminMenu(ctx: any) {
  const enabled = await getSetting<boolean>('force_sub_enabled', false);
  const channels = await getAllForceSubChannels();
  const lines = ['🔒 <b>Force Subscribe</b>', '', 'Global: <b>' + (enabled ? 'ON' : 'OFF') + '</b>', ''];
  if (!channels.length) lines.push('No channels configured.');
  for (const ch of channels) lines.push((ch.is_active ? '🟢' : '🔴') + ' <b>' + escapeHtml(ch.title) + '</b> — <code>' + escapeHtml(ch.channel_id) + '</code> · Request: ' + (ch.request_mode ? 'ON' : 'OFF'));
  const rows: any[] = [
    [Markup.button.callback(enabled ? '🔴 Disable Global' : '🟢 Enable Global', 'settings:forcesub:toggle')],
    [Markup.button.callback('➕ Add Channel', 'settings:forcesub:add')],
  ];
  for (const ch of channels) rows.push([
    Markup.button.callback((ch.is_active ? '🔴 Disable ' : '🟢 Enable ') + ch.title.slice(0, 14), 'settings:forcesub:toggle-channel:' + ch.id),
    Markup.button.callback(ch.request_mode ? '📨 Request: ON' : '📨 Request: OFF', 'settings:forcesub:request:' + ch.id),
  ]);
  for (const ch of channels) rows.push([
    Markup.button.callback('🗑️ Delete ' + ch.title.slice(0, 14), 'settings:forcesub:delete:' + ch.id),
  ]);
  rows.push([Markup.button.callback('⬅️ Back', 'settings:main')]);
  if (ctx.callbackQuery) return ctx.editMessageText(lines.join('\\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
  return ctx.reply(lines.join('\\n'), { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) });
}

async function showAdminSettings(ctx: any) {
  const [users, videos, jobs, deleteTimer, forceSub, maintenance] = await Promise.all([
    countUsers(), countVideos(), countJobs(),
    getSetting<number>('delete_timer_seconds', 0),
    getSetting<boolean>('force_sub_enabled', false),
    getSetting<boolean>('maintenance_mode', false),
  ]);

  const text = [
    '🛡️ <b>PIRATECULTJAV ADMIN CENTER</b>',
    '',
    '📈 <b>Quick Overview</b>',
    `👥 Users: <b>${users}</b>  ·  🎬 Videos: <b>${videos}</b>`,
    `⚙️ Jobs: <b>${jobs.queued}</b> queued · <b>${jobs.processing}</b> processing`,
    `🤖 Bot: <b>ONLINE</b> · ${activeBotRole.toUpperCase()}`,
    '',
    '🔐 <b>Access</b>',
    `🔒 Force Sub: <b>${forceSub ? 'ON' : 'OFF'}</b>`,
    `🛠️ Maintenance: <b>${maintenance ? 'ON' : 'OFF'}</b>`,
    `🗑️ Auto Delete: <b>${formatTimer(deleteTimer)}</b>`,
    '',
    'Choose an admin section:',
  ].join('\\n');

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Overview', 'admin:overview'), Markup.button.callback('👥 Users', 'admin:users')],
    [Markup.button.callback('💰 Monetization', 'admin:monetization'), Markup.button.callback('🎬 Content', 'admin:content')],
    [Markup.button.callback('📣 Broadcast', 'settings:broadcast'), Markup.button.callback('🔒 Force Sub', 'settings:forcesub')],
    [Markup.button.callback('🛠️ System', 'admin:system'), Markup.button.callback('🔄 Recovery', 'settings:recovery')],
    [Markup.button.callback('❌ Close', 'settings:close')],
  ]);

  if (ctx.callbackQuery) return ctx.editMessageText(text, { parse_mode: 'HTML', ...keyboard });
  return ctx.reply(text, { parse_mode: 'HTML', ...keyboard });
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
  if (isPollingActive) {
    console.log('[TelegramBot] Polling already active.');
    return true;
  }

  let role = availableRole(activeBotRole);
  if (!role) {
    console.log('[TelegramBot] No bot token configured. Polling not started.');
    return false;
  }

  // Validate the selected token before polling. If the primary bot was deleted/revoked,
  // automatically recover with the backup bot without touching Supabase or dump messages.
  const validateAndBuild = async (candidate: 'primary' | 'backup'): Promise<Telegraf | null> => {
    const token = tokenForRole(candidate);
    if (!token) return null;
    const candidateBot = createBot(token);
    try {
      const me = await candidateBot.telegram.getMe();
      console.log(`[TelegramBot] ${candidate.toUpperCase()} bot validated: @${me.username || me.id}`);

      // Verify the replacement bot can access the persistent dump channel.
      if (config.dumpChatId) {
        await candidateBot.telegram.getChat(config.dumpChatId);
        await candidateBot.telegram.getChatMember(config.dumpChatId, me.id);
      }
      return candidateBot;
    } catch (err: unknown) {
      const info = classifyTelegramError(err);
      console.error(`[TelegramBot] ${candidate.toUpperCase()} validation failed: ${info.message}`);
      return null;
    }
  };

  let bot = await validateAndBuild(role);
  if (!bot) {
    const fallback = role === 'primary' ? 'backup' : 'primary';
    if (!tokenForRole(fallback)) return false;
    console.warn(`[TelegramBot] Falling back from ${role} to ${fallback} bot.`);
    role = fallback;
    bot = await validateAndBuild(role);
  }

  if (!bot) {
    console.error('[TelegramBot] No configured bot could be validated. Polling not started.');
    return false;
  }

  activeBotRole = role;
  botInstance = bot;

  try {
    console.log(`[TelegramBot] Launching ${role} bot polling...`);
    bot.launch({ dropPendingUpdates: true }).catch(err => {
      console.error('[TelegramBot] Polling error:', err?.message || err);
      isPollingActive = false;
    });
    isPollingActive = true;
    console.log(`[TelegramBot] ${role.toUpperCase()} bot polling started successfully.`);
    return true;
  } catch (err: unknown) {
    console.error('[TelegramBot] Failed to launch bot:', err);
    isPollingActive = false;
    botInstance = null;
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