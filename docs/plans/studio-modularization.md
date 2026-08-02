# Studio Modularization Plan

**Goal:** extract a domain-agnostic floorplan editor from the lighting-specific code, so a second
domain (LVP flooring layout) can be built on top of it without forking or duplicating.

**Status:** proposed, not started.
**Created:** 2026-08-02

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
    persistence/      # localStorage, json, shareUrl (module-agnostic)
    types/            # geometry, state, interaction
    ui/               # FloatingPanel, LengthInput, StatusBar, PropertyPanel primitives
  modules/
    lighting/         # types, stores, renderers, handlers, panels, tools, module manifest
    flooring/         # (new) same shape
  app/                # Studio shell: mode picker, routing, toolbar composition, module registry
  main.ts
```

Boundaries are **directories plus lint rules**, not packages. Enforced via
`eslint-plugin-import` (or `eslint-plugin-boundaries`) in `eslint.config.js`:

- `src/floorplan/**` may not import from `src/modules/**` or `src/app/**`.
- `src/modules/a/**` may not import from `src/modules/b/**`.
- `src/app/**` may import from anywhere.

This is worth adding on day one — the repo already runs `knip` and `jscpd`, so there is an existing
appetite for mechanical enforcement, and a lint rule is what actually keeps the seam from rotting.

---

## 4. The module contract

A module is a manifest object. Nothing in `floorplan/` may name a specific module; the registry in
`app/` holds them.

```ts
// src/app/moduleRegistry.ts
export interface StudioModule {
  id: string; // 'lighting' | 'flooring'
  label: string;

  /** Default state for this module's slice of the document. */
  defaultData: () => unknown;
  /** Validate + migrate `doc.modules[id]` on load. Throws on invalid. */
  migrate: (raw: unknown) => unknown;
  /** Optional: strip non-essential fields for share URLs (size budget). */
  compactForShare?: (data: unknown) => unknown;

  /** Tools contributed to the toolbar. */
  tools: ToolDescriptor[];
  /** Scene layers, constructed with the THREE.Scene. */
  layers: (scene: THREE.Scene) => SceneLayer[];
  /** Interaction handlers registered with InteractionManager. */
  handlers: (ctx: ModuleContext) => IInteractionHandler[];
  /** Property panel component per selection kind this module owns. */
  panels: Record<string, ComponentType>;
  /** Optional analysis/stats panel. */
  statsPanel?: ComponentType;
  /** Keyboard shortcuts scoped to this module. */
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

`SceneLayer` is deliberately the shape the existing renderers almost have already — they all expose
`update(...)`, `setVisible(...)`, `dispose()`. The change is narrowing the `update` signature to
`(doc, selection)` so `EditorRenderer` can hold a `SceneLayer[]` and loop, instead of naming each
renderer as a field with a bespoke method (`updateLights`, `updateDoors`, `updateObstacles`).

---

## 5. The three blockers in the core

These are the concrete things that make the core lighting-aware today. Everything else is a file
move.

### Blocker A — `RoomState.lights` is a hardcoded field

`src/types/state.ts:4-13` puts `lights: LightFixture[]` on the shared document, and
`src/types/index.ts` re-exports `./lighting` from the shared type barrel. `jsonImport.ts`
hard-requires `obj.lights` to be an array (`validateRoomState`), `shareUrl.ts` reads
`state.lights` directly to find used light definitions, and `DEFAULT_ROOM_STATE` seeds `lights: []`.

Target:

```ts
export interface RoomState {
  ceilingHeight: number;
  walls: WallSegment[];
  doors: Door[];
  obstacles: Obstacle[];
  isClosed: boolean;
  displayPreferences?: DisplayPreferences;
  modules: Record<string, unknown>; // 'lighting' → {lights, rafterConfig, deadZone, spacing}
}
```

`rafterConfig` moves into the lighting module slice — it is a ceiling-joist concept with no meaning
for flooring. `ceilingHeight` stays on the core document (it is a room property, and flooring may
still want it for volume/context), but note it is only _consumed_ by lighting today.

Persistence becomes module-agnostic: `jsonImport` validates the geometry fields itself, then hands
each `modules[id]` blob to that module's `migrate`. Unknown module ids are preserved verbatim so a
document saved with both modules still round-trips when only one is loaded.

### Blocker B — the selection model is six parallel stores

`src/stores/appStore.ts` holds `selectedLightIds`, `selectedWallId`, `selectedVertexIndices`,
`selectedDoorId`, `selectedObstacleId`, `selectedObstacleVertexIndices`. Every `select*` function
manually clears the other five, and `clearSelection` / `setActiveTool` each clear all six. Adding
plank / course / transition selections would make that eleven mutually-clearing stores — the bug
surface grows quadratically.

Target: one store.

```ts
export interface Selection {
  kind: string; // 'wall' | 'vertex' | 'obstacle' | 'lighting.fixture' | ...
  ids: string[]; // vertex/obstacle-vertex use stringified indices
  parentId?: string; // obstacle vertex → obstacle id
}
export const selection = writable<Selection>({ kind: 'none', ids: [] });
```

