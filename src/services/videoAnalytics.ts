import { getSupabase } from '../database/supabase.ts';

export type VideoDeliveryEventType =
  | 'attempt'
  | 'delivered'
  | 'force_sub_block'
  | 'limit_block'
  | 'not_found'
  | 'unavailable'
  | 'delivery_failed';

export async function recordVideoDeliveryEvent(params: {
  eventType: VideoDeliveryEventType;
  telegramUserId?: number | null;
  videoId?: number | null;
  code?: string | null;
  source?: 'deep_link' | 'search' | 'callback' | 'unknown';
  success?: boolean;
  errorMessage?: string | null;
}): Promise<void> {
  try {
    const { error } = await getSupabase().from('video_delivery_events').insert({
      event_type: params.eventType,
      telegram_user_id: params.telegramUserId ?? null,
      video_id: params.videoId ?? null,
      code: params.code ?? null,
      source: params.source ?? 'unknown',
      success: Boolean(params.success),
      error_message: params.errorMessage?.slice(0, 500) || null,
    });
    if (error) console.warn('[Analytics] Failed to record event:', error.message);
  } catch (error) {
    console.warn('[Analytics] Failed to record event:', error instanceof Error ? error.message : String(error));
  }
}

export async function getVideoDeliveryAnalytics(hours = 24): Promise<{
  attempts: number;
  delivered: number;
  forceSubBlocks: number;
  limitBlocks: number;
  failures: number;
  uniqueUsers: number;
  topVideos: Array<{ code: string; deliveries: number }>;
}> {
  const since = new Date(Date.now() - Math.max(1, hours) * 60 * 60 * 1000).toISOString();
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('video_delivery_events')
    .select('event_type, telegram_user_id, code')
    .gte('created_at', since);

  if (error) throw new Error('Failed fetching delivery analytics: ' + error.message);

  const rows = (data || []) as Array<{
    event_type: VideoDeliveryEventType;
    telegram_user_id: number | null;
    code: string | null;
  }>;

  const uniqueUsers = new Set(rows.map(row => row.telegram_user_id).filter((id): id is number => id !== null)).size;
  const topMap = new Map<string, number>();

  for (const row of rows) {
    if (row.event_type === 'delivered' && row.code) {
      topMap.set(row.code, (topMap.get(row.code) || 0) + 1);
    }
  }

  const topVideos = [...topMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, deliveries]) => ({ code, deliveries }));

  return {
    attempts: rows.filter(row => row.event_type === 'attempt').length,
    delivered: rows.filter(row => row.event_type === 'delivered').length,
    forceSubBlocks: rows.filter(row => row.event_type === 'force_sub_block').length,
    limitBlocks: rows.filter(row => row.event_type === 'limit_block').length,
    failures: rows.filter(row => row.event_type === 'delivery_failed').length,
    uniqueUsers,
    topVideos,
  };
}
