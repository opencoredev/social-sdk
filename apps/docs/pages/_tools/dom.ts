// Small DOM helpers shared by the tool page scripts. Elements are looked up once
// and checked with instanceof, so a missing or renamed element fails loudly at
// load instead of turning into undefined later.

export function element<T extends Element>(id: string, kind: new () => T): T {
  const found = document.getElementById(id);

  if (!(found instanceof kind)) throw new Error(`The tool page is missing #${id}.`);

  return found;
}

export function elements<T extends Element>(selector: string, kind: new () => T): T[] {
  return Array.from(document.querySelectorAll(selector)).filter(
    (found): found is T => found instanceof kind,
  );
}

/** Shows `message` in a status line, then clears it. */
export function flash(target: HTMLElement, message: string): void {
  target.textContent = message;
  window.setTimeout(() => {
    if (target.textContent === message) target.textContent = "";
  }, 2400);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);

    return true;
  } catch {
    return false;
  }
}

/** Wires every button with data-copy="<id>" to copy that element's text. */
export function wireCopyButtons(): void {
  for (const button of elements("button[data-copy]", HTMLButtonElement)) {
    button.addEventListener("click", async () => {
      const source = document.getElementById(button.dataset["copy"] ?? "");

      const copied = source !== null && (await copyText(source.textContent ?? ""));

      button.textContent = copied ? "Copied" : "Select and copy";
      window.setTimeout(() => {
        button.textContent = "Copy";
      }, 1800);
    });
  }
}
