import type { EditorDocument } from '../types/document';
import type { Interaction } from '../types/interaction';
import { applyCommand } from './registry';

export { applyCommand, commandLabel, registeredCommandTypes } from './registry';
export { assertCommandIsSerializable, valueEqual } from './serializable';

/**
 * The live view: the committed document with the candidate command applied.
 * Preview and commit apply the identical command to the identical base, so the last frame the
 * user saw is by construction the state that gets committed (invariant 3).
 */
export function previewDocument(doc: EditorDocument, interaction: Interaction): EditorDocument {
  return interaction.kind === 'commandPreview' ? applyCommand(doc, interaction.command) : doc;
}
