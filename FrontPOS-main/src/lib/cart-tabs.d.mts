export const MAX_VISIBLE_CART_TABS: number;

export function splitCartTabs(
    keys: ReadonlyArray<string>,
    activeKey: string,
    max?: number,
): { visible: string[]; overflow: string[] };

export function countCartUnits(
    items: ReadonlyArray<{ cartQuantity?: number; isWeighted?: boolean } | null | undefined>,
): number;
