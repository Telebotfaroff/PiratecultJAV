import dotenv from 'dotenv';
dotenv.config();

export interface AppConfig {
  botToken: string;
  supabaseUrl: string;
  supabaseSecretKey: string;
  dumpChatId: string;
  adminIds: number[];
  javtifulBaseUrl: string;
  port: number;
}

const rawAdminIds = process.env.ADMIN_IDS || '';
const adminIds: number[] = rawAdminIds
  .split(',')
  .map(id => id.trim())
  .filter(Boolean)
  .map(id => parseInt(id, 10))
  .filter(id => !isNaN(id));

export const config: AppConfig = {
  botToken: process.env.BOT_TOKEN || '',
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY || '',
  dumpChatId: process.env.DUMP_CHAT_ID || '-1004426377644',
  adminIds,
  javtifulBaseUrl: (process.env.JAVTIFUL_BASE_URL || 'https://javtiful.com').replace(/\/$/, ''),
  port: parseInt(process.env.PORT || '3000', 10),
};

export function isAdmin(telegramUserId: number | undefined): boolean {
  if (!telegramUserId) return false;
  return config.adminIds.includes(telegramUserId);
}

export interface ConfigValidationResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
}

export function validateConfig(): ConfigValidationResult {
  const missing: string[] = [];
  const warnings: string[] = [];

  if (!config.supabaseUrl) {
    missing.push('SUPABASE_URL');
  }
  if (!config.supabaseSecretKey) {
    missing.push('SUPABASE_SECRET_KEY');
  }
  if (!config.botToken) {
    warnings.push('BOT_TOKEN (Telegram bot polling disabled until provided)');
  }
  if (config.adminIds.length === 0) {
    warnings.push('ADMIN_IDS (No admin IDs configured)');
  }
  if (!config.dumpChatId) {
    warnings.push('DUMP_CHAT_ID (Defaulting to -1004426377644)');
  }

  return {
    valid: missing.length === 0,
    missing,
    warnings,
  };
}
