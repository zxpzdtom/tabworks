export function takePendingForSocket(pending, id, socket) {
  const item = pending.get(id);
  if (!item || item.socket !== socket) return null;
  pending.delete(id);
  return item;
}

export function rejectPendingForSocket(pending, socket, error) {
  let rejected = 0;
  for (const [id, item] of pending.entries()) {
    if (item.socket !== socket) continue;
    clearTimeout(item.timer);
    pending.delete(id);
    item.reject(error);
    rejected++;
  }
  return rejected;
}

export function isApplicationSocketHealthy(socketConnected, lastResponseAt, now = Date.now(), staleAfterMs = 45_000) {
  return Boolean(socketConnected && lastResponseAt && now - lastResponseAt <= staleAfterMs);
}
