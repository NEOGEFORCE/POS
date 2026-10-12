export interface HabitualOrderMetadata {
  habitualOrderQty: number | null;
  habitualReorderThreshold: number | null;
}

export interface HabitualOrderItem {
  habitualOrderQty?: number | string | null;
  habitualReorderThreshold?: number | string | null;
}

export function getHabitualOrderMetadata(
  item: HabitualOrderItem | null | undefined,
): HabitualOrderMetadata | null;

export function hasHabitualOrderMetadata(
  item: HabitualOrderItem | null | undefined,
): boolean;

export function describeHabitualOrder(
  item: HabitualOrderItem | null | undefined,
): string | null;
