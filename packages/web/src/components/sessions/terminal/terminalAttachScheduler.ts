type AttachTask = {
  sessionId: string;
  priority: number;
  enqueuedAt: number;
  canceled: boolean;
  released: boolean;
  run: (done: () => void) => void;
};

const MAX_CONCURRENT_ATTACHES = 3;

const DEBUG_SCHEDULER =
  typeof localStorage !== "undefined"
  && localStorage.getItem("CONDUCTOR_TERMINAL_DEBUG") === "1";

/**
 * Module-level singleton state for terminal attach scheduling.
 * These variables persist across React re-renders but reset on HMR updates.
 * Use resetTerminalAttachScheduler() in tests to reset state.
 */
let inFlight = 0;
const queue: AttachTask[] = [];
const pendingBySessionId = new Map<string, AttachTask>();
const runningBySessionId = new Map<string, AttachTask>();
const waitingBySessionId = new Map<string, AttachTask>();

function pump(): void {
  while (inFlight < MAX_CONCURRENT_ATTACHES && queue.length > 0) {
    queue.sort((left, right) => left.priority - right.priority || left.enqueuedAt - right.enqueuedAt);
    const task = queue.shift();
    if (!task) {
      return;
    }
    if (task.canceled) {
      if (DEBUG_SCHEDULER) {
        console.log(`[TerminalAttachScheduler] skipping canceled task: ${task.sessionId}`);
      }
      continue;
    }

    const current = pendingBySessionId.get(task.sessionId);
    if (current !== task) {
      if (DEBUG_SCHEDULER) {
        console.log(`[TerminalAttachScheduler] skipping replaced task: ${task.sessionId}`);
      }
      continue;
    }

    const running = runningBySessionId.get(task.sessionId);
    if (running && running !== task) {
      waitingBySessionId.set(task.sessionId, task);
      if (DEBUG_SCHEDULER) {
        console.log(`[TerminalAttachScheduler] waiting for running task: ${task.sessionId}`);
      }
      continue;
    }

    inFlight += 1;
    runningBySessionId.set(task.sessionId, task);

    if (DEBUG_SCHEDULER) {
      console.log(
        `[TerminalAttachScheduler] starting task: ${task.sessionId} (inFlight=${inFlight}, queued=${queue.length})`,
      );
    }

    task.run(() => {
      const shouldRelease = !task.released;
      if (shouldRelease) {
        task.released = true;
      }

      if (runningBySessionId.get(task.sessionId) === task) {
        runningBySessionId.delete(task.sessionId);
      }
      if (pendingBySessionId.get(task.sessionId) === task) {
        pendingBySessionId.delete(task.sessionId);
      }

      const waiting = waitingBySessionId.get(task.sessionId);
      if (waiting && !waiting.canceled) {
        waitingBySessionId.delete(task.sessionId);
        queue.push(waiting);
      }

      if (shouldRelease) {
        inFlight = Math.max(0, inFlight - 1);
      }

      if (DEBUG_SCHEDULER) {
        console.log(
          `[TerminalAttachScheduler] completed task: ${task.sessionId} (inFlight=${inFlight}, released=${shouldRelease})`,
        );
      }

      pump();
    });
  }
}

export function scheduleTerminalAttach({
  sessionId,
  priority,
  run,
}: {
  sessionId: string;
  priority: number;
  run: (done: () => void) => void;
}): () => void {
  const existing = pendingBySessionId.get(sessionId);
  if (existing) {
    existing.canceled = true;
    pendingBySessionId.delete(sessionId);
  }

  const task: AttachTask = {
    sessionId,
    priority,
    enqueuedAt: Date.now(),
    canceled: false,
    released: false,
    run,
  };

  pendingBySessionId.set(sessionId, task);
  queue.push(task);
  pump();

  return () => {
    task.canceled = true;
    if (pendingBySessionId.get(sessionId) === task) {
      pendingBySessionId.delete(sessionId);
    }
    if (waitingBySessionId.get(sessionId) === task) {
      waitingBySessionId.delete(sessionId);
    }

    if (runningBySessionId.get(sessionId) === task && !task.released) {
      task.released = true;
      runningBySessionId.delete(sessionId);
      inFlight = Math.max(0, inFlight - 1);
      const waiting = waitingBySessionId.get(sessionId);
      if (waiting && !waiting.canceled) {
        waitingBySessionId.delete(sessionId);
        queue.push(waiting);
      }
      pump();
    }
  };
}

export function resetTerminalAttachScheduler(): void {
  inFlight = 0;
  queue.length = 0;
  pendingBySessionId.clear();
  runningBySessionId.clear();
  waitingBySessionId.clear();
}
