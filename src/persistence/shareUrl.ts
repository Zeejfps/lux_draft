import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import type { LoadedDocument, SaveInput } from '../types/session';
import { decodeDocument, encodeDocument } from './documentCodec';

/**
 * Share links. The payload is a v3 envelope built for `{ kind: 'share', moduleId }`: the
 * target module's slice compacted by its own `compactForShare`, every other live slice and
 * every quarantined blob omitted. A share link is a single-module view.
 *
 * The module id is a parameter rather than a constant, because core names no module; phase 5
 * puts it in the URL path (`#/{moduleId}/viewer`) as well. `#/viewer` stays a permanent alias.
 */

export interface ShareResult {
  url: string;
  length: number;
  warning?: string;
}

export function generateShareUrl({ document, carried }: SaveInput, moduleId: string): ShareResult {
  const payload = encodeDocument(document, carried, { kind: 'share', moduleId });
  const compressed = compressToEncodedURIComponent(JSON.stringify(payload));

  const base = `${window.location.origin}${window.location.pathname}`;
  const url = `${base}#/viewer?d=${compressed}`;

  const length = url.length;
  let warning: string | undefined;

  if (length > 8000) {
    warning =
      'This URL is very long and may not work in all browsers. Consider exporting as a JSON file instead.';
  } else if (length > 2000) {
    warning = 'This URL is long. Some platforms may truncate it when sharing.';
  }

  return { url, length, warning };
}

/**
 * Links in the wild encode envelope 1 and 2 as well as 3, so this goes through the same
 * permanent readers as every other entry point.
 */
export function decodeShareData(compressed: string): LoadedDocument {
  const json = decompressFromEncodedURIComponent(compressed);
  if (!json) {
    throw new Error('Failed to decompress shared data. The URL may be corrupted.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('Failed to read shared data. The URL may be corrupted.');
  }
  return decodeDocument(raw);
}
