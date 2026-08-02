import type { ModuleDefinition } from '../floorplan/types/moduleRegistry';
import { registerModule } from '../floorplan/types/moduleRegistry';
import type { LightingData } from './lighting/codec';
import { lightingCodec } from './lighting/codec';
import { lightingCommands } from './lighting/commands';
import type { FlooringData } from './flooring/codec';
import { flooringCodec } from './flooring/codec';
import { flooringCommands } from './flooring/commands';

/**
 * The eager barrel: every installed module's codec and command table, statically imported.
 *
 * This is what reconciles lazy modules with synchronous persistence (invariant 7). Codecs and
 * command handlers are in the initial chunk; tools, layers, panels and shaders are not, and
 * the lint rules on each module's `codec.ts` / `commands.ts` keep it that way.
 *
 * Registration happens at import time, so importing this file anywhere in the entry graph is
 * enough for `decodeDocument` to see every module. Each definition is a module-level constant
 * so `installModules()` is idempotent — re-running it after a test clears the registry
 * re-registers the same values, and running it twice without a clear is a no-op rather than a
 * duplicate-id throw.
 */

const lightingModule: ModuleDefinition<LightingData> = {
  codec: lightingCodec,
  commands: lightingCommands,
  label: 'Lighting',
  /**
   * The lazy half. A dynamic `import()` is the shape `loadRuntime` exists for, so `runtime.ts`
   * — and with it THREE, the IES parser, the heatmap shaders and every lighting panel — stays
   * out of the eager chunk this barrel is in. Phase 5 routes on it and adds the bundle check.
   */
  loadRuntime: () => import('./lighting/runtime').then((m) => m.lightingRuntime),
  // The viewer page builds lighting's layers by hand; see `ModuleDefinition.viewable`.
  viewable: true,
};

const flooringModule: ModuleDefinition<FlooringData> = {
  codec: flooringCodec,
  commands: flooringCommands,
  label: 'Flooring',
  loadRuntime: () => import('./flooring/runtime').then((m) => m.flooringRuntime),
  // Editor-only for now: the viewer is not module-generic, and giving it an activation scope is
  // its own piece of work. `#/flooring/viewer` resolves to the mode picker meanwhile.
  viewable: false,
};

export function installModules(): void {
  registerModule(lightingModule);
  registerModule(flooringModule);
}

installModules();
