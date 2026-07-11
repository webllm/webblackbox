/**
 * Releases transport-scoped state for a disconnected content port.
 *
 * Exact document authorization is session-scoped and must outlive transient
 * ports. Navigation, tab removal, and capture shutdown own that lifecycle.
 */
export function disconnectContentPort<TPort>(connectedPorts: Set<TPort>, port: TPort): void {
  connectedPorts.delete(port);
}
