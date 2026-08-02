import type { LoadedDocument } from '../types/session';
import { decodeDocument } from './documentCodec';
import { ValidationError } from './ValidationError';

/**
 * File import. One of the four entry points, and since phase 3b none of them validates
 * anything itself: `decodeDocument` is the only code that sees hostile, legacy, or partial
 * input (invariant 9), and everything downstream receives a valid, normalized document.
 *
 * Behaviour inherited from phase 3a: only geometry failure rejects a document. A file whose
 * `lights` array is broken now **quarantines** where this file used to throw — deliberate,
 * under invariant 8. Geometry is the shared asset; one module's bad blob may not block it.
 */

export { ValidationError } from './ValidationError';

export async function importFromJSON(file: File): Promise<LoadedDocument> {
  return importFromString(await file.text());
}

export function importFromString(jsonString: string): LoadedDocument {
  let data: unknown;

  try {
    data = JSON.parse(jsonString);
  } catch {
    throw new ValidationError('Invalid JSON format');
  }

  return decodeDocument(data);
}
