import { describe, expect, it, vi } from 'vitest';

import { SCROLL_AFFORDANCE_SOURCE } from './scrollAffordance';

interface Box {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
}

function fakeLayout(el: Element, box: Box) {
  for (const key of Object.keys(box) as Array<keyof Box>) {
    Object.defineProperty(el, key, {
      configurable: true,
      get: () => box[key],
      set: (value: number) => {
        box[key] = value;
      },
    });
  }
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({
      left: 10,
      right: 10 + box.clientWidth,
      top: 20,
      width: box.clientWidth,
      height: 100,
    }),
  });
}

async function mount() {
  const frame = window.document.createElement('iframe');
  window.document.body.appendChild(frame);
  const win = frame.contentWindow as Window & typeof globalThis;
  const document = win.document;
  document.body.innerHTML =
    '<div id="row" style="overflow-x:auto"><div>items</div></div>' +
    '<div id="clip" style="overflow-x:hidden"><div>wide</div></div>';
  const row = document.getElementById('row')!;
  const box: Box = {
    scrollWidth: 1000,
    clientWidth: 300,
    scrollHeight: 100,
    clientHeight: 100,
    scrollLeft: 0,
  };
  fakeLayout(row, box);
  fakeLayout(document.getElementById('clip')!, { ...box });
  const scrollBy = vi.fn();
  Object.defineProperty(row, 'scrollBy', { value: scrollBy });
  new Function('window', 'document', SCROLL_AFFORDANCE_SOURCE)(win, document);
  await new Promise(resolve => setTimeout(resolve, 200));
  const button = (label: string) =>
    document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  const scrolled = () => row.dispatchEvent(new win.Event('scroll'));
  return { win, document, row, box, scrollBy, button, scrolled };
}

describe('scroll affordance', () => {
  it('adds buttons only to horizontally scrolling regions', async () => {
    const { document, button } = await mount();
    expect(document.querySelectorAll('button')).toHaveLength(2);
    expect(button('Scroll left').style.display).toBe('none');
    expect(button('Scroll right').style.display).toBe('flex');
    expect(button('Scroll right').type).toBe('button');
  });

  it('scrolls by most of the visible width', async () => {
    const { button, scrollBy } = await mount();
    button('Scroll right').click();
    expect(scrollBy).toHaveBeenCalledWith({ left: 240, behavior: 'smooth' });
    button('Scroll left').click();
    expect(scrollBy).toHaveBeenLastCalledWith({ left: -240, behavior: 'smooth' });
  });

  it('hides each arrow at its end and both once nothing overflows', async () => {
    const { box, button, scrolled } = await mount();
    box.scrollLeft = 700;
    scrolled();
    expect(button('Scroll left').style.display).toBe('flex');
    expect(button('Scroll right').style.display).toBe('none');

    box.scrollWidth = 302;
    box.scrollLeft = 0;
    scrolled();
    expect(button('Scroll left').style.display).toBe('none');
    expect(button('Scroll right').style.display).toBe('none');
  });

  it('turns vertical wheel into horizontal scroll until the end', async () => {
    const { win, row, box } = await mount();
    const wheel = (deltaY: number) => {
      const event = new win.WheelEvent('wheel', { deltaY, cancelable: true });
      row.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(wheel(100)).toBe(true);
    expect(box.scrollLeft).toBe(100);

    box.scrollLeft = 700;
    expect(wheel(100)).toBe(false);
    expect(box.scrollLeft).toBe(700);

    box.scrollLeft = 0;
    expect(wheel(-100)).toBe(false);
  });
});
