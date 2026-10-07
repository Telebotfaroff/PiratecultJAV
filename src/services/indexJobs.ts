import { getSupabase } from '../database/supabase.ts';
import { normalizeCode } from './code.ts';

export interface IndexJob {
  id: number;
  code: string;
  dump_chat_id: string;
  video_message_id: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  error: string | null;
  created_at?: string;
  updated_at?: string;
  next_attempt_at?: string | null;
}

export interface CreateJobParams {
  code: string;
  dumpChatId: string;
  videoMessageId: number;
}

export interface CreateJobResult {
  created: boolean;
  job: IndexJob;
  reason?: string;
}

/**
 * Creates an index job with strict duplicate prevention.
 * The unique identity of a dump-channel media item is (dump_chat_id + video_message_id).
 */
export async function createIndexJob(params: CreateJobParams): Promise<CreateJobResult> {
  const supabase = getSupabase();
  const normalized = normalizeCode(params.code) || params.code.trim().toUpperCase();

  // 1. Strict duplicate check by unique Telegram media identity
  const { data: existing, error: checkError } = await supabase
    .from('index_jobs')
    .select('*')
    .eq('dump_chat_id', String(params.dumpChatId))
    .eq('video_message_id', params.videoMessageId)
    .maybeSingle();

  if (checkError) {
    throw new Error(`Failed checking existing index jobs: ${checkError.message}`);
  }

  if (existing) {
    return {
      created: false,
      job: existing as IndexJob,
      reason: `Telegram media (${params.dumpChatId}:${params.videoMessageId}) is already tracked with status: ${existing.status}`,
    };
  }

  // 2. Insert new queued job
  const { data, error } = await supabase
    .from('index_jobs')
    .insert({
      code: normalized,
      dump_chat_id: String(params.dumpChatId),
      video_message_id: params.videoMessageId,
      status: 'queued',
      attempts: 0,
      error: null,
      next_attempt_at: null,
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    // If concurrent insert occurred and hit the UNIQUE constraint
    if (error.code === '23505' || error.message.includes('unique')) {
      const { data: dup } = await supabase
        .from('index_jobs')
        .select('*')
        .eq('dump_chat_id', String(params.dumpChatId))
        .eq('video_message_id', params.videoMessageId)
        .single();
      return {
        created: false,
        job: dup as IndexJob,
        reason: 'Duplicate prevented by unique constraint',
      };
    }
    throw new Error(`Failed creating index job: ${error.message}`);
  }

  return {
    created: true,
    job: data as IndexJob,
  };
}

/**
 * Atomically claims the next queued job using FOR UPDATE SKIP LOCKED.
 * If RPC 'claim_next_index_job' is available, invokes it.
 * Otherwise uses safe single-step fallback.
 */
export async function claimNextJob(): Promise<IndexJob | null> {
  const supabase = getSupabase();

  try {
    // Attempt stored procedure first (safest for concurrent instances)
    const { data: rpcData, error: rpcError } = await supabase.rpc('claim_next_index_job');
    if (!rpcError && rpcData && rpcData.length > 0) {
      return rpcData[0] as IndexJob;
    }
  } catch {
    // Fall back to client-side atomic step if RPC not yet run in SQL editor
  }

  // Fallback: Find oldest queued job
  const { data: queued, error: fetchError } = await supabase
    .from('index_jobs')
    .select('*')
    .eq('status', 'queued')
    .or('next_attempt_at.is.null,next_attempt_at.lte.' + new Date().toISOString())
    .order('id', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (fetchError || !queued) {
    return null;
  }

  // Atomically transition status from queued -> processing
  const { data: claimed, error: updateError } = await supabase
    .from('index_jobs')
    .update({
      status: 'processing',
      next_attempt_at: null,
      attempts: (queued.attempts || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', queued.id)
    .eq('status', 'queued') // Optimistic locking guard
    .select()
    .maybeSingle();

  if (updateError || !claimed) {
    return null; // Another worker won the race
  }

  return claimed as IndexJob;
}

export async function updateJobStatus(
  jobId: number,
  status: 'queued' | 'processing' | 'completed' | 'failed',
  errorMessage: string | null = null,
  nextAttemptAt: string | null = null
): Promise<void> {
  const supabase = getSupabase();

  const { error } = await supabase
    .from('index_jobs')
    .update({
      status,
      error: errorMessage,
      next_attempt_at: nextAttemptAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId);

  if (error) {
    throw new Error(`Failed updating job ${jobId} status: ${error.message}`);
  }
}

export async function retryJob(jobId: number): Promise<IndexJob> {
  const supabase = getSupabase();

  const { data, error } = await supabase
    .from('index_jobs')
    .update({
      status: 'queued',
      error: null,
      next_attempt_at: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', jobId)
    .select()
    .single();

  if (error) {
    throw new Error(`Failed resetting job for retry: ${error.message}`);
  }

  return data as IndexJob;
}

export async function getRecentJobs(statusFilter?: string, limit = 50): Promise<IndexJob[]> {
  const supabase = getSupabase();

  let query = supabase.from('index_jobs').select('*');
  if (statusFilter && statusFilter !== 'all') {
    query = query.eq('status', statusFilter);
  }

  const { data, error } = await query
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`Failed fetching index jobs: ${error.message}`);
  }

  return (data as IndexJob[]) || [];
}

export async function countJobs(): Promise<{ queued: number; processing: number; completed: number; failed: number; total: number }> {
  const supabase = getSupabase();
  const { data, error } = await supabase
    .from('index_jobs')
    .select('status');

  if (error || !data) {
    return { queued: 0, processing: 0, completed: 0, failed: 0, total: 0 };
  }

  const counts = { queued: 0, processing: 0, completed: 0, failed: 0, total: data.length };
  for (const row of data) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts]++;
    }
  }

  return counts;
}


/** Requeues jobs left in processing after a server crash or hard restart. */
export async function recoverStaleJobs(staleAfterMs = 15 * 60 * 1000): Promise<number> {
  const supabase = getSupabase();
  const cutoff = new Date(Date.now() - staleAfterMs).toISOString();

  const { data, error } = await supabase
    .from('index_jobs')
    .update({
      status: 'queued',
      error: 'Recovered stale processing job after worker restart/timeout',
      next_attempt_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('status', 'processing')
    .lt('updated_at', cutoff)
    .select('id');

  if (error) {
    throw new Error(`Failed recovering stale jobs: ${error.message}`);
  }

  return data?.length || 0;
}
