/**
 * Public surface of @agent-studio/event-bridge.
 *
 * Importing the package as a library gives you `startBridge()` plus the
 * StateStore / SessionRecorder helpers for tests and the mock generator.
 */

export { startBridge } from './server.js';
export { StateStore } from './state-store.js';
export { SessionRecorder, type SessionFile, type RecordedEvent } from './session.js';
