import { Telegraf } from 'telegraf';
import { getSupabase } from '../database/supabase.ts';
import { isAdmin } from '../config.ts';

export interface ForceSubChannel {
  id: string;
  channel_id: string;
  title: string;
  invite_link: string | null;
  is_active: boolean;
}

export interface ForceSubCheckResult {
  passed: boolean;
  missingChannels: ForceSubChannel[];
}

export async function getActiveForceSubChannels(): Promise<ForceSubChannel[]> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('force_sub_channels')
      .select('*')
      .eq('is_active', true);

    if (error) {
      console.warn('Error fetching force-sub channels:', error.message);
      return [];
    }

    return (data as ForceSubChannel[]) || [];
  } catch {
    return [];
  }
}

export async function isForceSubGloballyEnabled(): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('bot_settings')
      .select('value')
      .eq('key', 'force_sub_enabled')
      .maybeSingle();

    if (error || !data) return false;
    return Boolean(data.value);
  } catch {
    return false;
  }
}

export async function checkUserForceSub(
  bot: Telegraf,
  userId: number
): Promise<ForceSubCheckResult> {
  // Admins bypass force-sub check automatically
  if (isAdmin(userId)) {
    return { passed: true, missingChannels: [] };
  }

  const enabled = await isForceSubGloballyEnabled();
  if (!enabled) {
    return { passed: true, missingChannels: [] };
  }

  const channels = await getActiveForceSubChannels();
  if (channels.length === 0) {
    return { passed: true, missingChannels: [] };
  }

  const missing: ForceSubChannel[] = [];

  for (const ch of channels) {
    try {
      const member = await bot.telegram.getChatMember(ch.channel_id, userId);
      const isMember = ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
      if (!isMember) {
        missing.push(ch);
      }
    } catch (err) {
      console.warn(`Could not verify membership for user ${userId} in channel ${ch.channel_id}:`, err);
      // If bot cannot check (e.g. not admin in that channel), do not block user
    }
  }

  return {
    passed: missing.length === 0,
    missingChannels: missing,
  };
}
