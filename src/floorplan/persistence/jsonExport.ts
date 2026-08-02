import type { SaveInput } from '../types/session';
import type { DocumentEnvelopeV3 } from './envelope';
import { encodeDocument } from './documentCodec';

/**
 * File export. `createExportData` folded into `encodeDocument` (invariant 9): the envelope is
 * the one on-disk shape, it carries every module's slice at that module's own schema version,
 * and it merges quarantined blobs back verbatim so exporting never drops data this build could
 * not read.
 *
 * The old `ExportData` wrapper (`{ version: 1 | 2, roomState, lightDefinitions }`) is gone from
 * the write path; `toEnvelopeV3` still **reads** it, permanently.
 */

export function createExportData({ document, carried }: SaveInput): DocumentEnvelopeV3 {
  return encodeDocument(document, carried, { kind: 'file' });
}

export function getJSONString(input: SaveInput): string {
  return JSON.stringify(createExportData(input), null, 2);
}

export function exportToJSON(input: SaveInput): void {
  const json = getJSONString(input);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = `lumen2d-design-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
