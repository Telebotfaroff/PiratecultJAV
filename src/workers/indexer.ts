import { claimNextJob, updateJobStatus, IndexJob } from '../services/indexJobs.ts';
import { javtifulProvider, ProviderNotFoundError, ProviderTemporaryError } from '../providers/javtiful/index.ts';
import { upsertVideoFromProvider } from '../services/videos.ts';

export class IndexerWorker {
  private isRunning = false;
  private loopTimer: NodeJS.Timeout | null = null;
  private readonly pollIntervalMs = 4000;
  private readonly delayBetweenRequestsMs = 2000;
  private readonly maxAttempts = 3;

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    console.log('[IndexerWorker] Background worker started.');
    this.scheduleNextTick(1000);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    console.log('[IndexerWorker] Background worker stopped.');
  }

  public getStatus(): { isRunning: boolean; pollIntervalMs: number } {
    return {
      isRunning: this.isRunning,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  private scheduleNextTick(delayMs = this.pollIntervalMs): void {
    if (!this.isRunning) return;
    this.loopTimer = setTimeout(() => {
      this.processNextJob()
        .catch(err => {
          console.error('[IndexerWorker] Unexpected error in worker tick:', err);
        })
        .finally(() => {
          this.scheduleNextTick(this.pollIntervalMs);
        });
    }, delayMs);
  }

  private async processNextJob(): Promise<void> {
    // 1. Atomically claim next queued job
    let job: IndexJob | null = null;
    try {
      job = await claimNextJob();
    } catch (claimErr) {
      // Database might be unconfigured or unreachable
      return;
    }

    if (!job) {
      return; // No queued jobs to process
    }

    console.log(`[IndexerWorker] Claimed job #${job.id} for code ${job.code} (Attempt ${job.attempts}/${this.maxAttempts})`);

    try {
      // Respect delay before provider request to avoid hammering
      await new Promise(r => setTimeout(r, this.delayBetweenRequestsMs));

      // 2. Fetch metadata from Javtiful
      const metadata = await javtifulProvider.getMetadata(job.code);

      // 3. Persist metadata into Supabase videos table
      await upsertVideoFromProvider({
        code: job.code,
        dump_chat_id: job.dump_chat_id,
        video_message_id: job.video_message_id,
        metadata,
        status: 'available',
      });

      // 4. Mark job as completed
      await updateJobStatus(job.id, 'completed', null);
      console.log(`[IndexerWorker] Job #${job.id} (${job.code}) completed successfully.`);
    } catch (err: unknown) {
      if (err instanceof ProviderNotFoundError) {
        // Controlled not-found: Do not retry endlessly
        console.warn(`[IndexerWorker] Job #${job.id} (${job.code}) not found on provider.`);
        await updateJobStatus(job.id, 'failed', `Not found on Javtiful: ${err.message}`);
        
        // Still register video as failed so search shows status
        try {
          await upsertVideoFromProvider({
            code: job.code,
            dump_chat_id: job.dump_chat_id,
            video_message_id: job.video_message_id,
            status: 'failed',
          });
        } catch {
          // Ignore
        }
      } else if (err instanceof ProviderTemporaryError || (err instanceof Error && err.name === 'AbortError')) {
        // Temporary provider error (429, 500, timeout)
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[IndexerWorker] Job #${job.id} temporary provider error: ${errMsg}`);

        if (job.attempts < this.maxAttempts) {
          // Requeue job for retry with exponential backoff info
          const backoffSec = Math.pow(2, job.attempts) * 10;
          console.log(`[IndexerWorker] Re-queueing job #${job.id} after backoff (~${backoffSec}s)...`);
          await updateJobStatus(job.id, 'queued', `Temporary error (Attempt ${job.attempts}): ${errMsg}`);
        } else {
          console.error(`[IndexerWorker] Job #${job.id} failed after reaching maximum attempts (${this.maxAttempts}).`);
          await updateJobStatus(job.id, 'failed', `Max retry attempts (${this.maxAttempts}) exceeded: ${errMsg}`);
        }
      } else {
        // Unexpected processing or database error
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[IndexerWorker] Job #${job.id} failed with error:`, errMsg);

        if (job.attempts < this.maxAttempts) {
          await updateJobStatus(job.id, 'queued', `Unexpected error: ${errMsg}`);
        } else {
          await updateJobStatus(job.id, 'failed', `Failed: ${errMsg}`);
        }
      }
    }
  }
}

export const indexerWorker = new IndexerWorker();
