import type { EditorDocument } from '../../src/floorplan/types/document';
import type { EntityAccess } from '../../src/floorplan/types/entity';
import type { Selection } from '../../src/floorplan/types/selection';
import { bindEntities } from '../../src/floorplan/types/entity';
import { readModule } from '../../src/floorplan/types/module';
import { moduleViewOf } from '../../src/floorplan/types/moduleRuntime';
import { NO_SELECTION } from '../../src/floorplan/types/selection';
import { DEFAULT_DISPLAY_PREFERENCES } from '../../src/floorplan/types/state';
import { lightingCodec } from '../../src/modules/lighting/codec';
import { fixtureEntities } from '../../src/modules/lighting/entities';

/**
 * The lighting module's entities, bound to a document a test controls.
 *
 * Core drag operations, box selection and the selection store all take an `EntityAccess` now
 * rather than importing lighting, so tests supply one the same way the activation registry
 * does — through `bindEntities`.
 */
export function fixtureEntityAccess(
  getDocument: () => EditorDocument,
  getSelection: () => Selection = () => NO_SELECTION
): EntityAccess {
  return bindEntities(fixtureEntities, () =>
    moduleViewOf(
      getDocument(),
      readModule(getDocument(), lightingCodec),
      getSelection(),
      DEFAULT_DISPLAY_PREFERENCES,
      'editor'
    )
  );
}
