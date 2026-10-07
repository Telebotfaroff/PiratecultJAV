import { getSupabase } from '../database/supabase.ts';

export interface ForceSubAdminSession {
  admin_id: number;
  step: string;
  data: Record<string, unknown>;
}

export async function getForceSubAdminSession(adminId: number): Promise<ForceSubAdminSession | null> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('force_sub_admin_sessions')
      .select('*')
      .eq('telegram_user_id', adminId)
      .maybeSingle();

    if (error || !data) return null;

    const metadata = (data.metadata as Record<string, unknown>) || {};
    return {
      admin_id: Number(data.telegram_user_id),
      step: data.state || (metadata.step as string) || '',
      data: metadata,
    };
  } catch {
    return null;
  }
}

export async function setForceSubAdminSession(
  adminId: number,
  step: string,
  data: Record<string, unknown> = {}
): Promise<void> {
  const supabase = getSupabase();
  const { error } = await supabase
    .from('force_sub_admin_sessions')
    .upsert(
      {
        telegram_user_id: adminId,
        state: step,
        metadata: data,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_user_id' }
    );

  if (error) {
    throw new Error(`Failed saving force-sub session: ${error.message}`);
  }
}

export async function clearForceSubAdminSession(adminId: number): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.from('force_sub_admin_sessions').delete().eq('telegram_user_id', adminId);
  } catch (err) {
    console.warn(`Failed clearing force-sub session for ${adminId}:`, err);
  }
}
