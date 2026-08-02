# Studio Modularization Plan

**Goal:** extract a domain-agnostic floorplan editor from the lighting-specific code, so a second
domain (LVP flooring layout) can be built on top of it without forking or duplicating.

**Status:** proposed, not started.
**Created:** 2026-08-02
**Revised:** 2026-08-02 — rev 2, after design review. See §10 for what changed.

---

## 1. Decision summary

Three options were considered:

| Option                                           | Verdict                                                                                                                                                                                                                 |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Separate repo / fork the app                     | No — duplicates 11k LOC of editor code that will diverge immediately.                                                                                                                                                   |
| Monorepo with shared packages now                | No — premature at 19k LOC with one shipping app. Costs workspace tooling, build ordering, cross-package HMR friction, and version churn; buys nothing until there is a second consumer with a separate release cadence. |
| **Single repo, module registry, "Studio" shell** | **Yes.**                                                                                                                                                                                                                |

The decisive argument: the module-registry approach does not foreclose the monorepo. If flooring
later needs its own branding, deploy, or release cadence, it becomes a second Vite entry point from
the same source tree, and only then a package split. Going monorepo now is the only option that is
expensive to undo.

**Product shape:** one Studio, one document, switchable modes. The room polygon is drawn once and
both the lighting plan and the flooring plan live on it (kitchen remodel: same room, plan the cans
and plan the LVP). That is a real feature that two separate apps cannot offer, and it falls out for
free once the document is `geometry + modules`.

**Split the monorepo when** one of these is true, not before:

- A second consumer needs a different release cadence.
- The core is worth publishing independently.
- Build times become painful.

---

## 2. What is shared vs. domain-specific

Measured against the current tree (~19k LOC).

### Shared floorplan core (~11k LOC, reusable as-is)

| Area                  | Files                                                                                               | LOC   |
| --------------------- | --------------------------------------------------------------------------------------------------- | ----- |
| Scene, input          | `core/Scene.ts`, `core/InputManager.ts`                                                             | 372   |
| Geometry              | `geometry/` — SnapEngine, PolygonValidator, WallBuilder, DimensionLabel                             | 377   |
| Interactions          | `interactions/` — DragManager, InteractionManager, drag ops, drawing/selection/measurement handlers | 4234  |
| Rendering             | Wall, Door, Obstacle, DrawingPreview, Overlay, Measurement renderers                                | ~1400 |
| Persistence           | localStorage, jsonExport/Import, shareUrl                                                           | 584   |
| Controllers, services | SnapController, MeasurementController, GeometryService, SelectionService                            | 860   |
| UI shell              | FloatingPanel, Toolbar chrome, StatusBar, LengthInput, PropertyPanel, theming                       | ~1500 |

### Lighting-specific (stays, moves under `modules/lighting/`)

`lighting/` (IESParser, LightCalculator, LightManager, LightingStatsCalculator, SpacingAnalyzer,
LightIcon — 1119 LOC), `HeatmapRenderer`, `ShadowRenderer`, `BaseLightingRenderer`,
`LightRenderer`, `DeadZoneRenderer`, `SpacingWarningRenderer`, `RafterOverlay`,
`LightPlacementHandler`, all `Light*` / `Rafter*` / `*Stats*` Svelte components, and the
`deadZone` / `spacing` / `lightDefinitions` / `lightingStats` stores.

### Flooring-specific (new)

Plank layout engine (run direction, plank dimensions, stagger/offset rule, start course, expansion
gap), cut list + waste calculation, transitions/thresholds, underlayment notes, instanced plank
renderer, plank/course property panels.

### Domain luck worth calling out

- **Obstacles are already floor cutouts.** Islands, cabinets, hearths — the `Obstacle` polygon type
  and its drawing/drag/vertex-edit machinery transfer with zero changes.
- **Doors are already transition/threshold locations.** `Door` carries wall id + offset + width,
  which is exactly what a threshold needs.
