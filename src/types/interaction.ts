import type { Vector2 } from './geometry';
import type { EditorDocument } from './document';
import type { EditorCommand } from './command';
import type { Selection } from './selection';
import type { InputEvent } from '../core/InputManager';

// ============================================
// Interaction (ephemeral gesture state)
// ============================================

/**
 * What the user is currently doing. Ephemeral — never persisted, never undoable.
 *
 * Phase 1a carries the two variants the drag machinery needs. The `drawing` and `measuring`
 * variants of the target model still live in `WallBuilder` and `MeasurementController`; phase 1b
 * folds them in.
 */
export type Interaction =
  | { kind: 'idle' }
  /** A command the user is aiming. Dispatched verbatim on completion, discarded on cancel. */
  | { kind: 'commandPreview'; command: EditorCommand };

export const IDLE_INTERACTION: Interaction = { kind: 'idle' };

// ============================================
// Interaction Modes
// ============================================

// ============================================
// Drag State
// ============================================

export interface DragContext {
  originalVertexPositions: Map<number, Vector2>;
  originalLightPositions: Map<string, Vector2>;
  originalWallVertices: { start: Vector2; end: Vector2 } | null;
  axisLock: AxisLock;
  anchorVertexIndex: number | null;
  anchorLightId: string | null;
  dragStartPos: Vector2 | null;
}

export type AxisLock = 'none' | 'x' | 'y';

// ============================================
// Input Modifiers
// ============================================

export interface InputModifiers {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

// ============================================
// Drag Operation Interface
// ============================================

export interface DragStartContext {
  position: Vector2;
  modifiers: InputModifiers;
  document: EditorDocument | null;
  selection: Selection;
}

export interface DragUpdateContext {
  position: Vector2;
  modifiers: InputModifiers;
  axisLock: AxisLock;
}

/**
 * A drag operation resolves pointer input into a candidate command. It never writes:
 * `update` returns the command that would produce the state the user is looking at, and the
 * same value is dispatched on completion. There is no `cancel` — discarding the preview is
 * the whole of cancelling.
 */
export interface IDragOperation {
  readonly type: string;
  start(context: DragStartContext): void;
  /** The candidate command for this frame, or null when there is nothing to preview. */
  update(context: DragUpdateContext): EditorCommand | null;
  /** End the operation. Writes nothing. */
  finish(): void;
  isActive(): boolean;
  getStartPosition(): Vector2 | null;
}

// ============================================
// Interaction Handler Interface
// ============================================

export interface InteractionContext {
  document: EditorDocument;
  selection: Selection;
  isDrawingEnabled: boolean;
  isPlacingLights: boolean;
  isPlacingDoors: boolean;
  isObstacleDrawing: boolean;
  isMeasuring: boolean;
  isGrabMode: boolean;
  isBoxSelecting: boolean;
  currentMousePos: Vector2;
  vertices: Vector2[];
}

export interface IInteractionHandler {
  readonly name: string;
  readonly priority: number;

  canHandle(event: InputEvent, context: InteractionContext): boolean;

  handleClick?(event: InputEvent, context: InteractionContext): boolean;
  handleMouseMove?(event: InputEvent, context: InteractionContext): boolean;
  handleMouseUp?(event: InputEvent, context: InteractionContext): boolean;
  handleKeyDown?(event: InputEvent, context: InteractionContext): boolean;
  handleDoubleClick?(event: InputEvent, context: InteractionContext): boolean;
}

// ============================================
// Keyboard Shortcut Types
// ============================================

export interface KeyBinding {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  action: (context: InteractionContext) => void;
  condition?: (context: InteractionContext) => boolean;
  description?: string;
}

// ============================================
// Box Selection State
// ============================================

export interface BoxSelectionState {
  isSelecting: boolean;
  startPosition: Vector2 | null;
  currentPosition: Vector2 | null;
}

// ============================================
// Grab Mode State
// ============================================

export interface GrabModeState {
  isActive: boolean;
  offset: Vector2 | null;
  originalPositions: DragContext;
}

// ============================================
// Handler Results
// ============================================

// ============================================
// Measurement State (for handlers)
// ============================================
