import type { Frame } from "puppeteer-core";
import type { PreviewDomNode, PreviewElementSelection } from "../lib/types.js";

export type ElementSnapshot = Omit<PreviewElementSelection, "frameId" | "frameName" | "frameUrl">;

export async function snapshotElement(
  frame: Frame,
  selector?: string,
  point?: { x: number; y: number },
): Promise<ElementSnapshot | null> {
  return frame.evaluate(({ selector: inputSelector, point: inputPoint }) => {
    function normalize(value: string | null | undefined): string {
      return (value ?? "").replace(/\s+/g, " ").trim();
    }

    function isInteractive(element: Element): boolean {
      if (!(element instanceof HTMLElement)) return false;
      const tag = element.tagName.toLowerCase();
      if (["button", "input", "select", "textarea", "summary"].includes(tag)) return true;
      if (tag === "a" && element.hasAttribute("href")) return true;
      if (element.hasAttribute("contenteditable")) return true;
      if (element.hasAttribute("onclick")) return true;
      if ((element.getAttribute("role") ?? "").match(/button|link|tab|checkbox|radio|switch|textbox|menuitem/i)) {
        return true;
      }
      return element.tabIndex >= 0;
    }

    function getRole(element: Element): string | null {
      const explicit = normalize(element.getAttribute("role"));
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "input") return (element.getAttribute("type") ?? "textbox").toLowerCase();
      return null;
    }

    function getName(element: Element, text: string): string | null {
      const candidate = normalize(
        element.getAttribute("aria-label")
          ?? element.getAttribute("title")
          ?? element.getAttribute("placeholder")
          ?? element.getAttribute("alt")
          ?? text,
      );
      return candidate || null;
    }

    function selectorPart(element: Element): string {
      const tag = element.tagName.toLowerCase();
      const id = normalize(element.getAttribute("id"));
      if (id) {
        return `#${CSS.escape(id)}`;
      }

      const classes = [...element.classList]
        .slice(0, 2)
        .map((name) => `.${CSS.escape(name)}`)
        .join("");

      let nth = "";
      const parent = element.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === element.tagName);
        if (siblings.length > 1) {
          nth = `:nth-of-type(${siblings.indexOf(element) + 1})`;
        }
      }

      return `${tag}${classes}${nth}`;
    }

    function buildSelector(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && parts.length < 5) {
        const part = selectorPart(current);
        parts.unshift(part);
        if (part.startsWith("#")) break;
        current = current.parentElement;
      }
      return parts.join(" > ");
    }

    function serializeElement(element: Element) {
      const html = normalize(element.outerHTML).slice(0, 400);
      const text = normalize(element.textContent);
      const rect = element.getBoundingClientRect();
      const attributes = [...element.attributes].reduce<Record<string, string>>((acc, attribute) => {
        if (Object.keys(acc).length >= 12) return acc;
        acc[attribute.name] = attribute.value;
        return acc;
      }, {});

      return {
        selector: buildSelector(element),
        tag: element.tagName.toLowerCase(),
        text: text.slice(0, 220),
        role: getRole(element),
        name: getName(element, text.slice(0, 220)),
        interactive: isInteractive(element),
        id: normalize(element.getAttribute("id")) || null,
        classes: [...element.classList].slice(0, 6),
        htmlPreview: html,
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
        attributes,
      };
    }

    let element: Element | null = null;
    if (typeof inputSelector === "string" && inputSelector.trim()) {
      element = document.querySelector(inputSelector);
    } else if (inputPoint) {
      element = document.elementFromPoint(inputPoint.x, inputPoint.y);
    }

    if (!element) return null;
    return serializeElement(element);
  }, { selector, point });
}

export async function inspectDom(
  frame: Frame,
  interactiveOnly: boolean,
  limit: number,
): Promise<{ nodes: PreviewDomNode[]; truncated: boolean }> {
  return frame.evaluate(({ interactiveOnly: onlyInteractive, limit: maxNodes }) => {
    function normalize(value: string | null | undefined): string {
      return (value ?? "").replace(/\s+/g, " ").trim();
    }

    function isInteractive(element: Element): boolean {
      if (!(element instanceof HTMLElement)) return false;
      const tag = element.tagName.toLowerCase();
      if (["button", "input", "select", "textarea", "summary"].includes(tag)) return true;
      if (tag === "a" && element.hasAttribute("href")) return true;
      if (element.hasAttribute("contenteditable")) return true;
      if ((element.getAttribute("role") ?? "").match(/button|link|tab|checkbox|radio|switch|textbox|menuitem/i)) return true;
      return element.tabIndex >= 0;
    }

    function getRole(element: Element): string | null {
      const explicit = normalize(element.getAttribute("role"));
      if (explicit) return explicit;
      const tag = element.tagName.toLowerCase();
      if (tag === "button") return "button";
      if (tag === "a" && element.hasAttribute("href")) return "link";
      if (tag === "input") return (element.getAttribute("type") ?? "textbox").toLowerCase();
      return null;
    }

    function getName(element: Element, text: string): string | null {
      const candidate = normalize(
        element.getAttribute("aria-label")
          ?? element.getAttribute("title")
          ?? element.getAttribute("placeholder")
          ?? element.getAttribute("alt")
          ?? text,
      );
      return candidate || null;
    }

    function selectorPart(element: Element): string {
      const tag = element.tagName.toLowerCase();
      const id = normalize(element.getAttribute("id"));
      if (id) return `#${CSS.escape(id)}`;

      const classes = [...element.classList]
        .slice(0, 2)
        .map((name) => `.${CSS.escape(name)}`)
        .join("");

      let nth = "";
      const parent = element.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === element.tagName);
        if (siblings.length > 1) {
          nth = `:nth-of-type(${siblings.indexOf(element) + 1})`;
        }
      }

      return `${tag}${classes}${nth}`;
    }

    function buildSelector(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && parts.length < 5) {
        const part = selectorPart(current);
        parts.unshift(part);
        if (part.startsWith("#")) break;
        current = current.parentElement;
      }
      return parts.join(" > ");
    }

    const root = document.body ?? document.documentElement;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const results = [];
    let visited = 0;

    while (walker.nextNode()) {
      visited += 1;
      const element = walker.currentNode;
      if (!(element instanceof Element)) continue;
      const interactive = isInteractive(element);
      if (onlyInteractive && !interactive) continue;

      const text = normalize(element.textContent).slice(0, 220);
      const rect = element.getBoundingClientRect();
      results.push({
        selector: buildSelector(element),
        tag: element.tagName.toLowerCase(),
        text,
        role: getRole(element),
        name: getName(element, text),
        interactive,
        id: normalize(element.getAttribute("id")) || null,
        classes: [...element.classList].slice(0, 6),
        htmlPreview: normalize(element.outerHTML).slice(0, 320),
        bounds: {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
        },
      });
      if (results.length >= maxNodes) {
        break;
      }
    }

    return {
      nodes: results,
      truncated: results.length >= maxNodes || visited > results.length,
    };
  }, { interactiveOnly, limit });
}
