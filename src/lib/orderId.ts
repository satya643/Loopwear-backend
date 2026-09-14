/** Human-readable order ids like ORD-8K3F9A, matching the Concourse's ORD-8841 style. */
export function generateOrderId(): string {
  const stamp = Date.now().toString(36).toUpperCase().slice(-4);
  const rand = Math.random().toString(36).toUpperCase().slice(2, 4);
  return `ORD-${stamp}${rand}`;
}