- SnapEngine, PolygonValidator, DimensionLabel, and the measurement tool transfer unchanged.

---

## 3. Target structure

```
src/
  floorplan/          # domain-agnostic editor core
    core/             # Scene, InputManager
    geometry/         # SnapEngine, PolygonValidator, WallBuilder, DimensionLabel
    interactions/     # DragManager, InteractionManager, generic handlers + drag ops
    rendering/        # Wall, Door, Obstacle, DrawingPreview, Overlay, Measurement
    stores/           # roomStore, historyStore, settingsStore, selectionStore, themeStore
    persistence/      # documentCodec, localStorage, json, shareUrl (module-agnostic)
    types/            # geometry, state, interaction, selection
    ui/               # FloatingPanel, LengthInput, StatusBar, PropertyPanel primitives
  modules/
    codecs.ts         # eager barrel: every module's codec, statically imported
    lighting/
      codec.ts        # EAGER — schema, defaults, decode, compactForShare. No THREE, no Svelte.
      runtime.ts      # LAZY  — tools, layers, handlers, panels, stats
      ...             # types, stores, renderers, components
    flooring/         # (new) same shape
  app/                # Studio shell: mode picker, routing, toolbar composition, module registry
  main.ts
```

Boundaries are **directories plus lint rules**, not packages. Enforced via
`eslint-plugin-import` (or `eslint-plugin-boundaries`) in `eslint.config.js`:

- `src/floorplan/**` may not import from `src/modules/**` or `src/app/**`.
- `src/modules/a/**` may not import from `src/modules/b/**`.
- `src/modules/*/codec.ts` may not import from its own `runtime.ts`, from `three`, or from
  `*.svelte` — this is what keeps the eager codec bundle small.
- `src/app/**` may import from anywhere.

Worth adding on day one — the repo already runs `knip` and `jscpd`, so there is an existing appetite
for mechanical enforcement, and a lint rule is what actually keeps the seam from rotting. The
codec/runtime rule in particular is load-bearing: without it, one stray import silently pulls the
IES parser into every bundle.

---

## 4. The module contract

Split in two. **This split is the resolution to the lazy-loading/synchronous-persistence conflict:**
data handling is eager and synchronous, UI and rendering are lazy.

### 4.1 Codec — eager, synchronous, dependency-light

Every module's codec is statically imported by `modules/codecs.ts`. Codecs are pure data functions
with no `three` and no Svelte imports, so the eager cost is a few KB per module regardless of how
heavy the module's runtime is.

```ts
// src/floorplan/types/module.ts — core owns this type; it names no module
export interface ModuleCodec {
  readonly id: string;
  /** Current schema version this build writes. */
  readonly schemaVersion: number;

  /** Fresh slice for a document that has none. Must be cheap and pure. */
  defaultData(): unknown;

  /** Decode a stored blob. Never throws — returns a status. */
  decode(blob: ModuleBlob): DecodeResult;

  /** Strip derived/non-essential fields for share URLs. Defaults to identity. */
  compactForShare?(data: unknown): unknown;
}

/** On-disk envelope for one module's slice. */
export interface ModuleBlob {
  v: number;
  data: unknown;
}

export type DecodeResult =
  /** Understood and migrated to the current schema. */
  | { status: 'ok'; data: unknown }
  /** Written by a newer build. Blob is preserved verbatim; module is disabled this session. */
  | { status: 'unsupported'; writtenVersion: number; message: string }
  /** Corrupt or fails validation. Blob is preserved verbatim; module is disabled this session. */
  | { status: 'invalid'; message: string };
```

`decode` returning a status rather than throwing is what makes "preserve unknown blobs verbatim"
implementable: the pipeline can distinguish _absent_ (use `defaultData`), _known-and-valid_,
_known-but-future_, _known-but-corrupt_, and _unknown module id_ (no codec registered at all), and
handle each differently. See §6.2 for the policy table.

### 4.2 Runtime — lazy, loaded when a module is activated

