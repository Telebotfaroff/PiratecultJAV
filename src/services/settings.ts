import { getSupabase } from '../database/supabase.ts';

export async function getSetting<T = unknown>(key: string, defaultValue: T): Promise<T> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('bot_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error || !data) return defaultValue;
    return (data.value as T) ?? defaultValue;
  } catch {
    return defaultValue;
  }
}

export async function setSetting<T = unknown>(key: string, value: T): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('bot_settings')
    .upsert(
      { key, value: value as Record<string, unknown>, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    );

  if (error) {
    throw new Error(`Failed saving setting ${key}: ${error.message}`);
  }
}

export async function getAllSettings(): Promise<Record<string, unknown>> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase.from('bot_settings').select('*');
    if (error || !data) return {};

    const settingsMap: Record<string, unknown> = {};
    for (const item of data) {
      settingsMap[item.key] = item.value;
    }
    return settingsMap;
  } catch {
    return {};
  }
}
