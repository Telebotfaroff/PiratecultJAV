import { getSupabase } from '../database/supabase.ts';

export interface AdminSession {
  admin_id: number;
  action: string;
  step: string;
  payload: Record<string, unknown>;
}

export async function getAdminSession(adminId: number): Promise<AdminSession | null> {
  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('admin_sessions')
      .select('*')
      .eq('telegram_user_id', adminId)
      .maybeSingle();

    if (error || !data) return null;

    const metadata = (data.metadata as Record<string, unknown>) || {};
    const stateParts = (data.state || '').split(':');
    const actionFromState = stateParts[0] || 'post';
    const stepFromState = stateParts[1] || data.state;

    return {
      admin_id: Number(data.telegram_user_id),
      action: (metadata.action as string) || actionFromState,
      step: (metadata.step as string) || stepFromState,
      payload: (metadata.payload as Record<string, unknown>) || metadata,
    };
  } catch {
    return null;
  }
}

export async function setAdminSession(
  adminId: number,
  action: string,
  step: string,
  payload: Record<string, unknown> = {}
): Promise<void> {
  const supabase = getSupabase();
  const state = `${action}:${step}`;
  const metadata = {
    action,
    step,
    payload,
  };

  const { error } = await supabase
    .from('admin_sessions')
    .upsert(
      {
        telegram_user_id: adminId,
        state,
        metadata,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'telegram_user_id' }
    );

  if (error) {
    throw new Error(`Failed setting admin session: ${error.message}`);
  }
}

export async function clearAdminSession(adminId: number): Promise<void> {
  try {
    const supabase = getSupabase();
    await supabase.from('admin_sessions').delete().eq('telegram_user_id', adminId);
  } catch (err) {
    console.warn(`Failed clearing admin session for ${adminId}:`, err);
  }
}
