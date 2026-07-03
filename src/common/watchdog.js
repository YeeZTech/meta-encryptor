/**
 * Inactivity watchdog: fires onStall once if kick() is not called again within
 * `ms` milliseconds. Used to abort transfer pipelines that would otherwise
 * hang forever waiting for an event that never comes.
 *
 * A ms of 0/null disables the watchdog (kick becomes a no-op).
 */
export function createInactivityWatchdog(ms, onStall) {
  let timer = null;
  let stopped = false;

  const kick = () => {
    if (stopped || !ms || ms <= 0) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!stopped) onStall();
    }, ms);
  };

  const stop = () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };

  return { kick, stop };
}
