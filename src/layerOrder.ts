export type LayerItem = { id: string; group?: string; locked?: boolean };
export type LayerDropSide = 'before' | 'after';

/** Drag the current selection (on this page) or the grabbed layer, including its groups. */
export function draggedLayerIds<T extends LayerItem>(layers: readonly T[], sourceId: string, selection: readonly string[]): string[] {
  const source = layers.find(layer => layer.id === sourceId);
  if (!source) return [];
  const selected = new Set(selection.includes(sourceId) ? selection : [sourceId]);
  const groups = new Set(layers.filter(layer => selected.has(layer.id) && layer.group).map(layer => layer.group));
  const moving = layers.filter(layer => selected.has(layer.id) || (layer.group && groups.has(layer.group)));
  return moving.some(layer => layer.locked) ? [] : moving.map(layer => layer.id);
}

/** Canvas arrays paint back-to-front; the layer list displays front-to-back.
 * Moving a block preserves its relative paint order and never changes geometry. */
export function reorderLayers<T extends LayerItem>(layers: T[], movingIds: readonly string[], targetId: string, side: LayerDropSide): T[] {
  const ids = new Set(movingIds);
  if (!ids.size || ids.has(targetId) || !layers.some(layer => layer.id === targetId)) return layers;
  const moving = layers.filter(layer => ids.has(layer.id));
  if (moving.length !== ids.size || moving.some(layer => layer.locked)) return layers;
  const remaining = layers.filter(layer => !ids.has(layer.id));
  const target = remaining.findIndex(layer => layer.id === targetId);
  remaining.splice(target + (side === 'before' ? 1 : 0), 0, ...moving);
  return remaining.every((layer, i) => layer === layers[i]) ? layers : remaining;
}