```ts
export interface ModuleRuntime {
  readonly id: string;
  readonly label: string;

  tools: ToolDescriptor[];
  layers(scene: THREE.Scene): SceneLayer[];
  handlers(ctx: ModuleContext): IInteractionHandler[];
  /** Property panel per selection type this module owns (keyed by Selection.type). */
  panels: Record<string, ComponentType>;
  statsPanel?: ComponentType;
  shortcuts?: ShortcutDescriptor[];
}

export interface ToolDescriptor {
  id: string; // namespaced: 'lighting.place', 'flooring.origin'
  label: string;
  icon: string;
  shortcut?: string;
  /** Gate on document state, e.g. requires a closed polygon. */
  enabled?: (doc: RoomState) => boolean;
}

export interface SceneLayer {
  id: string;
  update(doc: RoomState, selection: Selection): void;
  setVisible(v: boolean): void;
  dispose(): void;
}
```

Registration pairs the two halves:

```ts
// src/app/moduleRegistry.ts
registry.register({
  codec: lightingCodec, // eager, already imported
  loadRuntime: () => import('../modules/lighting/runtime'), // lazy
});
```

`SceneLayer` is deliberately the shape the existing renderers almost have already — they all expose
`update(...)`, `setVisible(...)`, `dispose()`. The change is narrowing `update` to
`(doc, selection)` so `EditorRenderer` can hold a `SceneLayer[]` and loop, instead of naming each
renderer as a field with a bespoke method (`updateLights`, `updateDoors`, `updateObstacles`).

---

## 5. The three blockers in the core

These are the concrete things that make the core lighting-aware today. Everything else is a file
move.

### Blocker A — `RoomState.lights` is a hardcoded field

`src/types/state.ts:4-13` puts `lights: LightFixture[]` on the shared document, and
`src/types/index.ts` re-exports `./lighting` from the shared type barrel. `jsonImport.ts`
hard-requires `obj.lights` to be an array (`validateRoomState`), `jsonExport.ts` and `shareUrl.ts`
both read `state.lights` directly to find used light definitions, and `DEFAULT_ROOM_STATE` seeds
`lights: []`.

Target:

```ts
export interface RoomState {
  ceilingHeight: number;
  walls: WallSegment[];
  doors: Door[];
  obstacles: Obstacle[];
  isClosed: boolean;
  displayPreferences?: DisplayPreferences;

  /** Decoded, live module slices, keyed by module id. */
  modules: Record<string, unknown>;

  /**
   * Blobs that could not be decoded (unknown module id, future schema, or corrupt).
   * Never read, never mutated, written back verbatim on save. Not part of history.
   */
  readonly quarantined: Readonly<Record<string, ModuleBlob>>;
}
```

`quarantined` is what makes round-tripping actually work. Without a separate field, a preserved-but-
undecodable blob would sit in `modules` where module code and history would both treat it as live
state, and the first save from a build that lacks that module would silently drop or corrupt it.

`rafterConfig` moves into the lighting slice — a ceiling-joist concept with no meaning for flooring.
`ceilingHeight` stays on the core document (it is a room property), but note it is only _consumed_
by lighting today.

### Blocker B — the selection model is six parallel stores

`src/stores/appStore.ts` holds `selectedLightIds`, `selectedWallId`, `selectedVertexIndices`,
`selectedDoorId`, `selectedObstacleId`, `selectedObstacleVertexIndices`. Every `select*` function
manually clears the other five, and `clearSelection` / `setActiveTool` each clear all six. Adding
plank / course / transition selections would make that eleven mutually-clearing stores — the bug
surface grows quadratically.

Target: one store, a discriminated union. Cardinality is expressed structurally — `id: string` for
single-select kinds, `indices` / `ids` arrays for multi-select kinds — so "does this kind support
multi-select" is answered by the type rather than by convention.

