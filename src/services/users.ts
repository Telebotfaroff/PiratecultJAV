import { getSupabase } from '../database/supabase.ts';

export interface UserRecord {
  id: string;
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_blocked: boolean;
  plan: 'free' | 'semi_premium' | 'premium';
  daily_download_count: number;
  daily_download_date: string;
  unlimited_until: string | null;
  referred_by: number | null;
  referral_reward_claimed: boolean;
  created_at?: string;
  updated_at?: string;
}

export async function upsertUser(user: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}): Promise<UserRecord | null> {
  try {
    const supabase = getSupabase();
    const payload = {
      telegram_user_id: user.id,
      username: user.username || null,
      first_name: user.first_name || null,
      last_name: user.last_name || null,
      updated_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from('users')
      .upsert(payload, { onConflict: 'telegram_user_id' })
      .select()
      .maybeSingle();

    if (error) {
      console.warn('Error upserting user:', error.message);
      return null;
    }

    return data as UserRecord;
  } catch {
    return null;
  }
}

export async function isUserBlocked(telegramUserId: number): Promise<boolean> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('users')
      .select('is_blocked')
      .eq('telegram_user_id', telegramUserId)
      .maybeSingle();

    if (error || !data) return false;
    return Boolean(data.is_blocked);
  } catch {
    return false;
  }
}

export async function setUserBlocked(telegramUserId: number, isBlocked: boolean): Promise<boolean> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('users')
    .update({ is_blocked: isBlocked, updated_at: new Date().toISOString() })
    .eq('telegram_user_id', telegramUserId);

  if (error) {
    throw new Error(`Failed updating blocked status: ${error.message}`);
  }

  return true;
}

export async function countUsers(): Promise<number> {
  try {
    const supabase = getSupabase();
    const { count, error } = await supabase
      .from('users')
      .select('*', { count: 'exact', head: true });

    if (error) return 0;
    return count || 0;
  } catch {
    return 0;
  }
}


export async function getBroadcastUserIds(): Promise<number[]> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('users')
    .select('telegram_user_id')
    .eq('is_blocked', false);
  if (error) throw new Error(`Failed loading broadcast recipients: ${error.message}`);
  return (data || []).map(row => Number(row.telegram_user_id)).filter(Number.isFinite);
}


export interface DownloadAllowance {
  allowed: boolean;
  remaining: number;
  plan: 'free' | 'semi_premium' | 'premium';
  unlimited_until: string | null;
}

export async function getUser(telegramUserId: number): Promise<UserRecord | null> {
  const supabase = getSupabase();
  const { data, error } = await supabase.from('users').select('*')
    .eq('telegram_user_id', telegramUserId).maybeSingle();
  if (error || !data) return null;
  return data as UserRecord;
}

export async function consumeVideoDownload(telegramUserId: number): Promise<DownloadAllowance> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('consume_video_download', { p_user_id: telegramUserId });
  if (error) {
    if (error.message.includes('Could not find the function') || error.code === 'PGRST202' || error.message.includes('schema cache')) {
      // Graceful fallback if migration 005 has not been executed on Supabase yet
      return {
        allowed: true,
        remaining: 20,
        plan: 'free',
        unlimited_until: null,
      };
    }
    throw new Error(`Failed checking download allowance: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return {
    allowed: Boolean(row?.allowed),
    remaining: Number(row?.remaining ?? 0),
    plan: (row?.plan || 'free') as DownloadAllowance['plan'],
    unlimited_until: row?.unlimited_until || null,
  };
}

export async function registerReferral(referrerId: number, referredId: number): Promise<{ success: boolean; unlimited_until: string | null }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('register_referral', {
    p_referrer: referrerId,
    p_referred: referredId,
  });
  if (error) {
    if (error.message.includes('Could not find the function') || error.code === 'PGRST202' || error.message.includes('schema cache')) {
      return { success: false, unlimited_until: null };
    }
    throw new Error(`Failed registering referral: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { success: Boolean(row?.success), unlimited_until: row?.unlimited_until || null };
}

export async function completeReferral(referredId: number): Promise<{ success: boolean; unlimited_until: string | null }> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('complete_referral', {
    p_referred: referredId,
  });
  if (error) {
    if (error.message.includes('Could not find the function') || error.code === 'PGRST202' || error.message.includes('schema cache')) {
      return { success: false, unlimited_until: null };
    }
    throw new Error(`Failed completing referral: ${error.message}`);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return { success: Boolean(row?.success), unlimited_until: row?.unlimited_until || null };
}

export async function setUserPlan(telegramUserId: number, plan: 'free' | 'semi_premium' | 'premium'): Promise<boolean> {
  const supabase = getSupabase();
  const { data, error } = await supabase.rpc('set_user_plan', {
    p_user_id: telegramUserId,
    p_plan: plan,
  });
  if (error) {
    if (error.message.includes('Could not find the function') || error.code === 'PGRST202' || error.message.includes('schema cache')) {
      // Fallback: direct column update if column exists, else return false
      const { error: updateError } = await supabase
        .from('users')
        .update({ plan, updated_at: new Date().toISOString() })
        .eq('telegram_user_id', telegramUserId);
      return !updateError;
    }
    throw new Error(`Failed setting user plan: ${error.message}`);
  }
  return Boolean(data);
}
