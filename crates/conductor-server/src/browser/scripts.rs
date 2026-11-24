//! The fixed JavaScript functions run inside a page. Each is a function
//! expression called with JSON arguments; none is supplied by the model.

pub const READY_STATE: &str =
    "function () { return { state: document.readyState, url: location.href }; }";

/// Describe the page: visible text plus the elements that can be acted on,
/// each tagged with a numeric `data-conductor-ref`. Values of password fields
/// and of fields filled from the vault are left out.
pub const SNAPSHOT: &str = r#"function () {
  const MAX_ELEMENTS = 150;
  const MAX_TEXT = 6000;
  const clip = (value, max) => String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
  document.querySelectorAll("[data-conductor-ref]").forEach((el) => el.removeAttribute("data-conductor-ref"));
  const selector = "a[href], button, input, select, textarea, [role=button], [role=link], [role=checkbox], [role=tab], [contenteditable=true]";
  const elements = [];
  for (const el of document.querySelectorAll(selector)) {
    if (elements.length >= MAX_ELEMENTS) break;
    if (el.tagName === "INPUT" && el.type === "hidden") continue;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden" || style.display === "none") continue;
    const ref = elements.length + 1;
    el.setAttribute("data-conductor-ref", String(ref));
    const labelFor = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const label = el.getAttribute("aria-label") || (labelFor && labelFor.innerText) || el.innerText || el.placeholder || el.name || el.title || "";
    const tag = el.tagName.toLowerCase();
    const secret = el.type === "password" || el.hasAttribute("data-conductor-secret");
    const hasValue = tag === "input" || tag === "textarea" || tag === "select";
    elements.push({
      ref,
      tag,
      kind: el.type || el.getAttribute("role") || "",
      label: clip(label, 80),
      value: hasValue && !secret ? clip(el.value, 80) : "",
    });
  }
  return {
    url: location.href,
    title: clip(document.title, 200),
    text: clip(document.body ? document.body.innerText : "", MAX_TEXT),
    elements,
  };
}"#;

pub const CLICK: &str = r#"function (ref) {
  const el = document.querySelector('[data-conductor-ref="' + ref + '"]');
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.click();
  return true;
}"#;

/// Focus a field and empty it so inserted text replaces what was there.
pub const FOCUS_AND_CLEAR: &str = r#"function (ref) {
  const el = document.querySelector('[data-conductor-ref="' + ref + '"]');
  if (!el) return false;
  el.scrollIntoView({ block: "center" });
  el.focus();
  if (el.isContentEditable) {
    el.textContent = "";
  } else if ("value" in el) {
    const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set && el.tagName !== "SELECT") setter.set.call(el, ""); else el.value = "";
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return true;
}"#;

/// Enter a username and password into the visible login form. Reports which
/// fields were filled and returns nothing else; the form is not submitted.
pub const FILL_LOGIN: &str = r#"function (username, password) {
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !el.disabled && !el.readOnly;
  };
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const isUserField = (el) => {
    const type = (el.type || "text").toLowerCase();
    return type === "text" || type === "email" || type === "tel";
  };
  const passwordField = Array.from(document.querySelectorAll('input[type="password"]')).find(visible) || null;
  const scope = (passwordField && passwordField.form) || document;
  const candidates = Array.from(scope.querySelectorAll("input")).filter((el) => visible(el) && isUserField(el));
  let userField = null;
  if (passwordField) {
    // The username is the last text field that comes before the password.
    for (const el of candidates) {
      if (el.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING) userField = el;
    }
  } else {
    // Username-first sign-in pages show only an identifier field.
    userField = candidates.find((el) => {
      const hint = [el.autocomplete, el.name, el.id, el.type].join(" ").toLowerCase();
      return /user|email|login|identifier/.test(hint);
    }) || null;
  }
  const result = { username: false, password: false };
  if (userField && username) {
    setValue(userField, username);
    result.username = true;
  }
  if (passwordField) {
    setValue(passwordField, password);
    passwordField.setAttribute("data-conductor-secret", "");
    result.password = true;
  }
  return result;
}"#;