```ts
// src/floorplan/types/selection.ts
export type Selection =
  | { kind: 'none' }
  | { kind: 'wall'; id: string }
  | { kind: 'vertex'; indices: number[] }
  | { kind: 'obstacle'; id: string }
  | { kind: 'obstacleVertex'; obstacleId: string; indices: number[] }
  | { kind: 'door'; id: string }
  /** Extension point: core stays module-agnostic. */
  | { kind: 'module'; moduleId: string; type: string; payload: unknown };

export const selection = writable<Selection>({ kind: 'none' });
```

Core variants keep their natural types — `vertex` carries real `number[]`, never stringified
indices. Modules declare their own payload types and narrow through a helper, so a module's own code
is fully typed even though the core sees `unknown`:

```ts
// modules/lighting/selection.ts
export type LightingSelection = { type: 'fixture'; ids: string[] };

export function asLighting(s: Selection): LightingSelection | null {
  return s.kind === 'module' && s.moduleId === 'lighting' ? (s.payload as LightingSelection) : null;
}
```

Panel dispatch key: `s.kind === 'module' ? \`${s.moduleId}.${s.type}\` : s.kind`.

Selecting anything replaces the whole value, so cross-clearing is structural rather than manual.

**Do this first.** It is the highest-value change, it pays for itself even if flooring is never
built, and it is the one most likely to surface latent bugs while the existing test suite is still
a valid net.

### Blocker C — `EditorRenderer`, `Canvas.svelte`, and `Toolbar.svelte` name every domain

- `EditorRenderer` (`src/rendering/EditorRenderer.ts:37-44`) constructs all seven renderers in its
  constructor including `LightRenderer`, and exposes `updateLights`, `setPreviewLight`,
  `setLightsVisible`, `setLightRadiusVisibility` as facade methods.
- `Canvas.svelte` (1052 lines) declares every renderer, every handler, and a `current*` mirror
  variable for each of the six selection stores as local `let`s, then wires them by hand in
  `onMount`.
- `Toolbar.svelte` (915 lines) hardcodes each tool button against the closed `Tool` union
  (`'select' | 'draw' | 'light' | 'door' | 'obstacle'`).

Target: `EditorRenderer` owns only the core layers and holds `SceneLayer[]` for the rest;
`Canvas.svelte` asks the registry for the active module's layers/handlers and loops;
`Toolbar.svelte` renders `registry.tools()`. This is the largest mechanical chunk of the work and
should be done _after_ A and B, because both simplify it substantially.

---

## 6. Document lifecycle

### 6.1 One decode pipeline

Today there are three entry points with three behaviors: `jsonImport.validateRoomState` validates
properly, `localStorage.loadFromLocalStorage` casts `JSON.parse(data) as RoomState` with three
ad-hoc shape-sniffing migrations and no validation, and `shareUrl.decodeShareData` delegates to
`importFromString`. Local storage is the weakest and will be the most common source of
pre-migration documents.

All three converge on one module:

```ts
// src/floorplan/persistence/documentCodec.ts
export function decodeDocument(raw: unknown): DecodedDocument;
export function encodeDocument(doc: RoomState, target: 'file' | 'local' | 'share'): unknown;

export interface DecodedDocument {
  doc: RoomState;
  /** Non-fatal problems to surface in the UI. */
  warnings: DocumentWarning[];
  /** Modules present in the file that could not be activated. */
  disabledModules: string[];
}
```

`decodeDocument` stays **synchronous** — it only touches eagerly-imported codecs (§4.1). Nothing in
the load path awaits a dynamic import, so `importFromString()` and `decodeShareData()` keep their
current signatures and no caller changes.

`encodeDocument` merges `quarantined` blobs back in verbatim and must be the only writer of the
envelope. `jsonExport.createExportData` is folded into it — today it independently reads
`state.lights` and owns its own version constant.

### 6.2 Failure policy

**Geometry is the shared asset; a broken module must never cost the user their room.** Only
geometry validation failure rejects the document.

