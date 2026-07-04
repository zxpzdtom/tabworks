(() => {
  let recording = null;
  let replaying = false;
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
    if (!recording || replaying) return;
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
      if (!recording || replaying) return;
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
      if (!recording || replaying || !isInputLike(event.target)) return;
      const target = event.target;
      clearTimeout(inputTimers.get(target));
      inputTimers.set(target, setTimeout(() => recordInput(target, "input"), 350));
    },
    true,
  );

  document.addEventListener(
    "change",
    (event) => {
      if (!recording || replaying || !isInputLike(event.target)) return;
      clearTimeout(inputTimers.get(event.target));
      recordInput(event.target, "change");
    },
    true,
  );

  document.addEventListener(
    "submit",
    (event) => {
      if (!recording || replaying) return;
      const meta = selectorMeta(event.target);
      send({ kind: "submit", element: meta });
    },
    true,
  );

  window.addEventListener(
    "scroll",
    () => {
      if (!recording || replaying) return;
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

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function selectorForEvent(event) {
    return (
      event?.element?.preferredSelector ||
      event?.element?.selectors?.[0]?.selector ||
      ""
    );
  }

  function setNativeValue(el, value) {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : el instanceof HTMLSelectElement
            ? HTMLSelectElement.prototype
            : null;
    const descriptor = proto
      ? Object.getOwnPropertyDescriptor(proto, "value")
      : null;
    if (descriptor?.set) descriptor.set.call(el, value);
    else if ("value" in el) el.value = value;
    else if (el.isContentEditable) el.textContent = value;
  }

  function dispatchInputEvents(el, value) {
    try {
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: String(value ?? ""),
        }),
      );
    } catch {
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function replayEvent(event) {
    if (event.kind === "click") {
      const selector = selectorForEvent(event);
      const el = selector ? document.querySelector(selector) : null;
      if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
      el.scrollIntoView({ block: "center", inline: "center" });
      await wait(80);
      el.click();
      return { ok: true, kind: event.kind, selector };
    }

    if (event.kind === "input") {
      const selector = selectorForEvent(event);
      const el = selector ? document.querySelector(selector) : null;
      if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
      el.scrollIntoView({ block: "center", inline: "center" });
      if (typeof el.focus === "function") el.focus();
      if (el instanceof HTMLSelectElement && Array.isArray(event.value)) {
        for (const option of el.options) {
          option.selected = event.value.includes(option.value);
        }
      } else {
        setNativeValue(el, event.value ?? "");
      }
      dispatchInputEvents(el, event.value ?? "");
      return { ok: true, kind: event.kind, selector };
    }

    if (event.kind === "scroll") {
      window.scrollTo(event.scrollX || 0, event.scrollY || 0);
      return { ok: true, kind: event.kind };
    }

    if (event.kind === "submit") {
      const selector = selectorForEvent(event);
      const el = selector ? document.querySelector(selector) : null;
      if (!el) return { ok: false, kind: event.kind, selector, error: "表单未找到" };
      if (typeof el.requestSubmit === "function") el.requestSubmit();
      else el.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return { ok: true, kind: event.kind, selector };
    }

    return { ok: true, kind: event.kind, skipped: true };
  }

  function normalizePlayableEvents(events) {
    const playable = events.filter((event) =>
      ["click", "input", "scroll", "submit"].includes(event.kind),
    );
    const normalized = [];
    for (const event of playable) {
      const previous = normalized[normalized.length - 1];
      if (
        event.kind === "input" &&
        previous?.kind === "input" &&
        selectorForEvent(previous) === selectorForEvent(event) &&
        previous.value === event.value
      ) {
        previous.at = event.at || previous.at;
        continue;
      }
      normalized.push(event);
    }
    return normalized;
  }

  async function replayEvents(events, options = {}) {
    const playable = normalizePlayableEvents(events);
    const speed = Math.max(0.1, Number(options.speed || 1));
    const maxDelayMs = Math.max(0, Number(options.maxDelayMs ?? 2000));
    const results = [];
    let previousAt = null;

    replaying = true;
    try {
      for (const event of playable) {
        if (previousAt && event.at) {
          const delta = new Date(event.at).getTime() - new Date(previousAt).getTime();
          if (Number.isFinite(delta) && delta > 0) {
            await wait(Math.min(delta / speed, maxDelayMs));
          }
        }
        previousAt = event.at || previousAt;
        results.push(await replayEvent(event));
      }
    } finally {
      replaying = false;
    }

    return {
      ok: results.every((item) => item.ok),
      played: results.filter((item) => item.ok && !item.skipped).length,
      skipped: results.filter((item) => item.skipped).length,
      failures: results.filter((item) => !item.ok),
      results,
    };
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

    if (message?.type === "tabworks-recording-replay") {
      replayEvents(message.events || [], message.options || {})
        .then((result) => sendResponse(result))
        .catch((err) =>
          sendResponse({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      return true;
    }

    return false;
  });
})();
