/** Completion delivery shared by browser messages and reconnects. Ports keep browser permissions outside the delivery gate. */
export function createCompletionNotifier({ readClaim = () => null, writeClaim = () => {}, withLock = (_name, run) => run(), present, notify, onError = () => {} }) {
  let lastKey;
  let disposed = false;
  async function completed(state) {
    if (disposed || state?.status !== 'completed' || !['focus', 'break'].includes(state.mode) ||
        !Number.isSafeInteger(state.revision)) return false;
    const key = state.mode + ':' + state.revision;
    if (lastKey === key) return false;
    lastKey = key;
    const run = async () => {
      if (disposed) return false;
      try { if (readClaim() === key) return false; } catch (error) { onError(error); }
      try { writeClaim(key); } catch (error) { onError(error); }
      if (disposed) return false;
      try { present(state); } catch (error) { onError(error); }
      try { await notify(state, key); } catch (error) { onError(error); }
      return true;
    };
    try { return await withLock('dsh-pomodoro-completion', run); }
    catch (error) { onError(error); return run(); }
  }
  return { completed, dispose() { disposed = true; } };
}
