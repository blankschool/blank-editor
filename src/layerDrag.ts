import type { LayerDropSide } from './layerOrder';

type LayerDragOptions = {
  getMovingIds(sourceId: string): string[];
  drop(ids: string[], targetId: string, side: LayerDropSide): void;
};

/** A pointer sensor, shared by mouse, pen and the touch drag handle.
 * The document only changes on a valid drop; Escape/outside/cancel is a no-op. */
export function attachLayerDrag(root: HTMLElement, options: LayerDragOptions) {
  let cancelCurrent: (() => void) | undefined;
  let suppressClick = false;
  root.addEventListener('dragstart', event => {
    if ((event.target as HTMLElement).closest('[data-layer]')) event.preventDefault();
  });
  root.addEventListener('click', event => {
    if (suppressClick) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  root.addEventListener('pointerdown', event => {
    const target = event.target as HTMLElement;
    const row = target.closest<HTMLElement>('[data-layer]');
    if (!row || event.button !== 0 || target.closest('.mini')) return;
    // On touch, only the grip starts a reorder gesture.
    if (event.pointerType === 'touch' && !target.closest('[data-layer-grip]')) return;
    cancelCurrent?.();
    const ids = options.getMovingIds(row.dataset.layer!);
    if (!ids.length) return;
    const moving = new Set(ids);
    const startX = event.clientX, startY = event.clientY;
    let x = startX, y = startY, active = false, frame = 0;
    let destination: { id: string; side: LayerDropSide } | null = null;
    const indicator = document.createElement('div');
    indicator.className = 'layer-drop-indicator';
    indicator.setAttribute('aria-hidden', 'true');

    function pointDestination() {
      destination = null;
      indicator.hidden = true;
      const bounds = root.getBoundingClientRect();
      if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
      const rows = [...root.querySelectorAll<HTMLElement>('[data-layer]')].filter(item => !moving.has(item.dataset.layer!));
      if (!rows.length) return;
      const above = rows.find(item => { const r = item.getBoundingClientRect(); return y < r.top + r.height / 2; });
      const anchor = above ?? rows[rows.length - 1];
      const r = anchor.getBoundingClientRect();
      destination = { id: anchor.dataset.layer!, side: above ? 'before' : 'after' };
      indicator.hidden = false;
      indicator.style.top = ((above ? r.top : r.bottom) - bounds.top + root.scrollTop) + 'px';
    }
    function tick() {
      if (!row.isConnected) { finish(false); return; }
      const bounds = root.getBoundingClientRect();
      if (x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom) {
        const edge = 36;
        const dy = y < bounds.top + edge ? -Math.min(12, (bounds.top + edge - y) / 3)
          : y > bounds.bottom - edge ? Math.min(12, (y - bounds.bottom + edge) / 3) : 0;
        root.scrollTop += dy;
      }
      pointDestination();
      frame = requestAnimationFrame(tick);
    }
    function move(ev: PointerEvent) {
      if (ev.pointerId !== event.pointerId) return;
      x = ev.clientX; y = ev.clientY;
      if (!active && Math.hypot(x - startX, y - startY) < 6) return;
      if (!active) {
        active = true;
        root.setPointerCapture(event.pointerId);
        root.classList.add('layer-dragging');
        root.querySelectorAll<HTMLElement>('[data-layer]').forEach(item => item.classList.toggle('is-dragging', moving.has(item.dataset.layer!)));
        root.append(indicator);
        frame = requestAnimationFrame(tick);
      }
      ev.preventDefault();
      pointDestination();
    }
    function finish(commit: boolean) {
      cancelCurrent = undefined;
      cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', cancel);
      root.removeEventListener('lostpointercapture', cancel);
      root.classList.remove('layer-dragging');
      root.querySelectorAll('.is-dragging').forEach(item => item.classList.remove('is-dragging'));
      indicator.remove();
      if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
      if (active) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
      if (commit && active && destination && row.isConnected) options.drop(ids, destination.id, destination.side);
    }
    function up(ev: PointerEvent) {
      if (ev.pointerId !== event.pointerId) return;
      x = ev.clientX; y = ev.clientY;
      if (active) pointDestination();
      finish(true);
    }
    function cancel() { finish(false); }
    function key(ev: KeyboardEvent) {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopImmediatePropagation(); finish(false); }
    }
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', cancel);
    root.addEventListener('lostpointercapture', cancel);
    cancelCurrent = cancel;
  });
}
