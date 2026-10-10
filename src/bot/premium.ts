import { Markup } from 'telegraf';
import { config } from '../config.ts';
import { getSetting, setSetting } from '../services/settings.ts';

export interface PremiumPackage {
  days: number;
  stars: number;
  label: string;
  active: boolean;
}

const DEFAULT_PREMIUM_PACKAGES: PremiumPackage[] = [
  { days: 7, stars: config.premium7Stars, label: '7 Days', active: true },
  { days: 30, stars: config.premium30Stars, label: '30 Days', active: true },
  { days: 90, stars: config.premium90Stars, label: '90 Days', active: true },
];

function validatePackage(input: unknown): input is PremiumPackage {
  if (!input || typeof input !== 'object') return false;
  const item = input as Partial<PremiumPackage>;
  return Number.isInteger(item.days) && Number(item.days) >= 1 && Number(item.days) <= 3650
    && Number.isSafeInteger(item.stars) && Number(item.stars) >= 1 && Number(item.stars) <= 1000000
    && typeof item.label === 'string' && item.label.trim().length >= 1 && item.label.trim().length <= 32
    && typeof item.active === 'boolean';
}

/** Admin-editable package list stored in Supabase bot_settings. */
export async function getPremiumPackages(includeInactive = false): Promise<PremiumPackage[]> {
  const saved = await getSetting<unknown>('premium_packages', null);
  let packages: PremiumPackage[] = DEFAULT_PREMIUM_PACKAGES;
  if (Array.isArray(saved) && saved.every(validatePackage)) {
    packages = saved.map(item => ({ ...item, label: item.label.trim() }));
  }
  return packages
    .filter(item => includeInactive || item.active)
    .sort((a, b) => a.days - b.days);
}

export async function savePremiumPackage(input: PremiumPackage, previousDays?: number): Promise<void> {
  if (!validatePackage(input)) {
    throw new Error('Days must be 1–3650, Stars must be 1–1,000,000, and label must be 1–32 characters.');
  }
  const packages = await getPremiumPackages(true);
  const previous = previousDays === undefined ? undefined : packages.find(item => item.days === previousDays);
  const collision = packages.some(item => item.days === input.days && item.days !== previousDays);
  if (collision) throw new Error('A package with that duration already exists.');
  const next = packages.filter(item => item.days !== previousDays && item.days !== input.days);
  next.push({ ...input, active: previous ? previous.active : input.active, label: input.label.trim() });
  await setSetting('premium_packages', next.sort((a, b) => a.days - b.days));
}

export async function removePremiumPackage(days: number): Promise<boolean> {
  const packages = await getPremiumPackages(true);
  const next = packages.filter(item => item.days !== days);
  if (next.length === packages.length) return false;
  if (next.length === 0) throw new Error('Keep at least one Premium package available.');
  await setSetting('premium_packages', next);
  return true;
}

export async function togglePremiumPackage(days: number): Promise<boolean> {
  const packages = await getPremiumPackages(true);
  const item = packages.find(pkg => pkg.days === days);
  if (!item) return false;
  if (item.active && packages.filter(pkg => pkg.active).length <= 1) {
    throw new Error('Keep at least one package active.');
  }
  item.active = !item.active;
  await setSetting('premium_packages', packages);
  return true;
}

export function parsePremiumPayload(payload: string): { days: number; stars: number; userId: number } | null {
  const match = /^premium:(\d+):(\d+):(\d+)$/.exec(payload);
  if (!match) return null;
  const days = Number(match[1]);
  const stars = Number(match[2]);
  const userId = Number(match[3]);
  if (!Number.isInteger(days) || days < 1 || days > 3650 ||
      !Number.isSafeInteger(stars) || stars < 1 || stars > 1000000 ||
      !Number.isSafeInteger(userId) || userId < 1) return null;
  return { days, stars, userId };
}

export async function sendPremiumStore(ctx: any) {
  if (!ctx.from) return;
  const packages = await getPremiumPackages();
  if (!packages.length) {
    return ctx.reply('💎 Premium packages are temporarily unavailable. Please contact an admin.');
  }
  const rows = packages.map(pkg => [
    Markup.button.callback(`💎 ${pkg.label} — ${pkg.stars} ⭐`, `premium:buy:${pkg.days}`),
  ]);
  rows.push([Markup.button.callback('⬅️ My Dashboard', 'user:plan')]);
  return ctx.reply(
    '💎 <b>Premium Access</b>\n\nPremium gives you unlimited video downloads for the selected period.\n\nChoose a package:',
    { parse_mode: 'HTML', ...Markup.inlineKeyboard(rows) },
  );
}

export async function sendPremiumInvoice(ctx: any, days: number) {
  if (!ctx.from) return;
  const pkg = (await getPremiumPackages()).find(item => item.days === days);
  if (!pkg) return ctx.reply('❌ This Premium package is no longer available. Open /premium to see current options.');

  const payload = `premium:${pkg.days}:${pkg.stars}:${ctx.from.id}`;
  return ctx.replyWithInvoice({
    title: `Premium — ${pkg.label}`,
    description: `Unlimited video access for ${pkg.days} days.`,
    payload,
    currency: 'XTR',
    prices: [{ label: `Premium ${pkg.days} days`, amount: pkg.stars }],
  });
}
