import { Injectable } from '@nestjs/common';

/**
 * Simple asynchronous task queue used to offload work from the share
 * submission path. Tasks are executed sequentially in the order they are
 * enqueued, ensuring that heavy database writes do not block the main
 * event loop that handles miner connections.
 */
@Injectable()
export class BackgroundQueueService {
  private queue: Array<() => Promise<void>> = [];
  private processing = false;
  private drainResolvers: Array<() => void> = [];

  enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    this.process();
  }

  private async process(): Promise<void> {
    if (this.processing) {
      return;
    }
    this.processing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) {
        continue;
      }
      try {
        await task();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Background task failed', err);
      }
    }

    this.processing = false;
    // Resolve any pending drain promises now that the queue is empty.
    this.drainResolvers.forEach((resolve) => resolve());
    this.drainResolvers = [];
  }

  /**
   * Waits until the queue has processed all pending tasks. Useful during
   * shutdown when we want to ensure all asynchronous work has completed before
   * exiting the process.
   */
  async drain(): Promise<void> {
    if (!this.processing && this.queue.length === 0) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }
}

