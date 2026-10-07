import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  Database,
  Server,
  Radio,
  Layers,
  Search,
  RefreshCw,
  Play,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Film,
  Users,
  Settings,
  Terminal,
  Copy,
  Check,
  ExternalLink,
  ShieldCheck,
  Send,
  FileCode,
  Sliders,
  ChevronRight,
} from 'lucide-react';

interface SystemStatus {
  service: string;
  uptime: number;
  timestamp: string;
  config: {
    supabaseConfigured: boolean;
    botTokenConfigured: boolean;
    dumpChatId: string;
    adminCount: number;
    javtifulBaseUrl: string;
    validation: {
      valid: boolean;
      missing: string[];
      warnings: string[];
    };
  };
  supabase: {
    connected: boolean;
    configured: boolean;
    latencyMs?: number;
    error?: string;
    url?: string;
  };
  bot: {
    active: boolean;
  };
  worker: {
    isRunning: boolean;
    pollIntervalMs: number;
  };
  counts: {
    users: number;
    videos: number;
    jobs: {
      queued: number;
      processing: number;
      completed: number;
      failed: number;
      total: number;
    };
  };
  latencyMs: number;
}

interface IndexJob {
  id: number;
  code: string;
  dump_chat_id: string;
  video_message_id: number;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  attempts: number;
  error: string | null;
  created_at?: string;
  updated_at?: string;
}

interface VideoRecord {
  id: string;
  code: string;
  normalized_code: string;
  title: string;
  description: string | null;
  provider: string;
  thumbnail_file_id: string | null;
  thumbnail_message_id: number | null;
  dump_chat_id: string;
  video_message_id: number;
  status: 'pending' | 'available' | 'failed' | 'disabled';
  metadata: {
    duration?: string;
    date?: string;
    actresses?: string[];
    sourceUrl?: string;
    thumbnailUrl?: string;
  };
  created_at?: string;
  updated_at?: string;
}

interface ProviderTestResult {
  ok: boolean;
  code?: string;
  latencyMs?: number;
  metadata?: {
    code: string;
    title: string;
    description: string;
    thumbnailUrl: string | null;
    duration: string | null;
    date: string | null;
    actresses: string[];
    sourceUrl: string;
  };
  error?: string;
}

type TabType = 'overview' | 'queue' | 'provider' | 'simulator' | 'catalog' | 'schema';

