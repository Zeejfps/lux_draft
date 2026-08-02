/**
 * Is this keyboard event aimed at somewhere the user is typing?
 *
 * Editor shortcuts are single letters and digits, so a window-level listener would otherwise
 * swallow every keystroke meant for a field — typing `2` into a ceiling height would switch
 * the view mode instead. Anything text-editable claims its own keys.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;

  if (target.isContentEditable) return true;

  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;

  if (target instanceof HTMLInputElement) {
    // Buttons and checkboxes aren't typed into: space and enter should keep working there.
    const type = target.type;
    return (
      type !== 'button' &&
      type !== 'submit' &&
      type !== 'reset' &&
      type !== 'checkbox' &&
      type !== 'radio'
    );
  }

  return false;
}
