(() => {
  let recording = null;
  let seq = 0;
  let lastScrollTimer = null;
  const inputTimers = new WeakMap();

  function now() {
    return new Date().toISOString();
  }

  function cssEscape(value) {
    if (globalThis.CSS?.escape) return CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function elementRole(el) {
    const explicit = el.getAttribute?.("role");
    if (explicit) return explicit;
    const tag = el.tagName?.toLowerCase();
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "input" || tag === "textarea" || tag === "select")
      return "textbox";
    return null;
  }

  function cssPath(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
      const tag = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`${tag}#${cssEscape(current.id)}`);
        break;
      }
      let part = tag;
      const className = String(current.className || "")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2);
      if (className.length) {
        part += className.map((item) => `.${cssEscape(item)}`).join("");
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(
          (child) => child.tagName === current.tagName,
        );
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ");
  }

  function selectorMeta(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return null;
    const candidates = [];
    const testId = el.getAttribute("data-testid");
    const ariaLabel = el.getAttribute("aria-label");
    const name = el.getAttribute("name");
    const id = el.id;
    const role = elementRole(el);
    const text = textOf(el).slice(0, 120);

    if (testId) candidates.push({ kind: "testid", selector: `[data-testid="${cssEscape(testId)}"]` });
    if (id) candidates.push({ kind: "id", selector: `#${cssEscape(id)}` });
    if (ariaLabel) candidates.push({ kind: "aria", selector: `[aria-label="${cssEscape(ariaLabel)}"]` });
    if (name) candidates.push({ kind: "name", selector: `[name="${cssEscape(name)}"]` });
    candidates.push({ kind: "css", selector: cssPath(el) });

    return {
      tag: el.tagName,
      type: el.type || null,
      role,
      text,
      testId,
      ariaLabel,
      name,
      selectors: candidates.filter((item) => item.selector),
      preferredSelector: candidates.find((item) => item.selector)?.selector || "",
    };
  }

  function send(event) {
    if (!recording) return;
    chrome.runtime.sendMessage({
      type: "tabworks-recording-event",
      sessionId: recording.sessionId,
      event: {
        seq: ++seq,
        at: now(),
        url: location.href,
        title: document.title,
        ...event,
      },
    });
  }

  function inputValue(el) {
    if (el instanceof HTMLInputElement && el.type === "password") {
      return { value: "", redacted: true };
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      return { value: el.value, redacted: false };
    }
    if (el instanceof HTMLSelectElement) {
      return {
        value: el.multiple
          ? Array.from(el.selectedOptions).map((option) => option.value)
          : el.value,
        redacted: false,
      };
    }
    if (el.isContentEditable) return { value: el.textContent || "", redacted: false };
    return { value: "", redacted: false };
  }

  function isInputLike(el) {
    return (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement ||
      el?.isContentEditable
    );
  }

  function recordInput(el, trigger) {
    const meta = selectorMeta(el);
    if (!meta) return;
    const { value, redacted } = inputValue(el);
    send({ kind: "input", trigger, element: meta, value, redacted });
  }

  document.addEventListener(
    "click",
    (event) => {
      if (!recording) return;
      const target = event.target?.closest?.("button,a,input,textarea,select,[role],[data-testid],[contenteditable='true']");
      const meta = selectorMeta(target || event.target);
      if (!meta) return;
      send({
        kind: "click",
        element: meta,
        x: Math.round(event.clientX),
        y: Math.round(event.clientY),
        button: event.button,
      });
    },
    true,
  );

  document.addEventListener(
    "input",
    (event) => {
      if (!recording || !isInputLike(event.target)) return;
      const target = event.target;
      clearTimeout(inputTimers.get(target));
      inputTimers.set(target, setTimeout(() => recordInput(target, "input"), 350));
    },
    true,
  );

  document.addEventListener(
    "change",
    (event) => {
      if (!recording || !isInputLike(event.target)) return;
      clearTimeout(inputTimers.get(event.target));
      recordInput(event.target, "change");
    },
    true,
  );

  document.addEventListener(
    "submit",
    (event) => {
      if (!recording) return;
      const meta = selectorMeta(event.target);
      send({ kind: "submit", element: meta });
    },
    true,
  );

  window.addEventListener(
    "scroll",
    () => {
      if (!recording) return;
      clearTimeout(lastScrollTimer);
      lastScrollTimer = setTimeout(() => {
        send({
          kind: "scroll",
          scrollX: Math.round(window.scrollX),
          scrollY: Math.round(window.scrollY),
        });
      }, 500);
    },
    true,
  );

  function recordNavigation(reason) {
    send({ kind: "navigation", reason });
  }

  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    history[name] = function patchedHistoryState() {
      const result = original.apply(this, arguments);
      setTimeout(() => recordNavigation(name), 0);
      return result;
    };
  }
  window.addEventListener("popstate", () => recordNavigation("popstate"));
  window.addEventListener("hashchange", () => recordNavigation("hashchange"));

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "tabworks-recording-start") {
      recording = {
        sessionId: message.sessionId,
        startedAt: now(),
      };
      seq = 0;
      send({ kind: "start", viewport: { width: innerWidth, height: innerHeight } });
      sendResponse({ ok: true, url: location.href, title: document.title });
      return true;
    }

    if (message?.type === "tabworks-recording-stop") {
      send({ kind: "stop" });
      recording = null;
      sendResponse({ ok: true, url: location.href, title: document.title });
      return true;
    }

    if (message?.type === "tabworks-recording-status") {
      sendResponse({ ok: true, recording: Boolean(recording), sessionId: recording?.sessionId });
      return true;
    }

    return false;
  });
})();
