// Blocks a second submit of the same card until the item goes away, the hub
// reported a new error, or a fallback timer expires.

export interface SubmitGuard<N> {
  readonly locked: boolean;
  /** Returns false when already locked (the caller must not send again). */
  lock(noticeNow: N): boolean;
  /** Call on every sync; unlocks when a notice other than the one at lock time appears. */
  observe(noticeNow: N): void;
  /** A different request is shown: forget everything. */
  reset(): void;
}

export function createSubmitGuard<N>(onChange: (locked: boolean) => void, fallbackMs = 4000): SubmitGuard<N> {
  let locked = false;
  let noticeAtLock: N | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const set = (value: boolean) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (locked === value) return;
    locked = value;
    onChange(value);
  };

  return {
    get locked() {
      return locked;
    },
    lock(noticeNow) {
      if (locked) return false;
      noticeAtLock = noticeNow;
      set(true);
      timer = setTimeout(() => set(false), fallbackMs);
      return true;
    },
    observe(noticeNow) {
      if (locked && noticeNow && noticeNow !== noticeAtLock) set(false);
    },
    reset() {
      set(false);
    },
  };
}
