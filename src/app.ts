import express, { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config, validateConfig } from './config.ts';
import { checkSupabaseConnection } from './database/supabase.ts';
import { countVideos, searchVideos } from './services/videos.ts';
import { countJobs, createIndexJob, getRecentJobs, retryJob } from './services/indexJobs.ts';
import { countUsers } from './services/users.ts';
import { javtifulProvider } from './providers/javtiful/index.ts';
import { extractCodes, normalizeCode } from './services/code.ts';
import { getAllSettings, setSetting } from './services/settings.ts';
import { isBotActive } from './bot/index.ts';
import { indexerWorker } from './workers/indexer.ts';

const adminSessions = new Map<string, number>();

function getCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie || '';
  const item = header.split(';').map(v => v.trim()).find(v => v.startsWith(name + '='));
  return item ? decodeURIComponent(item.slice(name.length + 1)) : null;
}

function safeEqual(a: string, b: string): boolean {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function adminOnly(req: Request, res: Response, next: express.NextFunction): void {
  const bearer = req.headers.authorization?.startsWith('Bearer ')
    ? req.headers.authorization.slice(7)
    : null;
  const cookieToken = getCookie(req, 'pc_admin');
  const sessionToken = bearer || cookieToken;

  if (sessionToken) {
    const expiresAt = adminSessions.get(sessionToken);
    if (expiresAt && expiresAt > Date.now()) {
      adminSessions.set(sessionToken, Date.now() + config.adminSessionTtlMs);
      return next();
    }
    adminSessions.delete(sessionToken);
  }

  // Direct API-key access is useful for scripts/automation and never gets sent to the browser.
  const apiKey = req.headers['x-admin-key'];
  if (typeof apiKey === 'string' && config.adminApiKey && safeEqual(apiKey, config.adminApiKey)) {
    return next();
  }

  res.status(401).json({ ok: false, error: 'Admin authentication required' });
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/api/auth/login', (req: Request, res: Response) => {
    if (!config.adminApiKey) {
      return res.status(503).json({ ok: false, error: 'ADMIN_API_KEY is not configured' });
    }

    const supplied = typeof req.body?.key === 'string' ? req.body.key : '';
    if (!safeEqual(supplied, config.adminApiKey)) {
      return res.status(401).json({ ok: false, error: 'Invalid admin key' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, Date.now() + config.adminSessionTtlMs);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader(
      'Set-Cookie',
      `pc_admin=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(config.adminSessionTtlMs / 1000)}${secure}`
    );
    return res.json({ ok: true });
  });

  app.post('/api/auth/logout', adminOnly, (req: Request, res: Response) => {
    const token = getCookie(req, 'pc_admin');
    if (token) adminSessions.delete(token);
    res.setHeader('Set-Cookie', 'pc_admin=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
    return res.json({ ok: true });
  });

  app.get('/api/auth/status', (req: Request, res: Response) => {
    const token = getCookie(req, 'pc_admin');
    const expiresAt = token ? adminSessions.get(token) : undefined;
    return res.json({ ok: true, authenticated: Boolean(expiresAt && expiresAt > Date.now()) });
  });

  // Non-negotiable requirement: /health endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      service: 'PiratecultJAV',
    });
  });

  // System status and diagnostics
  app.get('/api/status', async (_req: Request, res: Response) => {
    const startTime = Date.now();
    const configValidation = validateConfig();
    const supabaseStatus = await checkSupabaseConnection();

    let counts = { users: 0, videos: 0, jobs: { queued: 0, processing: 0, completed: 0, failed: 0, total: 0 } };
    if (supabaseStatus.connected) {
      try {
        const [uCount, vCount, jCounts] = await Promise.all([
          countUsers(),
          countVideos(),
          countJobs(),
        ]);
        counts = { users: uCount, videos: vCount, jobs: jCounts };
      } catch (err) {
        console.warn('Failed querying counts:', err);
      }
    }

    res.json({
      service: 'PiratecultJAV',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      config: {
        supabaseConfigured: Boolean(config.supabaseUrl && config.supabaseSecretKey),
        botTokenConfigured: Boolean(config.botToken),
        dumpChatId: config.dumpChatId,
        adminCount: config.adminIds.length,
        javtifulBaseUrl: config.javtifulBaseUrl,
        validation: configValidation,
      },
      supabase: supabaseStatus,
      bot: {
        active: isBotActive(),
      },
      worker: indexerWorker.getStatus(),
      counts,
      latencyMs: Date.now() - startTime,
    });
  });

  // Jobs API: List jobs
  app.get('/api/jobs', adminOnly, async (req: Request, res: Response) => {
    try {
      const statusFilter = (req.query.status as string) || undefined;
      const limit = parseInt((req.query.limit as string) || '50', 10);
      const jobs = await getRecentJobs(statusFilter, limit);
      res.json({ ok: true, jobs });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Jobs API: Create a manual or test job
  app.post('/api/jobs/create', adminOnly, async (req: Request, res: Response) => {
    try {
      const { code, dumpChatId, videoMessageId } = req.body;
      if (!code) {
        return res.status(400).json({ ok: false, error: 'code is required' });
      }

      const norm = normalizeCode(code);
      if (!norm) {
        return res.status(400).json({ ok: false, error: 'Invalid JAV code format' });
      }

      const vMsgId = parseInt(videoMessageId || String(Math.floor(Date.now() / 1000)), 10);
      const dChatId = dumpChatId || config.dumpChatId;

      const result = await createIndexJob({
        code: norm,
        dumpChatId: dChatId,
        videoMessageId: vMsgId,
      });

      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Jobs API: Retry job
  app.post('/api/jobs/retry/:id', adminOnly, async (req: Request, res: Response) => {
    try {
      const jobId = parseInt(req.params.id, 10);
      const job = await retryJob(jobId);
      res.json({ ok: true, job });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Videos API: Search & browse
  app.get('/api/videos', async (req: Request, res: Response) => {
    try {
      const query = (req.query.q as string) || '';
      const limit = parseInt((req.query.limit as string) || '20', 10);
      const offset = parseInt((req.query.offset as string) || '0', 10);

      const result = await searchVideos(query, limit, offset);
      res.json({ ok: true, ...result });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Provider Test API: Live scraper runner for any JAV code
  app.post('/api/provider/test', adminOnly, async (req: Request, res: Response) => {
    const start = Date.now();
    try {
      const { code } = req.body;
      if (!code) {
        return res.status(400).json({ ok: false, error: 'code is required' });
      }

      const normalized = normalizeCode(code);
      if (!normalized) {
        return res.status(400).json({ ok: false, error: `Invalid code format: ${code}` });
      }

      const metadata = await javtifulProvider.getMetadata(normalized);
      const latencyMs = Date.now() - start;

      res.json({
        ok: true,
        code: normalized,
        latencyMs,
        metadata,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(400).json({
        ok: false,
        latencyMs: Date.now() - start,
        error: errMsg,
      });
    }
  });

  // Simulator API: Simulates a Telegram Dump Channel post
  app.post('/api/simulator/dump-post', adminOnly, async (req: Request, res: Response) => {
    try {
      const { caption, messageId, dumpChatId } = req.body;
      if (!caption) {
        return res.status(400).json({ ok: false, error: 'caption is required' });
      }

      const codes = extractCodes(caption);
      if (codes.length === 0) {
        return res.status(400).json({
          ok: false,
          error: 'No valid JAV codes found in caption. Try e.g. "ADN-001" or "ROE-327"',
        });
      }

      const primaryCode = codes[0];
      const targetMessageId = parseInt(messageId || String(Math.floor(Date.now() / 1000)), 10);
      const targetChatId = dumpChatId || config.dumpChatId;

      const jobResult = await createIndexJob({
        code: primaryCode,
        dumpChatId: targetChatId,
        videoMessageId: targetMessageId,
      });

      res.json({
        ok: true,
        extractedCodes: codes,
        primaryCode,
        dumpChatId: targetChatId,
        videoMessageId: targetMessageId,
        job: jobResult.job,
        created: jobResult.created,
        reason: jobResult.reason,
      });
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ ok: false, error: errMsg });
    }
  });

  // Force-sub channel management API
  app.get('/api/force-sub/channels', adminOnly, async (_req: Request, res: Response) => {
    try {
      const supabase = (await import('./database/supabase.ts')).getSupabase();
      const { data, error } = await supabase.from('force_sub_channels').select('*').order('created_at', { ascending: true });
      if (error) throw error;
      res.json({ ok: true, channels: data || [] });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/force-sub/channels', adminOnly, async (req: Request, res: Response) => {
    try {
      const { channelId, title, inviteLink, requestMode, isActive } = req.body || {};
      if (!channelId || !title) return res.status(400).json({ ok: false, error: 'channelId and title are required' });
      const supabase = (await import('./database/supabase.ts')).getSupabase();
      const { data, error } = await supabase.from('force_sub_channels').upsert({
        channel_id: String(channelId).trim(),
        title: String(title).trim(),
        invite_link: inviteLink ? String(inviteLink).trim() : null,
        request_mode: Boolean(requestMode),
        is_active: isActive !== false,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'channel_id' }).select('*').single();
      if (error) throw error;
      res.json({ ok: true, channel: data });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.patch('/api/force-sub/channels/:id', adminOnly, async (req: Request, res: Response) => {
    try {
      const { title, inviteLink, requestMode, isActive } = req.body || {};
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (title !== undefined) updates.title = String(title).trim();
      if (inviteLink !== undefined) updates.invite_link = inviteLink ? String(inviteLink).trim() : null;
      if (requestMode !== undefined) updates.request_mode = Boolean(requestMode);
      if (isActive !== undefined) updates.is_active = Boolean(isActive);
      const supabase = (await import('./database/supabase.ts')).getSupabase();
      const { data, error } = await supabase.from('force_sub_channels').update(updates).eq('id', req.params.id).select('*').single();
      if (error) throw error;
      res.json({ ok: true, channel: data });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete('/api/force-sub/channels/:id', adminOnly, async (req: Request, res: Response) => {
    try {
      const supabase = (await import('./database/supabase.ts')).getSupabase();
      const { error } = await supabase.from('force_sub_channels').delete().eq('id', req.params.id);
      if (error) throw error;
      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Settings API
  app.get('/api/settings', adminOnly, async (_req: Request, res: Response) => {
    try {
      const settings = await getAllSettings();
      res.json({ ok: true, settings });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  app.post('/api/settings', adminOnly, async (req: Request, res: Response) => {
    try {
      const { key, value } = req.body;
      if (!key) return res.status(400).json({ ok: false, error: 'key is required' });
      await setSetting(key, value);
      res.json({ ok: true, message: `Setting ${key} updated` });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // Schema SQL API
  app.get('/api/schema/sql', adminOnly, (_req: Request, res: Response) => {
    try {
      const sqlPath = path.resolve(process.cwd(), 'supabase/migrations/001_initial_schema.sql');
      if (fs.existsSync(sqlPath)) {
        const sql = fs.readFileSync(sqlPath, 'utf-8');
        return res.json({ ok: true, sql });
      }
      res.status(404).json({ ok: false, error: 'Schema file not found' });
    } catch (err: unknown) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  return app;
}
