<script lang="ts">
  import { createEventDispatcher, onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { Scene } from '../core/Scene';
  import { type InputEvent, InputManager } from '../core/InputManager';
  import { EditorRenderer } from '../rendering/EditorRenderer';
  import { WallBuilder } from '../geometry/WallBuilder';
  import { PolygonValidator } from '../geometry/PolygonValidator';
  import { MeasurementController, SnapController } from '../controllers';
  import {
    canPlaceDoors,
    closeRoom,
    deleteVertex,
    getVertices,
    getDoorsByWallId,
    insertVertexOnWall,
    roomBounds,
    roomStore,
    addDoor,
    removeDoor,
    addObstacle,
    removeObstacle,
    previewCommand,
    commitInteraction,
    cancelInteraction,
  } from '../stores/roomStore';
  import {
    activeTool,
    isDrawingEnabled,
    isModuleToolActive,
    isDoorPlacementEnabled,
    isObstacleDrawingEnabled,
    shouldFitCamera,
    viewMode,
  } from '../stores/appStore';
  import {
    clearSelection,
    retainBoxCandidates,
    selection,
    selectDoor,
    selectEntity,
    selectInBox,
    selectObstacle,
    selectObstacleVertex,
    selectObstacleVerticesInBox,
    selectVertex,
    selectWall,
    setObstacleVertexSelection,
  } from '../stores/selectionStore';
  import {
    getSelectedDoorId,
    getSelectedObstacleId,
    getSelectedObstacleVertexIndices,
    getSelectedVertexIndices,
    type Selection,
  } from '../types/selection';
  import { sessionStore } from '../stores/sessionStore';
  import {
    activeEntities,
    activeModule,
    activeView,
    setModuleScene,
  } from '../stores/moduleActivation';
  import { NO_ENTITIES, type EntityAccess } from '../types/entity';
  import { getDoorPlacementSettings } from '../stores/doorStore';
  import { displayPreferences, toggleUnitFormat } from '../stores/settingsStore';
  import { isMeasuring } from '../stores/measurementStore';
  import type {
    BoundingBox,
    BoxSelectionState,
    DisplayPreferences,
    EditorDocument,
    InteractionContext,
    Tool,
    Vector2,
    ViewMode,
  } from '../types';
  import type { ModuleView } from '../types/moduleRuntime';

  // Interaction system imports
  import {
    BoxSelectionHandler,
    createDefaultKeyboardShortcuts,
    DoorDragOperation,
    DragManager,
    DrawingHandler,
    DoorPlacementHandler,
    EMPTY_MODIFIERS,
    GrabModeDragOperation,
    GrabModeHandler,
    InteractionManager,
    KeyboardShortcutManager,
    MeasurementHandler,
    ObstacleDrawingHandler,
    ObstacleDragOperation,
    ObstacleVertexDragOperation,
    SelectionHandler,
    UnifiedDragOperation,
    WallDragOperation,
  } from '../interactions';

  // ============================================
  // Component State
  // ============================================

  let container: HTMLDivElement;
  let scene: Scene;
  let inputManager: InputManager;
  let editorRenderer: EditorRenderer;
  let wallBuilder: WallBuilder;
  let obstacleWallBuilder: WallBuilder;
  let polygonValidator: PolygonValidator;
  let snapController: SnapController;
  let measurementController: MeasurementController;
  let animationFrameId: number;

  // Interaction system
  let dragManager: DragManager;
  let interactionManager: InteractionManager;
  let keyboardShortcutManager: KeyboardShortcutManager;

  // Handlers
  let drawingHandler: DrawingHandler;
  let obstacleDrawingHandler: ObstacleDrawingHandler;
  let doorPlacementHandler: DoorPlacementHandler;
  let boxSelectionHandler: BoxSelectionHandler;
  let measurementHandler: MeasurementHandler;
  let grabModeHandler: GrabModeHandler;
  let selectionHandler: SelectionHandler;

  const dispatch = createEventDispatcher<{
    mouseMove: { worldPos: Vector2 };
    snapChange: { snapType: string };
    measurement: {
      from: Vector2;
      to: Vector2;
      deltaX: number;
      deltaY: number;
      distance: number;
    } | null;
  }>();

  // ============================================
  // Reactive State
  // ============================================

  let currentMousePos: Vector2 = { x: 0, y: 0 };
  let currentWalls: import('../types').WallSegment[] = [];
  let currentDoors: import('../types').Door[] = [];
  let currentObstacles: import('../types').Obstacle[] = [];
  let currentViewMode: ViewMode = 'editor';
  let currentDocument: EditorDocument;
  let currentBounds: BoundingBox;
  let currentDisplayPrefs: DisplayPreferences;
  let currentTool: Tool = 'select';
  let isDrawing = false;
  let isModuleTool = false;
  let isPlacingDoors = false;
  let isObstacleDrawing = false;
  // One selection value, one subscription. Everything below is derived from it in one pass.
  let currentSelection: Selection = { kind: 'none' };
  let currentSelectedDoorId: string | null = null;
  let currentSelectedObstacleId: string | null = null;
  let currentSelectedVertexIndex: number | null = null;
  let currentSelectedVertexIndices: Set<number> = new Set();
  let currentSelectedObstacleVertexIndices: Set<number> = new Set();
  let currentSelectedEntityIds: string[] = [];

  // Interaction state
  let isGrabMode = false;
  let boxSelectionState: BoxSelectionState = {
    isSelecting: false,
    startPosition: null,
    currentPosition: null,
  };

  // ============================================
  // Store Subscriptions
  // ============================================

  $: currentViewMode = $viewMode;
  $: currentDocument = $roomStore;
  $: currentWalls = currentDocument.geometry.boundary.walls;
  $: currentDoors = currentDocument.geometry.doors;
  $: currentObstacles = currentDocument.geometry.obstacles;
  $: currentBounds = $roomBounds;
  $: currentTool = $activeTool;
  $: isDrawing = $isDrawingEnabled;
  $: isModuleTool = $isModuleToolActive;
  $: isPlacingDoors = $isDoorPlacementEnabled;
  $: isObstacleDrawing = $isObstacleDrawingEnabled;
  $: currentDisplayPrefs = $displayPreferences;

  // Clear door preview when exiting door placement mode
  $: if (editorRenderer && !isPlacingDoors) {
    editorRenderer.clearDoorPreview();
  }

  // Clear vertex preview when exiting draw mode
  $: if (editorRenderer && !isDrawing) {
    editorRenderer.setPreviewVertex(null);
  }

  // Clear obstacle drawing preview when exiting obstacle drawing mode
  $: if (editorRenderer && !isObstacleDrawing) {
    editorRenderer.setPreviewVertex(null);
  }

  $: currentSelection = $selection;
  $: {
    const vertexIndices = getSelectedVertexIndices(currentSelection);
    currentSelectedVertexIndices = new Set(vertexIndices);
    currentSelectedVertexIndex = vertexIndices.length > 0 ? vertexIndices[0] : null;
    currentSelectedDoorId = getSelectedDoorId(currentSelection);
    currentSelectedObstacleId = getSelectedObstacleId(currentSelection);
    currentSelectedObstacleVertexIndices = new Set(
      getSelectedObstacleVertexIndices(currentSelection)
    );
  }
  // The active module's selected entities, read through `EntityAccess` — core never names a
  // fixture, a plank or any other domain thing.
  $: currentSelectedEntityIds = [
    ...($activeModule?.entities ?? NO_ENTITIES).selectedIds($selection),
  ];

  // ============================================
  // Rendering — one loop over core and module layers
  // ============================================

  // Each of these names its instance so that assigning it in `onMount` re-runs the statement:
  // a reactive block that only reads a store would not fire again for the first frame.
  $: if (editorRenderer) editorRenderer.setModuleLayers($activeModule?.layers ?? []);
  $: if (interactionManager) interactionManager.setModuleHandlers($activeModule?.handlers ?? []);
  $: if (keyboardShortcutManager)
    keyboardShortcutManager.setModuleBindings(
      ($activeModule?.shortcuts ?? []).map((shortcut) => ({
        key: shortcut.key,
        ctrlKey: shortcut.ctrlKey,
        shiftKey: shortcut.shiftKey,
        altKey: shortcut.altKey,
        description: shortcut.description,
        action: () => shortcut.run(),
      }))
    );

  // The whole of what the scene draws. `render` loops layers; there is no per-domain call left.
  $: if (editorRenderer) renderScene(editorRenderer, $activeView);

  function renderScene(renderer: EditorRenderer, view: ModuleView<unknown>): void {
    renderer.render(view);
  }

  $: if (editorRenderer && currentDisplayPrefs) {
    editorRenderer.setUnitFormat(currentDisplayPrefs.unitFormat);
  }

  $: if (editorRenderer && currentViewMode) {
    // Gesture visuals are not layers, so they still need telling when the view changes.
    editorRenderer.setVisible(currentViewMode === 'editor');
  }

  // Fit camera to room bounds only when explicitly requested (project load/import)
  $: if ($shouldFitCamera && scene && currentBounds && currentWalls.length > 0) {
    scene.fitToBounds(currentBounds);
    shouldFitCamera.set(false);
  }

  // Update measurement when the document changes (e.g., undo/redo)
  $: if (measurementController && currentDocument && measurementController.isActive) {
    updateMeasurementPositions();
  }

  // ============================================
  // Context Builder
  // ============================================

  /**
   * The selection as of *right now*, not as of the last Svelte flush. Handlers select and then
   * immediately re-read to detect a shift-click toggle-off, and `$:` assignments are batched to
   * the microtask flush, so the mirrored `currentSelection` would still hold the old value.
   * The mirror is for rendering; this is for input.
   */
  function liveSelection(): Selection {
    return get(selection);
  }

  /** Likewise live: activation can change between two frames of the same session. */
  function liveEntities(): EntityAccess {
    return activeEntities();
  }

  function buildInteractionContext(): InteractionContext {
    return {
      document: currentDocument,
      entities: liveEntities(),
      selection: liveSelection(),
      activeTool: currentTool,
      isDrawingEnabled: isDrawing,
      isModuleToolActive: isModuleTool,
      isPlacingDoors: isPlacingDoors,
      isObstacleDrawing: isObstacleDrawing,
      isMeasuring: measurementController?.isActive ?? false,
      isGrabMode: isGrabMode,
      isBoxSelecting: boxSelectionState.isSelecting,
      currentMousePos: currentMousePos,
      vertices: getVertices(currentDocument),
    };
  }

  // ============================================
  // Event Handlers
  // ============================================

  function handleClick(event: InputEvent): void {
    const context = buildInteractionContext();
    interactionManager.handleClick(event, context);
  }

  function handleDoubleClick(event: InputEvent): void {
    const context = buildInteractionContext();
    interactionManager.handleDoubleClick(event, context);
  }

  function handleMouseMove(event: InputEvent): void {
    currentMousePos = event.worldPos;
    dispatch('mouseMove', { worldPos: event.worldPos });

    const context = buildInteractionContext();

    // Handle drag updates
    if (dragManager.isActive && !isGrabMode) {
      dragManager.updateDrag(event.worldPos, {
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
      });
      return;
    }

    interactionManager.handleMouseMove(event, context);
  }

  function handleMouseUp(event: InputEvent): void {
    // Don't handle mouse up in grab mode
    if (isGrabMode) return;

    const context = buildInteractionContext();

    // First check if InteractionManager handles it (e.g., box selection)
    if (interactionManager.handleMouseUp(event, context)) return;

    // Commit any active drag
    if (dragManager.isActive) {
      dragManager.commitDrag();
    }
  }

  /**
   * The gesture was taken away (pointercancel, window blur). Discard the candidate command;
   * the committed document was never touched.
   */
  function handleInputCancel(): void {
    if (dragManager?.isActive) {
      dragManager.cancelDrag();
    } else {
      cancelInteraction();
    }
    if (isGrabMode) {
      isGrabMode = false;
    }
  }

  function handleKeyDown(event: InputEvent): void {
    if (!event.key) return;

    const context = buildInteractionContext();

    // Let InteractionManager handle first (for mode-specific keys)
    if (interactionManager.handleKeyDown(event, context)) return;

    // Then try keyboard shortcuts
    keyboardShortcutManager.handle(event, context);
  }

  // ============================================
  // Measurement Helpers
  // ============================================

  function updateMeasurementPositions(): void {
    const vertices = getVertices(currentDocument);
    const entities = liveEntities();
    const source = measurementController.source;
    const target = measurementController.target;

    // Update source position if it's a vertex
    if (source?.type === 'vertex') {
      const idx = source.index;
      if (vertices[idx]) {
        measurementController.updateSourcePosition(vertices[idx]);
      }
    }

    // Update source position if it's a module entity
    if (source?.type === 'entity') {
      const entity = entities.find(source.id);
      if (entity) {
        measurementController.updateSourcePosition(entity.position, currentWalls);
      }
    }

    // Update target position if it's a vertex
    if (target?.type === 'vertex') {
      const idx = target.index;
      if (vertices[idx]) {
        measurementController.updateTargetPosition(vertices[idx]);
      }
    }

    // Update target position if it's a module entity
    if (target?.type === 'entity') {
      const entity = entities.find(target.id);
      if (entity) {
        measurementController.updateTargetPosition(entity.position);
      }
    }

    // Refresh the display
    if (measurementController.fromPosition && measurementController.toPosition) {
      editorRenderer?.setMeasurementLine(
        measurementController.fromPosition,
        measurementController.toPosition
      );
      dispatch('measurement', measurementController.getMeasurementData());
    }
  }

  function handleMeasurementToggle(): void {
    if (measurementController.isActive) {
      measurementHandler.clearMeasurement();
      return;
    }

    // Start from vertex
    if (currentSelectedVertexIndex !== null) {
      const vertices = getVertices(currentDocument);
      measurementHandler.startFromVertex(
        currentSelectedVertexIndex,
        vertices[currentSelectedVertexIndex]
      );
      isMeasuring.set(true);
      return;
    }

    // Start from a module entity
    const anchorId = currentSelectedEntityIds[0];
    if (anchorId) {
      const entity = liveEntities().find(anchorId);
      if (entity) {
        measurementHandler.startFromEntity(anchorId, entity.position);
        isMeasuring.set(true);
      }
    }
  }

  function handleEscape(): void {
    if (isGrabMode) {
      dragManager.cancelDrag();
      isGrabMode = false;
      return;
    }
    if (boxSelectionState.isSelecting) {
      boxSelectionState = { isSelecting: false, startPosition: null, currentPosition: null };
      editorRenderer?.setSelectionBox(null, null);
      return;
    }
    if (dragManager.axisLock !== 'none') {
      dragManager.clearAxisLock();
      return;
    }
    if (measurementController.isActive) {
      measurementHandler.clearMeasurement();
      return;
    }
    if (obstacleWallBuilder?.drawing) {
      obstacleWallBuilder.cancel();
      editorRenderer.setPhantomLine(null, null);
      editorRenderer.updateDrawingVertices([]);
      return;
    }
    if (wallBuilder.drawing) {
      wallBuilder.cancel();
      editorRenderer.setPhantomLine(null, null);
      editorRenderer.updateDrawingVertices([]);
      return;
    }
    clearSelection();
  }

  function handleSelectAllObstacleVertices(): void {
    if (!currentSelectedObstacleId) return;
    const obstacle = currentObstacles.find((o) => o.id === currentSelectedObstacleId);
    if (!obstacle) return;

    setObstacleVertexSelection(
      currentSelectedObstacleId,
      obstacle.walls.map((_wall, index) => index)
    );
  }

  function handleDelete(): void {
    if (currentSelectedVertexIndices.size > 0 && currentWalls.length > 3) {
      const sortedIndices = Array.from(currentSelectedVertexIndices).sort((a, b) => b - a);
      for (const idx of sortedIndices) {
        if (currentDocument.geometry.boundary.walls.length > 3) {
          deleteVertex(idx);
        }
      }
      clearSelection();
    } else if (currentSelectedObstacleId && currentSelectedObstacleVertexIndices.size === 0) {
      removeObstacle(currentSelectedObstacleId);
      clearSelection();
    } else if (currentSelectedDoorId) {
      removeDoor(currentSelectedDoorId);
      clearSelection();
    } else if (currentSelectedEntityIds.length > 0) {
      // The module owns what deleting its entities means; core only knows it is one command.
      const command = liveEntities().removeCommand(currentSelectedEntityIds);
      if (command) sessionStore.dispatch(command);
      clearSelection();
    }
  }

  // ============================================
  // Animation
  // ============================================

  function animate(): void {
    scene.render();
    animationFrameId = requestAnimationFrame(animate);
  }

  // ============================================
  // Lifecycle
  // ============================================

  onMount(() => {
    // Core components
    scene = new Scene(container);
    inputManager = new InputManager(scene);
    editorRenderer = new EditorRenderer(scene.scene);
    // Module layers are built into this scene by the activation registry.
    setModuleScene(scene.scene);
    wallBuilder = new WallBuilder();
    obstacleWallBuilder = new WallBuilder();
    polygonValidator = new PolygonValidator();
    snapController = new SnapController();
    measurementController = new MeasurementController();

    // Initialize drag manager
    dragManager = new DragManager({
      onSetSnapGuides: (guides) => editorRenderer?.setSnapGuides(guides),
      onPreviewCommand: (command) => previewCommand(command),
      onCommitCommand: () => commitInteraction(),
      onCancelCommand: () => cancelInteraction(),
    });

    // Initialize interaction manager
    interactionManager = new InteractionManager();

    // Initialize keyboard shortcut manager
    keyboardShortcutManager = new KeyboardShortcutManager();
    keyboardShortcutManager.registerAll(
      createDefaultKeyboardShortcuts({
        setViewMode: (mode) => viewMode.set(mode),
        toggleUnitFormat: () => toggleUnitFormat(),
        toggleMeasurement: () => handleMeasurementToggle(),
        undo: () => sessionStore.undo(),
        redo: () => sessionStore.redo(),
        handleEscape: () => handleEscape(),
        handleDelete: () => handleDelete(),
        selectAllObstacleVertices: () => handleSelectAllObstacleVertices(),
      })
    );

    // Initialize handlers
    drawingHandler = new DrawingHandler(
      {
        wallBuilder,
        polygonValidator,
        snapController,
        getGridSnapEnabled: () => currentDisplayPrefs.gridSnapEnabled,
        getGridSize: () => currentDisplayPrefs.gridSize || 0.5,
      },
      {
        onUpdateDrawingVertices: (vertices) => editorRenderer.updateDrawingVertices(vertices),
        onSetPhantomLine: (from, to) => editorRenderer.setPhantomLine(from, to),
        onSetPreviewVertex: (pos) => editorRenderer.setPreviewVertex(pos),
        onCloseRoom: (walls) => closeRoom(walls),
        onSnapChange: (snapType) => dispatch('snapChange', { snapType }),
      }
    );

    obstacleDrawingHandler = new ObstacleDrawingHandler(
      {
        wallBuilder: obstacleWallBuilder,
        polygonValidator,
        snapController,
        getGridSnapEnabled: () => currentDisplayPrefs.gridSnapEnabled,
        getGridSize: () => currentDisplayPrefs.gridSize || 0.5,
      },
      {
        onUpdateDrawingVertices: (vertices) => editorRenderer.updateDrawingVertices(vertices),
        onSetPhantomLine: (from, to) => editorRenderer.setPhantomLine(from, to),
        onSetPreviewVertex: (pos) => editorRenderer.setPreviewVertex(pos),
        onCloseObstacle: (walls) => {
          const obstacle = {
            id: `obstacle-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            walls,
            height: currentDocument.space.ceilingHeight,
          };
          addObstacle(obstacle);
        },
        onSnapChange: (snapType) => dispatch('snapChange', { snapType }),
      }
    );

    doorPlacementHandler = new DoorPlacementHandler(
      {
        getWalls: () => currentWalls,
        getDoors: () => currentDoors,
        getWallAtPosition: (pos, walls, tolerance) =>
          editorRenderer.getWallAtPosition(pos, walls, tolerance),
        getSelectedDoorWidth: () => getDoorPlacementSettings().width,
        getSelectedDoorSwingDirection: () => getDoorPlacementSettings().swingDirection,
        getSelectedDoorSwingSide: () => getDoorPlacementSettings().swingSide,
        canPlaceDoors: () => get(canPlaceDoors),
      },
      {
        onDoorPlaced: (door) => addDoor(door),
        onDoorPreview: (door, wall, canPlace) => {
          if (door && wall) {
            editorRenderer.setDoorPreview(door, wall, canPlace);
          } else {
            editorRenderer.clearDoorPreview();
          }
        },
      }
    );

    boxSelectionHandler = new BoxSelectionHandler(
      {
        getBoxSelectionState: () => boxSelectionState,
        setBoxSelectionState: (state) => {
          boxSelectionState = state;
        },
      },
      {
        onBoxSelectionStart: (_start) => {},
        onBoxSelectionUpdate: (start, current) => editorRenderer.setSelectionBox(start, current),
        onBoxSelectionComplete: (vertexIndices, entityIds, obstacleVertices, addToSelection) => {
          // When an obstacle is selected, box select only applies to that obstacle's vertices
          if (obstacleVertices.length > 0) {
            const first = obstacleVertices[0];
            selectObstacleVerticesInBox(first.obstacleId, first.vertexIndices, addToSelection);
          } else if (currentSelectedObstacleId) {
            // Obstacle selected but no obstacle vertices in box — drop the vertex selection
            if (!addToSelection) {
              setObstacleVertexSelection(currentSelectedObstacleId, []);
            }
          } else {
            // No obstacle selected — normal room vertex / module entity selection
            selectInBox(liveEntities(), vertexIndices, entityIds, addToSelection);
          }
          editorRenderer?.setSelectionBox(null, null);
        },
        onBoxSelectionCancel: () => editorRenderer?.setSelectionBox(null, null),
      }
    );

    measurementHandler = new MeasurementHandler(
      {
        measurementController,
        getEntities: () => liveEntities(),
        getWalls: () => currentWalls,
      },
      {
        onMeasurementUpdate: (data) => {
          if (data) {
            editorRenderer.setMeasurementLine(data.from, data.to);
          }
          dispatch('measurement', data);
        },
        onMeasurementClear: () => {
          isMeasuring.set(false);
          editorRenderer?.setMeasurementLine(null, null);
          dispatch('measurement', null);
        },
        onSelectEntity: (id) => selectEntity(liveEntities(), id),
        onSelectVertex: (index, addToSelection) => selectVertex(index, addToSelection),
        onStartDrag: (vertexIndex, entityId, pos) => {
          const operation = createUnifiedDragOperation();
          operation.setAnchor(vertexIndex, entityId);
          dragManager.startDrag(operation, {
            position: pos,
            modifiers: EMPTY_MODIFIERS,
            document: currentDocument,
            selection: liveSelection(),
          });
        },
        getWallAtPosition: (pos, walls, tolerance) =>
          editorRenderer.getWallAtPosition(pos, walls, tolerance),
      }
    );

    grabModeHandler = new GrabModeHandler(
      {
        dragManager,
        createGrabOperation: () =>
          new GrabModeDragOperation(
            {
              snapController,
              getGridSnapEnabled: () => currentDisplayPrefs.gridSnapEnabled,
              getGridSize: () => currentDisplayPrefs.gridSize || 0.5,
              getVertices: () => getVertices(currentDocument),
              getEntities: () => liveEntities(),
              getWalls: () => currentWalls,
              getWallById: (id) => currentWalls.find((w) => w.id === id),
              getDoors: () => currentDoors,
              getDoorById: (id) => currentDoors.find((d) => d.id === id),
              getDoorsByWallId: (wallId) => getDoorsByWallId(currentDocument, wallId),
              isRoomClosed: () => currentDocument.geometry.boundary.isClosed,
              getCurrentMousePos: () => currentMousePos,
            },
            dragManager.getCallbacks()
          ),
        getGrabModeState: () => ({ isActive: isGrabMode, offset: null, originalPositions: null }),
        setGrabModeActive: (active) => {
          isGrabMode = active;
        },
        getSelection: () => liveSelection(),
        getCurrentMousePos: () => currentMousePos,
        getVertices: () => getVertices(currentDocument),
        getEntities: () => liveEntities(),
        getWalls: () => currentWalls,
        getDoors: () => currentDoors,
        getDoorById: (id) => currentDoors.find((d) => d.id === id),
        getWallById: (id) => currentWalls.find((w) => w.id === id),
      },
      {
        onGrabModeStart: () => {},
        onGrabModeConfirm: () => {},
        onGrabModeCancel: () => {},
      }
    );

    selectionHandler = new SelectionHandler(
      {
        getEntities: () => liveEntities(),
        dragManager,
        boxSelectionHandler,
        createUnifiedDragOperation,
        createWallDragOperation,
        createDoorDragOperation,
        createObstacleVertexDragOperation,
        createObstacleDragOperation,
        getSelection: () => liveSelection(),
        getCurrentMousePos: () => currentMousePos,
      },
      {
        onSelectVertex: (index, addToSelection) => selectVertex(index, addToSelection),
        onSelectEntity: (id, addToSelection) => selectEntity(liveEntities(), id, addToSelection),
        onSelectWall: (id) => selectWall(id),
        onSelectDoor: (id) => selectDoor(id),
        onSelectObstacle: (id) => selectObstacle(id),
        onSelectObstacleVertex: (obstacleId, vertexIndex, addToSelection) =>
          selectObstacleVertex(obstacleId, vertexIndex, addToSelection),
        onClearSelection: () => {
          clearSelection();
          dragManager.clearAxisLock();
        },
        onRetainBoxCandidates: () => retainBoxCandidates(liveEntities()),
        onInsertVertex: (wallId, position) => insertVertexOnWall(wallId, position),
        getWallAtPosition: (pos, walls, tolerance) =>
          editorRenderer.getWallAtPosition(pos, walls, tolerance),
        getDoors: () => currentDoors,
        getObstacles: () => currentObstacles,
      }
    );

    // Register core handlers (order determines priority for overlapping canHandle). The active
    // module's handlers are merged in reactively above, by priority.
    interactionManager.registerHandler(grabModeHandler);
    interactionManager.registerHandler(measurementHandler);
    interactionManager.registerHandler(drawingHandler);
    interactionManager.registerHandler(obstacleDrawingHandler);
    interactionManager.registerHandler(doorPlacementHandler);
    interactionManager.registerHandler(selectionHandler);
    interactionManager.registerHandler(boxSelectionHandler);
    interactionManager.setModuleHandlers($activeModule?.handlers ?? []);
    editorRenderer.setModuleLayers($activeModule?.layers ?? []);

    // Set up input events
    inputManager.on('click', handleClick);
    inputManager.on('dblclick', handleDoubleClick);
    inputManager.on('move', handleMouseMove);
    inputManager.on('drag', handleMouseMove);
    inputManager.on('mouseup', handleMouseUp);
    inputManager.on('keydown', handleKeyDown);
    inputManager.on('cancel', handleInputCancel);

    animate();
  });

  // Factory functions for drag operations
  function createUnifiedDragOperation(): UnifiedDragOperation {
    return new UnifiedDragOperation(
      {
        snapController,
        getGridSnapEnabled: () => currentDisplayPrefs.gridSnapEnabled,
        getGridSize: () => currentDisplayPrefs.gridSize || 0.5,
        getVertices: () => getVertices(currentDocument),
        getEntities: () => liveEntities(),
        getWalls: () => currentWalls,
        isRoomClosed: () => currentDocument.geometry.boundary.isClosed,
      },
      {
        ...dragManager.getCallbacks(),
        onMeasurementUpdate: (_delta) => {
          // Handle measurement updates during drag if needed
        },
      }
    );
  }

  function createWallDragOperation(): WallDragOperation {
    return new WallDragOperation(
      {
        snapController,
        getVertices: () => getVertices(currentDocument),
        getWalls: () => currentWalls,
        getWallById: (id) => currentWalls.find((w) => w.id === id),
      },
      dragManager.getCallbacks()
    );
  }

  function createObstacleVertexDragOperation(): ObstacleVertexDragOperation {
    return new ObstacleVertexDragOperation(
      {
        snapController,
        getGridSnapEnabled: () => currentDisplayPrefs.gridSnapEnabled,
        getGridSize: () => currentDisplayPrefs.gridSize || 0.5,
        getRoomVertices: () => getVertices(currentDocument),
      },
      dragManager.getCallbacks()
    );
  }

  function createObstacleDragOperation(): ObstacleDragOperation {
    return new ObstacleDragOperation(
      {
        snapController,
        getGridSnapEnabled: () => currentDisplayPrefs.gridSnapEnabled,
        getGridSize: () => currentDisplayPrefs.gridSize || 0.5,
        getRoomVertices: () => getVertices(currentDocument),
      },
      dragManager.getCallbacks()
    );
  }

  function createDoorDragOperation(): DoorDragOperation {
    return new DoorDragOperation({
      getWallById: (id) => currentWalls.find((w) => w.id === id),
      getDoorById: (id) => currentDoors.find((d) => d.id === id),
      getDoorsByWallId: (wallId) => getDoorsByWallId(currentDocument, wallId),
    });
  }

  onDestroy(() => {
    if (animationFrameId) {
      cancelAnimationFrame(animationFrameId);
    }
    inputManager?.dispose();
    // Only core's own renderers: module layers belong to the activation scope.
    editorRenderer?.dispose();
    setModuleScene(null);
    scene?.dispose();
  });

  // ============================================
  // Exported Methods
  // ============================================

  export function setManualLength(length: number): void {
    wallBuilder.setManualLength(length);
  }
</script>

<div class="canvas-container" bind:this={container}></div>

<style>
  .canvas-container {
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
</style>
