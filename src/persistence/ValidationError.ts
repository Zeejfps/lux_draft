/**
 * The one rejection. Geometry is the shared asset, so **only geometry validation failure
 * rejects a document** (invariant 8); every module-data problem quarantines instead.
 *
 * Lives in its own file so `documentCodec` can throw it without importing `jsonImport`, which
 * still reaches the global light-definitions store.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
