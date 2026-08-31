/** Artwork uses document pixels; page headers and their spacing use screen pixels. */
export const PAGE_GAP = 64;

export function pageOffset(pages: readonly { h: number }[], index: number, zoom: number): number {
  let top = 0;
  for (let i = 0; i < index; i++) top += pages[i].h + PAGE_GAP / zoom;
  return top;
}

export function pageAtY(pages: readonly { h: number }[], y: number, zoom: number): number {
  let top = 0;
  for (let i = 0; i < pages.length; i++) {
    if (y < top + pages[i].h + PAGE_GAP / zoom / 2) return i;
    top += pages[i].h + PAGE_GAP / zoom;
  }
  return Math.max(0, pages.length - 1);
}

/** Keep the point inside the anchored page still as screen-sized gaps reflow. */
export function zoomedPanY(pages: readonly { h: number }[], panY: number, anchorY: number, oldZoom: number, nextZoom: number): number {
  const worldY = (anchorY - panY) / oldZoom;
  const index = pageAtY(pages, worldY, oldZoom);
  const localY = worldY - pageOffset(pages, index, oldZoom);
  return anchorY - (pageOffset(pages, index, nextZoom) + localY) * nextZoom;
}

export function verticalBounds(documentHeight: number, viewportHeight: number, margin = 56, bottomMargin = 80) {
  if (documentHeight + margin + bottomMargin <= viewportHeight) {
    const center = (viewportHeight - documentHeight) / 2;
    return { min: center, max: center };
  }
  return { min: viewportHeight - documentHeight - bottomMargin, max: margin };
}