Selecting anything replaces the whole value, so cross-clearing is structural rather than manual.
Panel dispatch becomes `registry.panelFor(selection.kind)` instead of the current chain of
`{#if $selectedWallId}` blocks in `App.svelte`.

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

## 6. Phasing

Each phase is independently shippable and leaves `main` green. Run `npm run test:run`,
`npm run type-check`, and `npm run lint` at every phase boundary.

### Phase 0 — scaffolding (½ day)

- Add `docs/plans/` (this file).
- Add the import-boundary lint rule with the target directory layout allow-listed, initially with
  no directories to police. Landing the rule before the moves means each subsequent phase is
  validated as it lands.

### Phase 1 — unified selection (2–3 days) ← **start here**

- Introduce `Selection` + `selection` store in `floorplan/stores/selectionStore.ts`.
- Migrate call sites store-by-store, keeping derived shims (`selectedWallId = derived(selection, …)`)
  so components can be converted incrementally rather than in one commit.
- Convert `App.svelte`'s panel `{#if}` chain to a lookup.
- Delete the shims and the six stores.
- **Risk:** `Canvas.svelte` mirrors each store into a local `current*` variable; those subscriptions
  must be converted together or the canvas will render against stale selection.
- **Ships value alone:** removes the manual cross-clearing bug class.

### Phase 2 — document restructure (2–3 days)

- `RoomState.modules: Record<string, unknown>`; move `lights`, `rafterConfig`, dead-zone and
  spacing config into `modules.lighting`.
- Rewrite `jsonImport.validateRoomState` to validate geometry only and delegate module blobs.
- Add a v1→v2 migration in `localStorage.loadFromLocalStorage` (it already has an ad-hoc migration
  pattern for `doors` / `obstacles` / `swingSide` — extend it, and add a `version` field so future
  migrations are not shape-sniffed).
- Update `shareUrl.createSharePayload` to call each module's `compactForShare`.
- **Test first:** add a persistence test that loads a pre-migration fixture and asserts the
  migrated shape, before changing the types.
- **Risk:** shared URLs in the wild encode the old shape. The v1 reader must be kept indefinitely,
  not just through the transition.

### Phase 3 — module registry + move lighting (4–5 days)

- Define `StudioModule` and the registry in `src/app/`.
- Physically move lighting files under `src/modules/lighting/`; author its manifest.
- Refactor `EditorRenderer` to `SceneLayer[]`; refactor `Canvas.svelte` and `Toolbar.svelte` to
  drive off the registry.
- Turn on the boundary lint rules for real.
- **This phase proves the seam using the module that already works** — if the contract is wrong,
  it is wrong against known-good behavior with an existing test suite, not against new flooring code.

### Phase 4 — Studio shell + routing (1–2 days)

- Extend `routerStore` beyond the current `'editor' | 'viewer'` union to
  `#/lighting`, `#/lighting/viewer`, `#/flooring`, plus a mode picker landing route.
- Preserve existing URLs: bare `#/` and `#/viewer` must keep resolving to lighting, since shared
  links use them.
- Lazy-load module bundles via dynamic `import()` so the flooring build does not ship the IES
  parser or the heatmap shaders.

### Phase 5 — flooring module (scope TBD, largest phase)

- Types: `PlankSpec` (width, length, thickness), `LayoutConfig` (run angle, start corner, stagger
  rule, min end-cut, expansion gap, row offset pattern), `Course`, `Plank`, `Transition`.
- `PlankLayoutEngine`: generate courses over the room polygon minus obstacle polygons, honoring
  stagger rules and minimum end-piece length; return planks + cut list + waste percentage.
- `PlankRenderer`: **use `THREE.InstancedMesh` from the start.** A 400 sqft floor at 7"×48" planks
  is ~200 planks; the existing renderers rebuild meshes on every store change, which is fine at ~20
  lights and is not fine at 200+ planks with per-plank hit-testing.
- Panels: layout config, plank spec, cut list / waste summary.
- Reuse `Obstacle` polygons as cutouts and `Door` positions as threshold candidates directly.

---

## 7. Risks

| Risk                                                                 | Mitigation                                                                         |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Big-bang refactor stalls mid-way                                     | Five independently shippable phases; phases 1 and 2 have standalone value.         |
| Existing share URLs break                                            | Keep the v1 decoder permanently; add a fixture test before touching the types.     |
| `Canvas.svelte` (1052 lines) is a merge-conflict magnet              | Do phases 1–3 on short-lived branches; avoid parallel feature work in that file.   |
| Module contract is wrong                                             | Phase 3 validates it against lighting (known-good, tested) before flooring exists. |
| Flooring bundle bloat                                                | Dynamic `import()` per module; verify with a bundle-size check in phase 4.         |
| Plank rendering perf                                                 | `InstancedMesh` + spatial hit-testing from the first commit, not retrofitted.      |
| Product focus dilution (lighting designers vs. flooring contractors) | Mitigate with branding and entry points in phase 4, not with a code split.         |

---

## 8. Out of scope

- Monorepo / workspace migration (revisit against the triggers in §1).
- 3D flooring visualization.
- Server-side persistence or accounts.
- Renaming the `lumen_2d` package (cosmetic; do it if and when the Studio ships publicly).