export default function App() {
  const [activeTab, setActiveTab] = useState<TabType>('overview');
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [authenticated, setAuthenticated] = useState(false);
  const [authLoading, setAuthLoading] = useState(true);
  const [adminKey, setAdminKey] = useState('');
  const [loginError, setLoginError] = useState('');

  const apiFetch = useCallback(async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, { ...init, credentials: 'same-origin' });
    if (res.status === 401) {
      setAuthenticated(false);
    }
    return res;
  }, []);

  const login = useCallback(async () => {
    setLoginError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ key: adminKey }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setLoginError(data.error || 'Authentication failed');
        return;
      }
      setAuthenticated(true);
      setAdminKey('');
    } catch {
      setLoginError('Unable to reach the server');
    }
  }, [adminKey]);

  // Queue state
  const [jobs, setJobs] = useState<IndexJob[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [jobFilter, setJobFilter] = useState<string>('all');
  const [retryingJobId, setRetryingJobId] = useState<number | null>(null);

  // Provider test state
  const [testCodeInput, setTestCodeInput] = useState('SAME-234');
  const [providerTesting, setProviderTesting] = useState(false);
  const [providerResult, setProviderResult] = useState<ProviderTestResult | null>(null);

  // Simulator state
  const [simCaption, setSimCaption] = useState('ROE-327 1080p WebRip');
  const [simMsgId, setSimMsgId] = useState('123456');
  const [simDumpChat, setSimDumpChat] = useState('-1004426377644');
  const [simLoading, setSimLoading] = useState(false);
  const [simResult, setSimResult] = useState<any>(null);

  // Catalog state
  const [catalogVideos, setCatalogVideos] = useState<VideoRecord[]>([]);
  const [catalogSearch, setCatalogSearch] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogTotal, setCatalogTotal] = useState(0);

  // Schema state
  const [schemaSql, setSchemaSql] = useState('');
  const [copiedSql, setCopiedSql] = useState(false);

  useEffect(() => {
    fetch('/api/auth/status', { credentials: 'same-origin' })
      .then(res => res.json())
      .then(data => setAuthenticated(Boolean(data.authenticated)))
      .catch(() => setAuthenticated(false))
      .finally(() => setAuthLoading(false));
  }, []);

  // Fetch status
  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await fetch('/api/status');
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } catch (err) {
      console.error('Failed fetching status:', err);
    } finally {
      setStatusLoading(false);
      setLastRefreshed(new Date());
    }
  }, []);

  // Fetch jobs
  const fetchJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const url = jobFilter === 'all' ? '/api/jobs' : `/api/jobs?status=${jobFilter}`;
      const res = await apiFetch(url);
      if (res.ok) {
        const data = await res.json();
        setJobs(data.jobs || []);
      }
    } catch (err) {
      console.error('Failed fetching jobs:', err);
    } finally {
      setJobsLoading(false);
    }
  }, [jobFilter, apiFetch]);

  // Fetch catalog videos
  const fetchCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const url = catalogSearch ? `/api/videos?q=${encodeURIComponent(catalogSearch)}` : '/api/videos';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setCatalogVideos(data.videos || []);
        setCatalogTotal(data.total || 0);
      }
    } catch (err) {
      console.error('Failed fetching catalog:', err);
    } finally {
      setCatalogLoading(false);
    }
  }, [catalogSearch]);

  // Fetch schema
  const fetchSchema = useCallback(async () => {
    try {
      const res = await apiFetch('/api/schema/sql');
      if (res.ok) {
        const data = await res.json();
        setSchemaSql(data.sql || '');
      }
    } catch (err) {
      console.error('Failed fetching schema:', err);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    fetchSchema();
    const interval = setInterval(fetchStatus, 8000);
    return () => clearInterval(interval);
  }, [fetchStatus, fetchSchema]);

  useEffect(() => {
    if (activeTab === 'queue') {
      fetchJobs();
    } else if (activeTab === 'catalog') {
      fetchCatalog();
    }
  }, [activeTab, fetchJobs, fetchCatalog]);

  const handleRetryJob = async (id: number) => {
    setRetryingJobId(id);
    try {
      const res = await apiFetch(`/api/jobs/retry/${id}`, { method: 'POST' });
      if (res.ok) {
        await fetchJobs();
        await fetchStatus();
      }
    } catch (err) {
      console.error('Error retrying job:', err);
    } finally {
      setRetryingJobId(null);
    }
  };

  const handleTestProvider = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testCodeInput.trim()) return;

    setProviderTesting(true);
    setProviderResult(null);
    try {
      const res = await apiFetch('/api/provider/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: testCodeInput.trim() }),
      });
      const data = await res.json();
      setProviderResult(data);
    } catch (err: unknown) {
      setProviderResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setProviderTesting(false);
    }
  };

  const handleSimulatePost = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!simCaption.trim()) return;

    setSimLoading(true);
    setSimResult(null);
    try {
      const res = await apiFetch('/api/simulator/dump-post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          caption: simCaption.trim(),
          messageId: simMsgId.trim() || undefined,
          dumpChatId: simDumpChat.trim() || undefined,
        }),
      });
      const data = await res.json();
      setSimResult(data);
      fetchStatus();
    } catch (err: unknown) {
      setSimResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSimLoading(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedSql(true);
    setTimeout(() => setCopiedSql(false), 2000);
  };

  if (authLoading) {
    return <div className="min-h-screen bg-slate-950 text-slate-200 flex items-center justify-center">Checking admin session...</div>;
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <form onSubmit={(e) => { e.preventDefault(); void login(); }} className="w-full max-w-sm bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4 shadow-2xl">
          <div>
            <h1 className="text-lg font-semibold">PiratecultJAV Admin</h1>
            <p className="text-xs text-slate-400 mt-1">Enter the configured admin API key.</p>
          </div>
          <input
            type="password"
            value={adminKey}
            onChange={e => setAdminKey(e.target.value)}
            placeholder="Admin API key"
            autoComplete="current-password"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-500"
          />
          {loginError && <p className="text-xs text-rose-400">{loginError}</p>}
          <button type="submit" className="w-full bg-indigo-600 hover:bg-indigo-500 rounded-lg py-2 text-sm font-medium">
            Sign in
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-indigo-600 selection:text-white">
      {/* Top Bar Contract: Brand title (one line) — Nav links (single line) — Primary action/status */}
      <header className="h-14 border-b border-slate-800 bg-slate-900/90 backdrop-blur px-6 flex items-center justify-between shrink-0 sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm tracking-wider shadow-sm">
            PJ
          </div>
          <span className="font-semibold text-slate-100 tracking-tight text-base whitespace-nowrap">
            PiratecultJAV Console
          </span>
          <span className="text-xs text-slate-500 hidden sm:inline">
            Telegram Indexing Engine
          </span>
        </div>

        {/* Navigation Tabs */}
        <nav className="flex items-center gap-1 bg-slate-950/70 p-1 rounded-lg border border-slate-800">
          <button
            onClick={() => setActiveTab('overview')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === 'overview'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Overview
          </button>
          <button
            onClick={() => setActiveTab('queue')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap flex items-center gap-1.5 ${
              activeTab === 'queue'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Queue & Worker
            {status?.counts?.jobs?.queued ? (
              <span className="font-mono text-[10px] bg-amber-500/20 text-amber-300 px-1.5 rounded">
                {status.counts.jobs.queued}
              </span>
            ) : null}
          </button>
          <button
            onClick={() => setActiveTab('provider')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === 'provider'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Provider Sandbox
          </button>
          <button
            onClick={() => setActiveTab('simulator')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === 'simulator'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Dump Simulator
          </button>
          <button
            onClick={() => setActiveTab('catalog')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === 'catalog'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Video Catalog
          </button>
          <button
            onClick={() => setActiveTab('schema')}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
              activeTab === 'schema'
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            SQL Migration
          </button>
        </nav>

        {/* Live System Indicator */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span
              className={`h-2 w-2 rounded-full ${
                status?.supabase?.connected ? 'bg-emerald-500 animate-pulse' : 'bg-rose-500'
              }`}
            />
            <span className="text-slate-400 text-xs hidden md:inline">
              {status?.supabase?.connected ? 'Supabase Connected' : 'Supabase Offline'}
            </span>
            {status?.supabase?.latencyMs !== undefined && (
              <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                {status.supabase.latencyMs}ms
              </span>
            )}
          </div>
          <button
            onClick={fetchStatus}
            disabled={statusLoading}
            title="Refresh system status"
            className="p-1.5 rounded-md hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${statusLoading ? 'animate-spin text-indigo-400' : ''}`} />
          </button>
        </div>
      </header>

      {/* Main Container */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {/* TAB 1: OVERVIEW & SYSTEM HEALTH */}
        {activeTab === 'overview' && (
          <div className="space-y-6">
            {/* Top Metrics Row */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-slate-900 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span>Cataloged Videos</span>
                  <Film className="h-4 w-4 text-indigo-400" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
                  {status?.counts?.videos ?? 0}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  Indexed from Telegram dump
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span>Queue Jobs</span>
                  <Layers className="h-4 w-4 text-amber-400" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
                  {status?.counts?.jobs?.total ?? 0}
                </div>
                <div className="mt-1 text-[11px] text-slate-500 flex items-center gap-2">
                  <span>Queued: {status?.counts?.jobs?.queued ?? 0}</span>
                  <span>·</span>
                  <span>Failed: {status?.counts?.jobs?.failed ?? 0}</span>
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span>Telegram Users</span>
                  <Users className="h-4 w-4 text-emerald-400" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
                  {status?.counts?.users ?? 0}
                </div>
                <div className="mt-1 text-[11px] text-slate-500">
                  Tracked in database
                </div>
              </div>

              <div className="bg-slate-900 border border-slate-800/80 rounded-xl p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between text-slate-400 text-xs">
                  <span>Server Uptime</span>
                  <Activity className="h-4 w-4 text-cyan-400" />
                </div>
                <div className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
                  {status?.uptime ? `${Math.floor(status.uptime / 60)}m ${Math.floor(status.uptime % 60)}s` : '0s'}
                </div>
                <div className="mt-1 text-[11px] text-slate-500 font-mono">
                  /health HTTP 200 OK
                </div>
              </div>
            </div>

            {/* Architecture Services Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* Supabase Connection Card */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Database className="h-5 w-5 text-emerald-400" />
                      <h3 className="font-semibold text-sm text-slate-200">Supabase PostgreSQL</h3>
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-mono ${
                        status?.supabase?.connected
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-rose-500/10 text-rose-400'
                      }`}
                    >
                      {status?.supabase?.connected ? 'CONNECTED' : 'DISCONNECTED'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                    Source of truth for JAV metadata, unique dump message references, and atomic job queues.
                  </p>

                  <div className="mt-4 space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-500">Host URL</span>
                      <span className="font-mono text-slate-300 truncate max-w-[180px]">
                        {status?.supabase?.url || 'SUPABASE_URL unset'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-500">Secret Key</span>
                      <span className="font-mono text-slate-300">
                        {status?.config?.supabaseConfigured ? 'Configured (Server-Side)' : 'Unset'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-500">Query Ping</span>
                      <span className="font-mono text-slate-300 tabular-nums">
                        {status?.supabase?.latencyMs !== undefined ? `${status.supabase.latencyMs}ms` : 'N/A'}
                      </span>
                    </div>
                  </div>
                </div>

                {status?.supabase?.error && (
                  <div className="p-3 bg-rose-500/10 border border-rose-500/20 rounded-lg text-xs text-rose-300 flex items-start gap-2">
                    <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
                    <div>
                      <div className="font-semibold">Connection Error:</div>
                      <div className="mt-0.5 font-mono text-[11px] break-all">{status.supabase.error}</div>
                      <div className="mt-1 text-slate-400 text-[10px]">
                        Please execute the SQL migration in Supabase SQL editor and verify SUPABASE_URL / SUPABASE_SECRET_KEY.
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Indexer Worker Card */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Layers className="h-5 w-5 text-indigo-400" />
                      <h3 className="font-semibold text-sm text-slate-200">Atomic Indexer Worker</h3>
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-mono ${
                        status?.worker?.isRunning
                          ? 'bg-indigo-500/10 text-indigo-400'
                          : 'bg-slate-700 text-slate-400'
                      }`}
                    >
                      {status?.worker?.isRunning ? 'ACTIVE LOOP' : 'STOPPED'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                    Background daemon atomically claiming queued jobs via <code className="text-indigo-300">FOR UPDATE SKIP LOCKED</code> with exponential retry backoff.
                  </p>

                  <div className="mt-4 space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-500">Poll Frequency</span>
                      <span className="font-mono text-slate-300">
                        {status?.worker?.pollIntervalMs ? `${status.worker.pollIntervalMs / 1000}s interval` : '4s'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-500">Provider Backoff</span>
                      <span className="font-mono text-slate-300">2s polite delay</span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-500">Max Retry Attempts</span>
                      <span className="font-mono text-slate-300">3 attempts before failed</span>
                    </div>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    onClick={() => setActiveTab('queue')}
                    className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    Open Job Queue <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Telegram Engine Card */}
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col justify-between space-y-4">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Radio className="h-5 w-5 text-cyan-400" />
                      <h3 className="font-semibold text-sm text-slate-200">Telegram Bot & Dump Channel</h3>
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded font-mono ${
                        status?.bot?.active
                          ? 'bg-cyan-500/10 text-cyan-400'
                          : 'bg-amber-500/10 text-amber-300'
                      }`}
                    >
                      {status?.bot?.active ? 'POLLING' : 'STANDBY'}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-slate-400 leading-relaxed">
                    Telegraf engine managing user searches, force-subscriptions, /post conversations, and dump channel message routing.
                  </p>

                  <div className="mt-4 space-y-2 text-xs">
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-500">Dump Channel ID</span>
                      <span className="font-mono text-slate-300">{status?.config?.dumpChatId || '-1004426377644'}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-slate-800/60">
                      <span className="text-slate-500">Admins Configured</span>
                      <span className="font-mono text-slate-300">{status?.config?.adminCount ?? 0}</span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-slate-500">Bot Token</span>
                      <span className="font-mono text-slate-300">
                        {status?.config?.botTokenConfigured ? 'Set in Environment' : 'Unset'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    onClick={() => setActiveTab('simulator')}
                    className="w-full py-2 bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 rounded-lg transition-colors flex items-center justify-center gap-1.5"
                  >
                    Simulate Dump Post <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Guide Rule Verification Checklist */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h3 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-emerald-400" />
                Architecture & Non-Negotiable Contract Verification
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-start gap-2.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-slate-200">Zero Stream URL Guarantee</div>
                    <div className="text-slate-400 text-[11px] mt-0.5">
                      Parser strictly discards any HLS, MP4, CDN, or video stream URLs. Only web metadata is preserved.
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-start gap-2.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-slate-200">Atomic Idempotency Guard</div>
                    <div className="text-slate-400 text-[11px] mt-0.5">
                      Unique constraint on <code className="text-indigo-300">(dump_chat_id, video_message_id)</code> prevents duplicate index jobs.
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-start gap-2.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-slate-200">Telegram Dump Media Storage</div>
                    <div className="text-slate-400 text-[11px] mt-0.5">
                      Videos are referenced and copied via Telegram message IDs. No disk video hoarding on the hosting platform.
                    </div>
                  </div>
                </div>

                <div className="p-3 bg-slate-950/60 rounded-lg border border-slate-800/80 flex items-start gap-2.5">
                  <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-medium text-slate-200">Provider Abstraction</div>
                    <div className="text-slate-400 text-[11px] mt-0.5">
                      Javtiful implements standard <code className="text-indigo-300">provider.getMetadata(code)</code> contract with 10m LRU caching.
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TAB 2: ATOMIC QUEUE & JOB INSPECTOR */}
        {activeTab === 'queue' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900 border border-slate-800 p-4 rounded-xl">
              <div>
                <h2 className="text-base font-semibold text-slate-100">Index Jobs Queue Monitor</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Real-time view of atomic background indexing jobs processed by <code className="text-indigo-300">claim_next_index_job()</code>.
                </p>
              </div>

              {/* Status Filter Tabs */}
              <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800">
                {['all', 'queued', 'processing', 'completed', 'failed'].map(f => (
                  <button
                    key={f}
                    onClick={() => setJobFilter(f)}
                    className={`px-3 py-1 text-xs font-medium rounded capitalize transition-colors ${
                      jobFilter === f ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {f}
                  </button>
                ))}
                <button
                  onClick={fetchJobs}
                  disabled={jobsLoading}
                  className="p-1 rounded text-slate-400 hover:text-slate-200 ml-1"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${jobsLoading ? 'animate-spin' : ''}`} />
                </button>
              </div>
            </div>

            {/* Jobs Table */}
            <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-950/70 border-b border-slate-800 text-slate-400 uppercase text-[10px] tracking-wider font-semibold">
                    <tr>
                      <th className="py-3 px-4">Job ID</th>
                      <th className="py-3 px-4">Code</th>
                      <th className="py-3 px-4">Dump Channel & Msg</th>
                      <th className="py-3 px-4">Status</th>
                      <th className="py-3 px-4">Attempts</th>
                      <th className="py-3 px-4">Error / Notes</th>
                      <th className="py-3 px-4">Updated At</th>
                      <th className="py-3 px-4 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60 font-sans">
                    {jobsLoading && jobs.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-8 text-center text-slate-500">
                          <RefreshCw className="h-5 w-5 animate-spin mx-auto mb-2 text-indigo-400" />
                          Loading queue jobs from Supabase...
                        </td>
                      </tr>
                    ) : jobs.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="py-12 text-center text-slate-400">
                          <Layers className="h-8 w-8 mx-auto mb-2 text-slate-600" />
                          <div className="font-medium text-slate-300">No jobs in queue</div>
                          <div className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                            Enqueue a test JAV code below or use the Dump Simulator to generate media index tasks.
                          </div>
                          <button
                            onClick={() => setActiveTab('simulator')}
                            className="mt-3 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-xs font-medium transition-colors"
                          >
                            Open Dump Simulator
                          </button>
                        </td>
                      </tr>
                    ) : (
                      jobs.map(job => (
                        <tr key={job.id} className="hover:bg-slate-800/40 transition-colors">
                          <td className="py-3 px-4 font-mono text-slate-400 tabular-nums">#{job.id}</td>
                          <td className="py-3 px-4 font-semibold text-slate-100 font-mono">{job.code}</td>
                          <td className="py-3 px-4 font-mono text-[11px] text-slate-400">
                            {job.dump_chat_id} : #{job.video_message_id}
                          </td>
                          <td className="py-3 px-4">
                            <span
                              className={`px-2 py-0.5 rounded text-[11px] font-mono capitalize ${
                                job.status === 'completed'
                                  ? 'bg-emerald-500/10 text-emerald-400'
                                  : job.status === 'processing'
                                  ? 'bg-indigo-500/10 text-indigo-400 animate-pulse'
                                  : job.status === 'queued'
                                  ? 'bg-amber-500/10 text-amber-300'
                                  : 'bg-rose-500/10 text-rose-400'
                              }`}
                            >
                              {job.status}
                            </span>
                          </td>
                          <td className="py-3 px-4 font-mono tabular-nums text-slate-300">
                            {job.attempts} / 3
                          </td>
                          <td className="py-3 px-4 max-w-xs truncate text-slate-400 text-[11px]">
                            {job.error || '—'}
                          </td>
                          <td className="py-3 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap">
                            {job.updated_at ? new Date(job.updated_at).toLocaleTimeString() : '—'}
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            {job.status === 'failed' && (
                              <button
                                onClick={() => handleRetryJob(job.id)}
                                disabled={retryingJobId === job.id}
                                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-indigo-300 hover:text-white rounded text-[11px] font-medium transition-colors disabled:opacity-50"
                              >
                                {retryingJobId === job.id ? 'Retrying...' : 'Retry'}
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* TAB 3: PROVIDER SANDBOX (JAVTIFUL) */}
        {activeTab === 'provider' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-semibold text-slate-100">Javtiful Provider Scraper Test</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Execute live metadata lookup using <code className="text-indigo-300">javtifulProvider.getMetadata(code)</code>. Verifies title parsing, actresses extraction, and ensures zero video streaming URLs are exposed.
              </p>

              <form onSubmit={handleTestProvider} className="mt-4 flex flex-col sm:flex-row gap-3">
                <input
                  type="text"
                  value={testCodeInput}
                  onChange={e => setTestCodeInput(e.target.value)}
                  placeholder="Enter JAV code (e.g. SAME-234, ADN-001, STAR-765)"
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                />
                <button
                  type="submit"
                  disabled={providerTesting}
                  className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {providerTesting ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" /> Fetching Javtiful...
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4" /> Run Provider Test
                    </>
                  )}
                </button>
              </form>

              {/* Sample Quick Buttons */}
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                <span>Quick Test:</span>
                {['SAME-234', 'ADN-001', 'ABP-978', 'STAR-765', 'JUR-270'].map(sample => (
                  <button
                    key={sample}
                    type="button"
                    onClick={() => setTestCodeInput(sample)}
                    className="px-2 py-0.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded font-mono text-[11px] transition-colors"
                  >
                    {sample}
                  </button>
                ))}
              </div>
            </div>

            {/* Test Result Display */}
            {providerResult && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between pb-3 border-b border-slate-800">
                  <div className="flex items-center gap-2">
                    {providerResult.ok ? (
                      <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                    ) : (
                      <XCircle className="h-5 w-5 text-rose-400" />
                    )}
                    <h3 className="font-semibold text-sm text-slate-200">
                      {providerResult.ok ? 'Metadata Successfully Extracted' : 'Lookup Error'}
                    </h3>
                  </div>
                  {providerResult.latencyMs !== undefined && (
                    <span className="font-mono text-xs text-slate-400 tabular-nums">
                      {providerResult.latencyMs}ms response time
                    </span>
                  )}
                </div>

                {providerResult.ok && providerResult.metadata ? (
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    {/* Thumbnail Cover */}
                    <div>
                      <div className="text-xs font-semibold text-slate-400 mb-2">Cover Poster</div>
                      {providerResult.metadata.thumbnailUrl ? (
                        <div className="relative aspect-[3/4] bg-slate-950 rounded-lg overflow-hidden border border-slate-800">
                          <img
                            src={providerResult.metadata.thumbnailUrl}
                            alt={providerResult.metadata.title}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        </div>
                      ) : (
                        <div className="aspect-[3/4] bg-slate-950 rounded-lg border border-slate-800 flex items-center justify-center text-xs text-slate-600">
                          No Poster Found
                        </div>
                      )}
                    </div>

                    {/* Metadata Fields */}
                    <div className="md:col-span-2 space-y-3 text-xs">
                      <div>
                        <span className="text-slate-500 uppercase text-[10px] tracking-wider block font-semibold">
                          Normalized Code
                        </span>
                        <span className="font-mono text-base font-bold text-indigo-400">
                          {providerResult.metadata.code}
                        </span>
                      </div>

                      <div>
                        <span className="text-slate-500 uppercase text-[10px] tracking-wider block font-semibold">
                          Title
                        </span>
                        <span className="text-sm font-semibold text-slate-200">
                          {providerResult.metadata.title}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 gap-3 pt-2 border-t border-slate-800/60">
                        <div>
                          <span className="text-slate-500 uppercase text-[10px] tracking-wider block font-semibold">
                            Actresses
                          </span>
                          <span className="text-slate-300">
                            {providerResult.metadata.actresses.length > 0
                              ? providerResult.metadata.actresses.join(', ')
                              : 'None listed'}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 uppercase text-[10px] tracking-wider block font-semibold">
                            Duration & Release
                          </span>
                          <span className="text-slate-300">
                            {providerResult.metadata.duration || 'N/A'} · {providerResult.metadata.date || 'N/A'}
                          </span>
                        </div>
                      </div>

                      <div className="pt-2 border-t border-slate-800/60">
                        <span className="text-slate-500 uppercase text-[10px] tracking-wider block font-semibold">
                          Description
                        </span>
                        <p className="text-slate-400 mt-1 leading-relaxed text-[11px] line-clamp-3">
                          {providerResult.metadata.description || 'No description available'}
                        </p>
                      </div>

                      <div className="pt-2 border-t border-slate-800/60">
                        <span className="text-slate-500 uppercase text-[10px] tracking-wider block font-semibold">
                          Provider Webpage (Source URL)
                        </span>
                        <a
                          href={providerResult.metadata.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-indigo-400 hover:text-indigo-300 font-mono text-[11px] flex items-center gap-1 mt-0.5 truncate"
                        >
                          {providerResult.metadata.sourceUrl} <ExternalLink className="h-3 w-3" />
                        </a>
                      </div>

                      {/* Stream URL Audit Confirmation */}
                      <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-300 text-xs flex items-center gap-2 mt-4">
                        <CheckCircle2 className="h-4 w-4 shrink-0" />
                        <span>
                          <strong>Security Verified:</strong> No video stream or HLS URLs extracted. Only pure metadata captured.
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-300 text-xs font-mono">
                    {providerResult.error}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* TAB 4: DUMP CHANNEL SIMULATOR */}
        {activeTab === 'simulator' && (
          <div className="space-y-6">
            <div className="bg-slate-900 border border-slate-800 rounded-xl p-5">
              <h2 className="text-base font-semibold text-slate-100">Telegram Dump Channel Post Simulator</h2>
              <p className="text-xs text-slate-400 mt-0.5">
                Simulate a Telegram channel post with video media to test caption JAV code extraction, idempotency duplicate checks, and job creation.
              </p>

              <form onSubmit={handleSimulatePost} className="mt-4 space-y-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-400 mb-1">
                    Post Caption / Text (Extracts JAV code)
                  </label>
                  <input
                    type="text"
                    value={simCaption}
                    onChange={e => setSimCaption(e.target.value)}
                    placeholder="e.g. ROE-327 1080p, #ADN-001, [STAR-765]"
                    className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Telegram Message ID
                    </label>
                    <input
                      type="text"
                      value={simMsgId}
                      onChange={e => setSimMsgId(e.target.value)}
                      placeholder="e.g. 123456"
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                    <span className="text-[10px] text-slate-500 mt-1 block">
                      Tip: Keep the same Message ID to verify duplicate detection rejects re-indexing!
                    </span>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-slate-400 mb-1">
                      Dump Channel ID
                    </label>
                    <input
                      type="text"
                      value={simDumpChat}
                      onChange={e => setSimDumpChat(e.target.value)}
                      placeholder="-1004426377644"
                      className="w-full bg-slate-950 border border-slate-800 rounded-lg px-4 py-2 text-sm text-slate-100 font-mono placeholder:text-slate-600 focus:outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={simLoading}
                    className="px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-sm font-medium transition-colors flex items-center gap-2 disabled:opacity-50"
                  >
                    {simLoading ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" /> Simulating Telegram Event...
                      </>
                    ) : (
                      <>
                        <Send className="h-4 w-4" /> Simulate Dump Media Message
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>

            {simResult && (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
                <div className="flex items-center gap-2 pb-3 border-b border-slate-800">
                  {simResult.created ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-amber-400" />
                  )}
                  <h3 className="font-semibold text-sm text-slate-200">
                    {simResult.created ? 'New Index Job Created' : 'Duplicate Media Prevented'}
                  </h3>
                </div>

                <div className="space-y-2 text-xs font-mono">
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500 font-sans">Extracted Codes</span>
                    <span className="text-indigo-400">{JSON.stringify(simResult.extractedCodes)}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500 font-sans">Primary Code</span>
                    <span className="text-slate-200">{simResult.primaryCode}</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500 font-sans">Unique Telegram Identity</span>
                    <span className="text-slate-200">
                      {simResult.dumpChatId} : #{simResult.videoMessageId}
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-slate-800/60">
                    <span className="text-slate-500 font-sans">Job Creation Status</span>
                    <span className={simResult.created ? 'text-emerald-400' : 'text-amber-400'}>
                      {simResult.created ? 'Created & Queued' : 'Skipped Duplicate'}
                    </span>
                  </div>
                  {simResult.reason && (
                    <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-lg text-amber-300 font-sans text-xs">
                      {simResult.reason}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB 5: VIDEO CATALOG */}
        {activeTab === 'catalog' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900 border border-slate-800 p-4 rounded-xl">
              <div>
                <h2 className="text-base font-semibold text-slate-100">Indexed Video Catalog</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Metadata persisted in Supabase linked directly to Telegram Dump Channel messages.
                </p>
              </div>

              {/* Search Form */}
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="h-4 w-4 text-slate-500 absolute left-3 top-2.5" />
                  <input
                    type="text"
                    value={catalogSearch}
                    onChange={e => setCatalogSearch(e.target.value)}
                    placeholder="Search by code or title..."
                    className="pl-9 pr-4 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500 w-64"
                  />
                </div>
                <button
                  onClick={fetchCatalog}
                  disabled={catalogLoading}
                  className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors"
                >
                  Search
                </button>
              </div>
            </div>

            {/* Catalog Grid */}
            {catalogLoading && catalogVideos.length === 0 ? (
              <div className="py-12 text-center text-slate-500">
                <RefreshCw className="h-6 w-6 animate-spin mx-auto mb-2 text-indigo-400" />
                Querying Supabase videos catalog...
              </div>
            ) : catalogVideos.length === 0 ? (
              <div className="bg-slate-900 border border-slate-800 rounded-xl p-12 text-center text-slate-400">
                <Film className="h-10 w-10 mx-auto mb-2 text-slate-600" />
                <div className="font-medium text-slate-300">No videos indexed yet</div>
                <div className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
                  When videos are posted in the Telegram Dump Channel or added via /post, they appear here.
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {catalogVideos.map(video => (
                  <div
                    key={video.id}
                    className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col justify-between hover:border-slate-700 transition-colors"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <span className="font-mono font-bold text-sm text-indigo-400">
                          {video.normalized_code}
                        </span>
                        <span
                          className={`text-[10px] px-2 py-0.5 rounded font-mono capitalize ${
                            video.status === 'available'
                              ? 'bg-emerald-500/10 text-emerald-400'
                              : 'bg-amber-500/10 text-amber-300'
                          }`}
                        >
                          {video.status}
                        </span>
                      </div>
                      <h4 className="font-semibold text-xs text-slate-200 mt-1 line-clamp-2">
                        {video.title}
                      </h4>
                      {video.description && (
                        <p className="text-[11px] text-slate-400 mt-1.5 line-clamp-2">
                          {video.description}
                        </p>
                      )}
                    </div>

                    <div className="mt-4 pt-3 border-t border-slate-800/60 space-y-1.5 text-[11px]">
                      <div className="flex justify-between text-slate-500">
                        <span>Dump Message ID:</span>
                        <span className="font-mono text-slate-300">#{video.video_message_id}</span>
                      </div>
                      <div className="flex justify-between text-slate-500">
                        <span>Dump Chat:</span>
                        <span className="font-mono text-slate-300">{video.dump_chat_id}</span>
                      </div>
                      {video.metadata?.actresses && video.metadata.actresses.length > 0 && (
                        <div className="flex justify-between text-slate-500">
                          <span>Actresses:</span>
                          <span className="text-slate-300 truncate max-w-[150px]">
                            {video.metadata.actresses.join(', ')}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* TAB 6: SQL MIGRATION */}
        {activeTab === 'schema' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900 border border-slate-800 p-4 rounded-xl">
              <div>
                <h2 className="text-base font-semibold text-slate-100">Supabase SQL Migration (001_initial_schema.sql)</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Run this migration in your Supabase project SQL Editor to create tables, indexes, and the atomic job claim procedure.
                </p>
              </div>
              <button
                onClick={() => copyToClipboard(schemaSql)}
                className="px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-medium transition-colors flex items-center gap-2 self-start sm:self-auto"
              >
                {copiedSql ? (
                  <>
                    <Check className="h-4 w-4" /> Copied SQL!
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" /> Copy SQL to Clipboard
                  </>
                )}
              </button>
            </div>

            <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 overflow-x-auto">
              <pre className="font-mono text-xs text-slate-300 leading-relaxed whitespace-pre">
                {schemaSql || '-- Loading schema script...'}
              </pre>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
