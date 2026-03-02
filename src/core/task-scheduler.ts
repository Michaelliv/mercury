import { CronExpressionParser } from "cron-parser";
import { logger } from "../logger.js";
import type { Db } from "../storage/db.js";

type TaskHandler = (task: {
  id: number;
  groupId: string;
  prompt: string;
  createdBy: string;
  silent: boolean;
}) => Promise<void>;

export class TaskScheduler {
  private timer: NodeJS.Timeout | null = null;
  private handler: TaskHandler | null = null;

  constructor(
    private readonly db: Db,
    private readonly pollIntervalMs = 5_000,
  ) {}

  start(handler: TaskHandler) {
    if (this.timer) return;
    this.handler = handler;

    const tick = async () => {
      try {
        const due = this.db.getDueTasks(Date.now());
        for (const task of due) {
          // For cron tasks, update next run before execution
          // For at-tasks, we'll delete after execution
          if (task.cron) {
            const next = this.computeNextRun(task.cron);
            this.db.updateTaskNextRun(task.id, next);
          }

          try {
            await handler({
              id: task.id,
              groupId: task.groupId,
              prompt: task.prompt,
              createdBy: task.createdBy,
              silent: task.silent === 1,
            });
          } catch (error) {
            logger.error("Scheduler task handler failed", {
              taskId: task.id,
              groupId: task.groupId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          // For at-tasks, delete after execution (regardless of success/failure)
          if (task.at) {
            this.db.deleteTaskById(task.id);
            logger.info("One-shot task completed and deleted", {
              taskId: task.id,
              groupId: task.groupId,
            });
          }
        }
      } catch (error) {
        logger.error(
          "Scheduler error",
          error instanceof Error ? error : undefined,
        );
      } finally {
        this.timer = setTimeout(tick, this.pollIntervalMs);
      }
    };

    this.timer = setTimeout(tick, this.pollIntervalMs);
  }

  stop() {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  computeNextRun(cron: string, from = new Date()): number {
    const interval = CronExpressionParser.parse(cron, { currentDate: from });
    return interval.next().getTime();
  }

  async triggerTask(taskId: number): Promise<boolean> {
    if (!this.handler) return false;
    const task = this.db.getTask(taskId);
    if (!task || !task.active) return false;

    await this.handler({
      id: task.id,
      groupId: task.groupId,
      prompt: task.prompt,
      createdBy: task.createdBy,
      silent: task.silent === 1,
    });
    return true;
  }
}
