import { describe, it, expect } from 'vitest';
import { isTypingTarget } from '../../../src/floorplan/utils/keyboard';

function input(type: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = type;
  return el;
}

describe('isTypingTarget', () => {
  it('claims the elements a user types into', () => {
    expect(isTypingTarget(input('text'))).toBe(true);
    expect(isTypingTarget(input('number'))).toBe(true);
    expect(isTypingTarget(document.createElement('textarea'))).toBe(true);
    expect(isTypingTarget(document.createElement('select'))).toBe(true);
  });

  it('claims contenteditable elements', () => {
    const el = document.createElement('div');
    el.contentEditable = 'true';
    // jsdom does not derive isContentEditable from the attribute.
    Object.defineProperty(el, 'isContentEditable', { value: true });
    expect(isTypingTarget(el)).toBe(true);
  });

  it('leaves the shortcuts alone everywhere else', () => {
    expect(isTypingTarget(document.createElement('canvas'))).toBe(false);
    expect(isTypingTarget(document.createElement('button'))).toBe(false);
    expect(isTypingTarget(input('checkbox'))).toBe(false);
    expect(isTypingTarget(input('radio'))).toBe(false);
    expect(isTypingTarget(input('button'))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
