export interface TimerHandle {
  cancel(): void;
}

/** Injected so tests can advance time by hand instead of sleeping. */
export interface TimerApi {
  set(delayMs: number, callback: () => void): TimerHandle;
}

export function realTimers(): TimerApi {
  return {
    set(delayMs, callback) {
      const handle = setTimeout(callback, Math.max(0, delayMs));
      return {cancel: () => clearTimeout(handle)};
    },
  };
}

/** Bookkeeping for one room's live timers: every reschedule clears all first. */
export class TimerSet {
  private handles: TimerHandle[] = [];
  private api: TimerApi;

  constructor(api: TimerApi) {
    this.api = api;
  }

  add(delayMs: number, callback: () => void): void {
    this.handles.push(this.api.set(delayMs, callback));
  }

  clear(): void {
    for (const handle of this.handles) handle.cancel();
    this.handles = [];
  }
}
