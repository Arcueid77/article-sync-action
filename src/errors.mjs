export class SyncError extends Error {
  constructor(code, message) { super(message); this.name = 'SyncError'; this.code = code; }
}
export const fail = (code, message) => { throw new SyncError(code, message); };
