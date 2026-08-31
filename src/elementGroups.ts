export type GroupableElement = { id: string; group?: string; locked?: boolean };

function selectedWithGroups<T extends GroupableElement>(elements: readonly T[], selectedIds: readonly string[]): T[] {
  const selected = new Set(selectedIds);
  const selectedGroups = new Set(
    elements.filter(element => selected.has(element.id) && element.group).map(element => element.group!),
  );
  return elements.filter(element => selected.has(element.id) || Boolean(element.group && selectedGroups.has(element.group)));
}

export function canGroupElements<T extends GroupableElement>(elements: readonly T[], selectedIds: readonly string[]): boolean {
  const targets = selectedWithGroups(elements, selectedIds);
  if (targets.length < 2 || targets.some(element => element.locked)) return false;
  const existing = targets[0].group;
  return !existing || !targets.every(element => element.group === existing);
}

export function groupElements<T extends GroupableElement>(elements: T[], selectedIds: readonly string[], groupId: string): boolean {
  if (!canGroupElements(elements, selectedIds)) return false;
  for (const element of selectedWithGroups(elements, selectedIds)) element.group = groupId;
  return true;
}

function selectedGroupMembers<T extends GroupableElement>(elements: readonly T[], selectedIds: readonly string[]): T[] {
  const selected = new Set(selectedIds);
  const groups = new Set(elements.filter(element => selected.has(element.id) && element.group).map(element => element.group!));
  return elements.filter(element => Boolean(element.group && groups.has(element.group)));
}

export function canUngroupElements<T extends GroupableElement>(elements: readonly T[], selectedIds: readonly string[]): boolean {
  const targets = selectedGroupMembers(elements, selectedIds);
  return targets.length > 0 && !targets.some(element => element.locked);
}

export function ungroupElements<T extends GroupableElement>(elements: T[], selectedIds: readonly string[]): boolean {
  if (!canUngroupElements(elements, selectedIds)) return false;
  for (const element of selectedGroupMembers(elements, selectedIds)) delete element.group;
  return true;
}
