import { Telegraf } from 'telegraf';
import { botDeps } from '../deps.ts';
const {
  Markup, config, isAdmin, normalizeCode, extractCodes, cleanActressList, cleanTitle,
  searchVideos, getVideoById, getVideoByCode, upsertVideoFromProvider, countVideos, updateVideoMetadata, deleteVideo, updateVideoStatus,
  createIndexJob, countJobs, getRecentJobs, retryJob,
  upsertUser, isUserBlocked, setUserBlocked, countUsers, getBroadcastUserIds, getUser, getUserDashboard, getReferralLeaderboard,
  redeemPromoCode, createPromoCode, listPremiumPayments, listPromoCodes, setPromoCodeActive, completeStarPremiumPayment,
  consumeVideoDownload, refundVideoDownload, getDownloadQuotaSettings, setDownloadQuotaSettings, registerReferral, completeReferral, setUserPlan,
  checkUserForceSub, getAllForceSubChannels, upsertForceSubChannel, updateForceSubChannel, deleteForceSubChannel, createForceSubInviteLink,
  getAdminSession, setAdminSession, clearAdminSession, javtifulProvider, sendDumpVideoToUser, storeThumbnailInDumpChannel,
  installMessageDeleteTimer, getSetting, setSetting, classifyTelegramError, withTelegramRetry, recordVideoDeliveryEvent, getVideoDeliveryAnalytics,
  deliverVideoToUser, showAdminVideoEditMenu, sendReferralLeaderboard, sendUserPlan, sendReferralInfo, escapeHtml, handleSearchQuery,
  showForceSubAdminMenu, showAdminSettings, formatTimer, PREMIUM_PACKAGES, parsePremiumPayload, sendPremiumStore, sendPremiumInvoice,
} = botDeps;

export function registerPaymentEvents(bot: Telegraf) {
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
}
