import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { config } from '../config.ts';

let supabaseClient: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  if (!config.supabaseUrl || !config.supabaseSecretKey) {
    throw new Error(
      'Supabase connection failed: Missing SUPABASE_URL or SUPABASE_SECRET_KEY. Please provide valid credentials.'
    );
  }

  supabaseClient = createClient(config.supabaseUrl, config.supabaseSecretKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return supabaseClient;
}

export interface ConnectionStatus {
  connected: boolean;
  configured: boolean;
  latencyMs?: number;
  error?: string;
  url?: string;
}

export async function checkSupabaseConnection(): Promise<ConnectionStatus> {
  if (!config.supabaseUrl || !config.supabaseSecretKey) {
    return {
      connected: false,
      configured: false,
      error: 'SUPABASE_URL or SUPABASE_SECRET_KEY not set in environment.',
      url: config.supabaseUrl || undefined,
    };
  }

  const start = Date.now();
  try {
    const client = getSupabase();
    // Query bot_settings or schema info to verify access
    const { error } = await client.from('bot_settings').select('key').limit(1);
    const latency = Date.now() - start;

    if (error) {
      return {
        connected: false,
        configured: true,
        latencyMs: latency,
        error: error.message || 'Error querying database schema',
        url: config.supabaseUrl,
      };
    }

    return {
      connected: true,
      configured: true,
      latencyMs: latency,
      url: config.supabaseUrl,
    };
  } catch (err: unknown) {
    return {
      connected: false,
      configured: true,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
      url: config.supabaseUrl,
    };
  }
}
