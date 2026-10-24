export const ENTER_ACTIVATABLE_SELECTOR: string;

export const KEYBOARD_NAVIGATION_KEYS: ReadonlySet<string>;

export function shouldSuppressEnter(input: {
    key: string;
    lastModality: "pointer" | "keyboard" | null;
    element: Element | null | undefined;
}): boolean;

export function installEnterFocusGuard(win: Window): () => void;
