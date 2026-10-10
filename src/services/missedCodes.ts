import { getSupabase } from '../database/supabase.ts';
import { normalizeCode } from './code.ts';

export interface MissedCodeRecord {
  id: string;
  code: string;
  normalized_code: string;
  failure_reason: string | null;
  created_at: string;
}

export async function recordMissedCode(code: string, failureReason?: string): Promise<void> {
  const normalized = normalizeCode(code) || code.trim().toUpperCase();
  const { error } = await getSupabase()
    .from('missed_metadata_codes')
    .upsert({
      code: code.trim().toUpperCase(),
      normalized_code: normalized,
      failure_reason: (failureReason || 'Provider returned no metadata').slice(0, 1000),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'normalized_code' });
  if (error) throw new Error('Could not save missed code: ' + error.message);
}

export async function listMissedCodes(limit = 20, offset = 0): Promise<{ codes: MissedCodeRecord[]; total: number }> {
  const safeLimit = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
  const safeOffset = Math.max(Math.floor(offset) || 0, 0);
  const { data, count, error } = await getSupabase()
    .from('missed_metadata_codes')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(safeOffset, safeOffset + safeLimit - 1);
  if (error) throw new Error('Could not list missed codes: ' + error.message);
  return { codes: (data || []) as MissedCodeRecord[], total: count || 0 };
}

export async function removeMissedCode(code: string): Promise<void> {
  const normalized = normalizeCode(code) || code.trim().toUpperCase();
  const { error } = await getSupabase().from('missed_metadata_codes').delete().eq('normalized_code', normalized);
  if (error) throw new Error('Could not remove missed code: ' + error.message);
}
