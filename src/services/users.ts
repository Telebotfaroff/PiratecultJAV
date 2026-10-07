import { getSupabase } from '../database/supabase.ts';

export interface UserRecord {
  id: string;
  telegram_user_id: number;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  is_blocked: boolean;
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
