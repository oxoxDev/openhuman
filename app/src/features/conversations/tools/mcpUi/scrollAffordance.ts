/**
 * Previous/next buttons for horizontally scrolling regions of a widget, and
 * vertical wheel mapped onto them. Injected into every widget document; it
 * never moves the widget's own nodes, it overlays fixed-position buttons that
 * follow each scroller.
 */
export const SCROLL_AFFORDANCE_SOURCE = `(function () {
  'use strict';
  if (window.__ohScrollAffordance) return;
  window.__ohScrollAffordance = true;
  var PREFIX = 'ohsa-';
  var SIZE = 28;
  var SLACK = 4;
  var tracked = [];
  var seen = typeof WeakSet === 'function' ? new WeakSet() : null;
  var layer = null;
  var timer = null;
  var CHEVRON_LEFT = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var CHEVRON_RIGHT = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function overflowing(el) {
    return el.scrollWidth > el.clientWidth + SLACK;
  }
  function scrollsHorizontally(el) {
    if (!el || el.nodeType !== 1 || el.className === PREFIX + 'layer') return false;
    var style = window.getComputedStyle(el);
    var x = style.overflowX;
    return (x === 'auto' || x === 'scroll') && overflowing(el);
  }
  function atStart(el) {
    return el.scrollLeft <= 0;
  }
  function atEnd(el) {
    return el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
  }
  function ensureLayer() {
    if (layer && layer.isConnected) return layer;
    if (!document.body) return null;
    layer = document.createElement('div');
    layer.className = PREFIX + 'layer';
    layer.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
    document.body.appendChild(layer);
    return layer;
  }
  function makeButton(label, icon, direction, el) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = PREFIX + 'button';
    button.setAttribute('aria-label', label);
    button.innerHTML = icon;
    button.style.cssText = 'position:fixed;display:none;align-items:center;justify-content:center;' +
      'width:' + SIZE + 'px;height:' + SIZE + 'px;padding:0;margin:0;border-radius:50%;' +
      'border:1px solid rgba(0,0,0,0.14);background:rgba(255,255,255,0.94);color:#1f2328;' +
      'box-shadow:0 1px 4px rgba(0,0,0,0.22);cursor:pointer;font:inherit;line-height:0;';
    button.addEventListener('click', function () {
      var amount = Math.max(1, Math.round(el.clientWidth * 0.8)) * direction;
      if (typeof el.scrollBy === 'function') {
        el.scrollBy({ left: amount, behavior: 'smooth' });
      } else {
        el.scrollLeft += amount;
      }
    });
    return button;
  }
  function place(entry) {
    var el = entry.el;
    var rect = el.getBoundingClientRect();
    var visible = el.isConnected && overflowing(el) && rect.width > SIZE * 2 && rect.height > 0;
    var top = Math.round(rect.top + rect.height / 2 - SIZE / 2);
    entry.left.style.top = top + 'px';
    entry.left.style.left = Math.round(rect.left + 4) + 'px';
    entry.right.style.top = top + 'px';
    entry.right.style.left = Math.round(rect.right - SIZE - 4) + 'px';
    entry.left.style.display = visible && !atStart(el) ? 'flex' : 'none';
    entry.right.style.display = visible && !atEnd(el) ? 'flex' : 'none';
  }
  function update() {
    for (var i = tracked.length - 1; i >= 0; i--) {
      var entry = tracked[i];
      if (!entry.el.isConnected) {
        entry.left.remove();
        entry.right.remove();
        tracked.splice(i, 1);
        continue;
      }
      place(entry);
    }
  }
  function onWheel(event) {
    var el = event.currentTarget;
    if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    if (el.scrollHeight > el.clientHeight + 1) return;
    if (event.deltaY > 0 ? atEnd(el) : atStart(el)) return;
    el.scrollLeft += event.deltaY;
    event.preventDefault();
  }
  function track(el) {
    var host = ensureLayer();
    if (!host) return;
    if (seen) seen.add(el);
    else el.setAttribute('data-' + PREFIX + 'tracked', '');
    var entry = {
      el: el,
      left: makeButton('Scroll left', CHEVRON_LEFT, -1, el),
      right: makeButton('Scroll right', CHEVRON_RIGHT, 1, el)
    };
    host.appendChild(entry.left);
    host.appendChild(entry.right);
    el.addEventListener('scroll', function () { place(entry); }, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: false });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(function () { place(entry); }).observe(el);
    }
    tracked.push(entry);
    place(entry);
  }
  function isTracked(el) {
    return seen ? seen.has(el) : el.hasAttribute('data-' + PREFIX + 'tracked');
  }
  function scan() {
    timer = null;
    if (!document.body) return;
    var all = document.body.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (layer && layer.contains(el)) continue;
      if (!isTracked(el) && scrollsHorizontally(el)) track(el);
    }
    update();
  }
  function schedule() {
    if (timer !== null) return;
    timer = setTimeout(scan, 120);
  }
  document.addEventListener('DOMContentLoaded', schedule);
  window.addEventListener('load', schedule);
  window.addEventListener('resize', function () { update(); schedule(); });
  document.addEventListener('scroll', update, { passive: true, capture: true });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(schedule).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(schedule).observe(document.documentElement);
  }
  schedule();
})();`;
