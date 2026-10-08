import { Markup } from 'telegraf';
import { config } from '../config.ts';

export const PREMIUM_PACKAGES = [
  { days: 7, stars: config.premium7Stars, label: '7 Days' },
  { days: 30, stars: config.premium30Stars, label: '30 Days' },
  { days: 90, stars: config.premium90Stars, label: '90 Days' },
] as const;

export function parsePremiumPayload(payload: string): { days: number; stars: number; userId: number } | null {
  const match = /^premium:(\d+):(\d+):(\d+)$/.exec(payload);
  if (!match) return null;
  const days = Number(match[1]);
  const stars = Number(match[2]);
  const userId = Number(match[3]);
  const pkg = PREMIUM_PACKAGES.find(item => item.days === days && item.stars === stars);
  if (!pkg || !Number.isSafeInteger(userId)) return null;
  return { days, stars, userId };
}

export async function sendPremiumStore(ctx: any) {
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

export async function sendPremiumInvoice(ctx: any, days: number) {
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
