"use client";

/**
 * Copying the exact outgoing DM.
 *
 * The whole phone workflow turns on this one action: read the reply in
 * Instagram, generate here, copy, switch back, paste, send. It copies the DM and
 * nothing else — no quotes, no labels, no "here's your message" preamble — since
 * whatever lands on the clipboard is what gets pasted into a real conversation.
 */

/**
 * Writes text to the clipboard, falling back where the async API is unavailable.
 *
 * `navigator.clipboard` needs a secure context and is missing or blocked in some
 * Android in-app browsers, so a hidden textarea and `execCommand` stand behind
 * it. Both paths run inside the click that asked for the copy.
 */
export async function copyText(text: string): Promise<boolean> {
  const value = text ?? "";
  if (!value) return false;

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path rather than failing the copy.
  }

  try {
    if (typeof document === "undefined") return false;
    const area = document.createElement("textarea");
    area.value = value;
    // Kept off-screen and unfocusable-looking, but still selectable on iOS/Android.
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Reads the clipboard, only ever from a button the operator pressed.
 *
 * Never called on load, on focus, or on any implicit event: reading a clipboard
 * unasked is a thing an app should not do, and browsers will prompt for it
 * anyway. Returns null when unavailable or refused, so the caller falls back to
 * an ordinary paste into the textarea.
 */
export async function readClipboard(): Promise<string | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.readText) return null;
    const text = await navigator.clipboard.readText();
    return text?.trim() ? text : null;
  } catch {
    return null;
  }
}

export function clipboardReadSupported(): boolean {
  return typeof navigator !== "undefined" && Boolean(navigator.clipboard?.readText);
}