| Case                                   | Action                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------- |
| Geometry invalid                       | **Reject the document.** Throw `ValidationError` as today.             |
| Module slice absent                    | Use `codec.defaultData()` on first read. Nothing written to the doc.   |
| Module slice `ok`                      | Live in `doc.modules[id]`.                                             |
| Module slice `unsupported` (newer `v`) | Quarantine verbatim, disable module, warn: "saved by a newer version". |
| Module slice `invalid`                 | Quarantine verbatim, disable module, warn with the codec's message.    |
| No codec registered for the id         | Quarantine verbatim, no warning (expected in single-module builds).    |

Disabled means: the mode is not selectable, its tools/layers/panels are absent, and its blob is
written back unchanged on save. The user can still edit geometry and use the other module.

### 6.3 Versioning — two levels, and the existing collision

`ExportData.version: 1 | 2` already exists (`jsonExport.ts:5`), but it versions the _light-definition
envelope_, not the document schema. Overloading it for the modular shape would give one number two
meanings and make the migration matrix ambiguous.

Resolution — two independent, explicitly-named levels:

- **Envelope**: `version: 3` means modules-shaped. Readers for `1` and `2` are kept **permanently**;
  they parse the legacy flat shape and lift `lights` / `rafterConfig` into `modules.lighting`.
- **Per-module**: each blob carries its own `v`, owned and migrated by that module's codec. A module
  can revise its schema without touching the envelope version or any other module.

Legacy share URLs encode envelope 1 and 2. Those decoders are load-bearing forever, not transitional.

### 6.4 History and derived data

`historyStore` subscribes to `roomStore`, compares with `JSON.stringify`, and `structuredClone`s the
entire `RoomState` into a 50-entry stack. Three consequences once modules coexist:

**(a) Derived data must not enter the document.** Planks are a pure function of
(polygon, obstacles, `LayoutConfig`). Storing generated planks would put thousands of objects into
every one of 50 history snapshots. **Store the config; derive the layout.** The computed layout lives
in a memoized derived store outside `RoomState` and is never persisted, never cloned, never diffed.
This also gives correct undo granularity for free — undo steps back through user intent
("changed stagger to 1/3"), not through machine output.

This is a hard rule for every module: **`modules[id]` holds input, never output.**

