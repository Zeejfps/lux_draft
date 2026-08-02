import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';
import type { LoadedDocument, SaveInput } from '../types/session';
import { decodeDocument, encodeDocument } from './documentCodec';

/**
 * Share links. The payload is a v3 envelope built for `{ kind: 'share', moduleId }`: the
 * target module's slice compacted by its own `compactForShare`, every other live slice and
 * every quarantined blob omitted. A share link is a single-module view.
 *
 * The module id is a parameter rather than a constant, because core names no module. Since
 * phase 5 it is also in the path: new links are `#/{moduleId}/viewer?d=…`, and the bare
 * `#/viewer?d=…` that every earlier link used stays a **permanent** alias for the lighting
 * viewer (`app/routerStore.ts` owns the parse; this is the only other place that spells the
 * shape, and `tests/unit/app/routerStore.test.ts` asserts a generated link parses back).
 */

export interface ShareResult {
  url: string;
  length: number;
  warning?: string;
}

/**
 * Length thresholds, revisited in phase 5.
 *
 * The old pair was 2000 / 8000, and 8000 is a **server** limit — the default request-line cap
 * in nginx and IIS. A share payload lives in the URL *fragment*, which is never sent to a
 * server at all, so that number was never measuring the thing it named. The two limits a
 * fragment actually meets are:
 *
 * - ~2000 characters, where third-party surfaces (chat clients, ticket fields, QR codes) start
 *   truncating a pasted link. Unchanged, and it is the warning that matters in practice.
 * - ~32000 characters, the conservative floor across browsers' own address-bar and history
 *   limits. Below it a link works everywhere it is not being re-typed by someone else.
 *
 * Because a link now carries exactly one compacted module slice rather than every slice in the
 * document, the payload also got smaller — but that is a reason the warning fires less often,
 * not a reason to pick a different number.
 */
const TRUNCATION_RISK_LENGTH = 2000;
const BROWSER_LIMIT_LENGTH = 32000;

export function generateShareUrl({ document, carried }: SaveInput, moduleId: string): ShareResult {
  const payload = encodeDocument(document, carried, { kind: 'share', moduleId });
  const compressed = compressToEncodedURIComponent(JSON.stringify(payload));

  const base = `${window.location.origin}${window.location.pathname}`;
  const url = `${base}#/${moduleId}/viewer?d=${compressed}`;

  const length = url.length;
  let warning: string | undefined;

  if (length > BROWSER_LIMIT_LENGTH) {
    warning =
      'This URL is long enough that some browsers will refuse it. Export as a JSON file instead.';
  } else if (length > TRUNCATION_RISK_LENGTH) {
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
