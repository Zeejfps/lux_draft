import type { InputEvent } from '../core/InputManager';
import type { IInteractionHandler, InteractionContext } from '../types/interaction';

/**
 * Orchestrates interaction handlers.
 * Routes events to appropriate handlers based on priority and canHandle.
 */
export class InteractionManager {
  private coreHandlers: IInteractionHandler[] = [];
  private moduleHandlers: readonly IInteractionHandler[] = [];
  private handlers: IInteractionHandler[] = [];

  /**
   * Register a core handler. Handlers are sorted by priority (higher = first).
   */
  registerHandler(handler: IInteractionHandler): void {
    this.coreHandlers.push(handler);
    this.resort();
  }

  /**
   * Replace the active module's handlers. Called by the canvas whenever activation changes;
   * the previous set is simply dropped, because the activation scope owns their lifetime.
   */
  setModuleHandlers(handlers: readonly IInteractionHandler[]): void {
    this.moduleHandlers = handlers;
    this.resort();
  }

  private resort(): void {
    this.handlers = [...this.coreHandlers, ...this.moduleHandlers].sort(
      (a, b) => b.priority - a.priority
    );
  }

  /**
   * Handle a click event.
   */
  handleClick(event: InputEvent, context: InteractionContext): boolean {
    for (const handler of this.handlers) {
      if (handler.canHandle(event, context) && handler.handleClick) {
        const handled = handler.handleClick(event, context);
        if (handled) return true;
      }
    }
    return false;
  }

  /**
   * Handle a double click event.
   */
  handleDoubleClick(event: InputEvent, context: InteractionContext): boolean {
    for (const handler of this.handlers) {
      if (handler.canHandle(event, context) && handler.handleDoubleClick) {
        const handled = handler.handleDoubleClick(event, context);
        if (handled) return true;
      }
    }
    return false;
  }

  /**
   * Handle a mouse move event.
   */
  handleMouseMove(event: InputEvent, context: InteractionContext): boolean {
    for (const handler of this.handlers) {
      if (handler.canHandle(event, context) && handler.handleMouseMove) {
        const handled = handler.handleMouseMove(event, context);
        if (handled) return true;
      }
    }
    return false;
  }

  /**
   * Handle a mouse up event.
   */
  handleMouseUp(event: InputEvent, context: InteractionContext): boolean {
    for (const handler of this.handlers) {
      if (handler.canHandle(event, context) && handler.handleMouseUp) {
        const handled = handler.handleMouseUp(event, context);
        if (handled) return true;
      }
    }
    return false;
  }

  /**
   * Handle a key down event.
   */
  handleKeyDown(event: InputEvent, context: InteractionContext): boolean {
    for (const handler of this.handlers) {
      if (handler.canHandle(event, context) && handler.handleKeyDown) {
        const handled = handler.handleKeyDown(event, context);
        if (handled) return true;
      }
    }
    return false;
  }
}
