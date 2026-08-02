import type { Vector2, EditorCommand } from '../types';
import type {
  IDragOperation,
  DragStartContext,
  DragUpdateContext,
  AxisLock,
  InputModifiers,
} from '../types/interaction';
import type { SnapGuide } from '../controllers/SnapController';
import { SNAP_GUIDE_LENGTH } from '../constants/editor';

/** What a drag operation is allowed to do besides returning a command: draw guides. */
export interface DragOperationCallbacks {
  onSetSnapGuides: (guides: SnapGuide[]) => void;
}

export interface DragManagerCallbacks extends DragOperationCallbacks {
  /** Show the candidate command for this frame. Writes nothing to the document. */
  onPreviewCommand: (command: EditorCommand) => void;
  /** Dispatch the previewed command verbatim. */
  onCommitCommand: () => void;
  /** Discard the preview. The committed document is untouched. */
  onCancelCommand: () => void;
}

/**
 * Manages drag operations with support for axis locking and operation lifecycle.
 *
 * A drag never writes: the operation returns a candidate command per frame, which is previewed,
 * and the same value is dispatched on commit (invariant 3).
 */
export class DragManager {
  private currentOperation: IDragOperation | null = null;
  private _axisLock: AxisLock = 'none';
  private callbacks: DragManagerCallbacks;
  private dragStartPos: Vector2 | null = null;

  constructor(callbacks: DragManagerCallbacks) {
    this.callbacks = callbacks;
  }

  get axisLock(): AxisLock {
    return this._axisLock;
  }

  get isActive(): boolean {
    return this.currentOperation !== null && this.currentOperation.isActive();
  }

  get startPosition(): Vector2 | null {
    // Prefer the operation's start position (item's original position) over mouse click position
    return this.currentOperation?.getStartPosition() ?? this.dragStartPos;
  }

  /**
   * Start a new drag operation.
   */
  startDrag(operation: IDragOperation, context: DragStartContext): void {
    if (this.currentOperation?.isActive()) {
      this.cancelDrag();
    }

    this.currentOperation = operation;
    this.dragStartPos = { ...context.position };
    this._axisLock = 'none';
    operation.start(context);
  }

  /**
   * Update the current drag operation and preview the command it resolves to.
   */
  updateDrag(position: Vector2, modifiers: InputModifiers): void {
    if (!this.currentOperation?.isActive()) return;

    const context: DragUpdateContext = {
      position,
      modifiers,
      axisLock: this._axisLock,
    };

    const command = this.currentOperation.update(context);
    if (command) {
      this.callbacks.onPreviewCommand(command);
    }
  }

  /**
   * Commit the current drag operation: the previewed command is dispatched verbatim.
   */
  commitDrag(): void {
    if (!this.currentOperation?.isActive()) return;

    this.currentOperation.finish();
    this.cleanup();
    this.callbacks.onCommitCommand();
  }

  /**
   * Cancel the current drag operation. Nothing was written, so nothing is restored.
   */
  cancelDrag(): void {
    if (!this.currentOperation) return;

    this.currentOperation.finish();
    this.cleanup();
    this.callbacks.onCancelCommand();
  }

  /**
   * Toggle axis lock.
   */
  setAxisLock(axis: AxisLock): void {
    this._axisLock = this._axisLock === axis ? 'none' : axis;
    this.updateAxisLockGuides();
  }

  /**
   * Clear axis lock.
   */
  clearAxisLock(): void {
    this._axisLock = 'none';
    this.callbacks.onSetSnapGuides([]);
  }

  /**
   * Update visual guides for axis lock.
   */
  updateAxisLockGuides(guideOrigin?: Vector2): void {
    if (this._axisLock === 'none') {
      this.callbacks.onSetSnapGuides([]);
      return;
    }

    const origin = guideOrigin || this.dragStartPos;
    if (!origin) return;

    const guides: SnapGuide[] = [];
    const guideLength = SNAP_GUIDE_LENGTH;

    if (this._axisLock === 'x') {
      guides.push({
        axis: 'x',
        value: origin.x,
        from: { x: origin.x - guideLength, y: origin.y },
        to: { x: origin.x + guideLength, y: origin.y },
      });
    } else if (this._axisLock === 'y') {
      guides.push({
        axis: 'y',
        value: origin.y,
        from: { x: origin.x, y: origin.y - guideLength },
        to: { x: origin.x, y: origin.y + guideLength },
      });
    }

    this.callbacks.onSetSnapGuides(guides);
  }

  /**
   * Get callbacks for operations to use.
   */
  getCallbacks(): DragManagerCallbacks {
    return this.callbacks;
  }

  private cleanup(): void {
    this.currentOperation = null;
    this._axisLock = 'none';
    this.dragStartPos = null;
    this.callbacks.onSetSnapGuides([]);
  }
}