**(b) Undo stays global across the whole document, not per-module.** A single action can touch both
geometry and a module slice (dragging a wall reflows the plank layout's inputs), so per-module stacks
would either desync or need cross-stack coordination. Mitigation for the "undo did something I can't
see" problem: history entries carry a label and an originating module id, and the UI names what will
be undone. Revisit only if cross-mode undo confusion shows up in real use.

**(c) Mode switching must not write to the document.** An absent module slice resolves to
`defaultData()` **at read time**; activation never writes. Without this, switching to flooring for
the first time would push a history entry, dirty the autosave, and make an empty mode visit look like
an edit. Same rule for the module's own lazy initialization.

**Follow-up, not a blocker:** the `JSON.stringify` equality check runs on every `roomStore` emission
and is already O(document). It gets worse as slices grow. Replace with a dirty-flag or structural
comparison once profiling justifies it — track separately from this plan.

### 6.5 Share URLs are module-aware

`generateShareUrl` always emits `#/viewer?d=...` and hardcodes lighting's payload shape. Target:

- New links emit `#/{moduleId}/viewer?d=...`. The module to open is in the path — not inferred from
  persisted UI state, which does not travel with the link.
- Legacy `#/viewer` remains a permanent alias for `#/lighting/viewer`.
- The share dialog picks the module explicitly, defaulting to the active mode.
- Sharing calls `compactForShare` on the target module and **omits other modules' slices entirely**
  — a share link is a single-module view, and the size budget (8000-char warning threshold) does not
  survive carrying both. The dialog says so when the document has more than one populated module.

---

## 7. Phasing

Each phase is independently shippable and leaves `main` green. Run `npm run test:run`,
`npm run type-check`, and `npm run lint` at every phase boundary.

Phases 2 and 3 divide cleanly: **phase 2 is the data plane, phase 3 is the UI plane.**

### Phase 0 — scaffolding (½ day)

- Add `docs/plans/` (this file).
- Add the import-boundary lint rule with the target directory layout allow-listed, initially with
  no directories to police. Landing the rule before the moves means each subsequent phase is
  validated as it lands.

### Phase 1 — unified selection (2–3 days) ← **start here**

- Introduce the `Selection` union + store in `floorplan/stores/selectionStore.ts`.
- **Introduce a minimal panel registry here** — a plain `Map<string, ComponentType>` populated
  statically in `App.svelte`. ~20 lines, no module system, no dynamic import. Phase 3 changes only
  where the map is _populated from_ (module manifests instead of a literal); the dispatch seam in
  `App.svelte` is written once, in this phase.
- Migrate call sites store-by-store, keeping derived shims (`selectedWallId = derived(selection, …)`)
  so components convert incrementally rather than in one commit.
- Delete the shims and the six stores.
- **Risk:** `Canvas.svelte` mirrors each store into a local `current*` variable; those subscriptions
  must be converted together or the canvas will render against stale selection.
- **Ships value alone:** removes the manual cross-clearing bug class.

### Phase 2 — document restructure + persistence pipeline (4–5 days)

- Define `ModuleCodec` / `ModuleBlob` / `DecodeResult` in `floorplan/types/module.ts`, and the codec
  registry in `modules/codecs.ts`. No runtime manifest yet.
- Write `lighting/codec.ts` — the only module codec at this point.
- Build `documentCodec.ts` (§6.1) and route **all three** entry points through it: `jsonImport`,
  `jsonExport`, `localStorage`, plus `shareUrl` on both sides.
- `RoomState.modules` + `RoomState.quarantined`; move `lights`, `rafterConfig`, dead-zone and
  spacing config into `modules.lighting`.
- Envelope `version: 3` with permanent readers for 1 and 2 (§6.3).
- Enforce §6.4(c): absent slices resolve to `defaultData()` at read time.
- **Test first**, before changing any types: fixtures for envelope v1, v2, a future-version module
  blob, a corrupt module blob, and an unknown module id — asserting the migrated shape, the
  quarantine behavior, and byte-identical round-trip of quarantined blobs.
- **Risk:** share URLs in the wild encode envelope 1 and 2. Those readers are permanent.

### Phase 3 — runtime manifest + move lighting (4–5 days)

- Define `ModuleRuntime` and the full registry pairing codec + `loadRuntime`.
- Physically move lighting files under `src/modules/lighting/`; author `runtime.ts`.
- Refactor `EditorRenderer` to `SceneLayer[]`; refactor `Canvas.svelte` and `Toolbar.svelte` to
  drive off the registry; repoint the phase-1 panel map at module manifests.
- Turn on the boundary lint rules for real, including the codec/runtime isolation rule.
- **This phase proves the seam using the module that already works** — if the contract is wrong,
  it is wrong against known-good behavior with an existing test suite, not against new flooring code.

### Phase 4 — Studio shell + routing (1–2 days)

- Extend `routerStore` beyond `'editor' | 'viewer'` to `#/{module}`, `#/{module}/viewer`, plus a
  mode-picker landing route.
- Preserve legacy URLs permanently: bare `#/` and `#/viewer` resolve to lighting.
- Module-aware share links (§6.5).
- Lazy-load runtimes via dynamic `import()`; verify with a bundle-size check that the IES parser and
  heatmap shaders are absent from the initial chunk.

### Phase 5 — flooring module (scope TBD, largest phase)

- Types: `PlankSpec` (width, length, thickness), `LayoutConfig` (run angle, start corner, stagger
  rule, min end-cut, expansion gap, row offset pattern), `Transition`.
- `PlankLayoutEngine`: pure function of (polygon, obstacles, config) → planks + cut list + waste %.
  **Output is derived, never stored** (§6.4a) — memoized derived store, not `RoomState`.
- `PlankRenderer`: **`THREE.InstancedMesh` from the start.** A 400 sqft floor at 7"×48" planks is
  ~200 planks; the existing renderers rebuild meshes on every store change, which is fine at ~20
  lights and is not fine at 200+ planks with per-plank hit-testing.
- Panels: layout config, plank spec, cut list / waste summary.
- Reuse `Obstacle` polygons as cutouts and `Door` positions as threshold candidates directly.

---

## 8. Risks

| Risk                                                                 | Mitigation                                                                                     |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Big-bang refactor stalls mid-way                                     | Six independently shippable phases; phases 1 and 2 have standalone value.                      |
| Existing share URLs break                                            | Envelope 1/2 readers are permanent; fixture tests land before the type change.                 |
| Undecodable module data silently lost on save                        | `quarantined` field + byte-identical round-trip test in phase 2.                               |
| Codec bundle bloat defeats lazy loading                              | Lint rule bans `three` / `*.svelte` / `runtime.ts` imports from `codec.ts`; bundle check in 4. |
| `Canvas.svelte` (1052 lines) is a merge-conflict magnet              | Do phases 1–3 on short-lived branches; avoid parallel feature work in that file.               |
| Module contract is wrong                                             | Phase 3 validates it against lighting (known-good, tested) before flooring exists.             |
| History snapshots balloon with plank data                            | Hard rule: `modules[id]` holds input, never output (§6.4a).                                    |
| Plank rendering perf                                                 | `InstancedMesh` + spatial hit-testing from the first commit, not retrofitted.                  |
| Product focus dilution (lighting designers vs. flooring contractors) | Mitigate with branding and entry points in phase 4, not with a code split.                     |

---

## 9. Out of scope

- Monorepo / workspace migration (revisit against the triggers in §1).
- 3D flooring visualization.
- Server-side persistence or accounts.
- Replacing `historyStore`'s `JSON.stringify` diffing (§6.4 follow-up) — track separately.
- Renaming the `lumen_2d` package (cosmetic; do it if and when the Studio ships publicly).

---

## 10. Revision log

**Rev 2 (2026-08-02)** — design review. Changes:

1. **Manifest split into eager `ModuleCodec` + lazy `ModuleRuntime`** (§4). Resolves the conflict
   between lazy module loading and synchronous `importFromString` / `decodeShareData`. Decode is
   synchronous and needs no dynamic import; only UI and rendering are lazy.
2. **`DecodeResult` status union + per-module `v`** (§4.1, §6.2, §6.3), replacing
   `migrate(raw): unknown` which could not distinguish absent / valid / future / corrupt / unknown,
   and could not implement "preserve verbatim". Added `RoomState.quarantined` so preserved blobs are
   structurally separate from live state. Failure policy: only geometry failure rejects a document.
3. **History rules** (§6.4). Rev 1 did not consider that `historyStore` `structuredClone`s the whole
   `RoomState` 50 times over. Resolved at the source: derived data never enters the document
   (planks are computed from config), undo stays global with labeled entries, and mode switching
   never writes.
4. **`Selection` is a discriminated union** (§5B) instead of `{kind: string, ids: string[]}`.
   Vertex indices stay `number[]`. Module selections use a typed `module` variant so the core names
   no module while modules keep internal type safety.
5. **Phase 1 no longer depends on phase 3.** A minimal static panel `Map` is introduced in phase 1;
   phase 3 changes only its population source.
6. **One canonical decode pipeline** (§6.1) covering `localStorage` (which bypassed validation
   entirely) and `jsonExport` (which independently read `state.lights` and owned its own version
   constant). Envelope-vs-module version collision with the existing `ExportData.version: 1 | 2`
   resolved as two explicit levels (§6.3).
7. **Module-aware share routes** (§6.5): `#/{module}/viewer`, legacy `#/viewer` a permanent lighting
   alias, single-module payloads for size.

Phase 2 grew from 2–3 to 4–5 days absorbing the persistence pipeline; the total is roughly unchanged
since phase 3 shed the data-plane work.
