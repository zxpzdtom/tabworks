(() => {
  let recording = null;
  let replaying = false;
  let seq = 0;
  let lastScrollTimer = null;
  let pointerStart = null;
  let suppressClickUntil = 0;
  const inputTimers = new WeakMap();
  const DRAG_DISTANCE_PX = 12;
  const LONG_PRESS_MS = 650;

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

  function eventPoint(event) {
    return {
      x: Math.round(event.clientX || 0),
      y: Math.round(event.clientY || 0),
    };
  }

  function targetMetaFromEvent(event) {
    const target = event.target?.closest?.("button,a,input,textarea,select,[role],[data-testid],[contenteditable='true']") || event.target;
    return selectorMeta(target);
  }

  function pointDistance(a, b) {
    return Math.hypot((b?.x || 0) - (a?.x || 0), (b?.y || 0) - (a?.y || 0));
  }

  function shouldRecordKey(event) {
    if (isInputLike(event.target)) return false;
    if (event.isComposing) return false;
    if (event.ctrlKey || event.metaKey || event.altKey) return true;
    return ["Enter", "Escape", "Tab", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Backspace", "Delete"].includes(event.key);
  }

  document.addEventListener(
    "click",
    (event) => {
      if (!recording || replaying) return;
      if (performance.now() < suppressClickUntil) return;
      const meta = targetMetaFromEvent(event);
      if (!meta) return;
      const point = eventPoint(event);
      send({
        kind: "click",
        element: meta,
        x: point.x,
        y: point.y,
        button: event.button,
      });
    },
    true,
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!recording || replaying || event.button !== 0 || !event.isPrimary) return;
      const point = eventPoint(event);
      pointerStart = {
        pointerId: event.pointerId,
        pointerType: event.pointerType || "mouse",
        startedAt: performance.now(),
        point,
        lastPoint: point,
        element: targetMetaFromEvent(event),
      };
    },
    true,
  );

  document.addEventListener(
    "pointermove",
    (event) => {
      if (!recording || replaying || !pointerStart || event.pointerId !== pointerStart.pointerId) return;
      pointerStart.lastPoint = eventPoint(event);
    },
    true,
  );

  document.addEventListener(
    "pointerup",
    (event) => {
      if (!recording || replaying || !pointerStart || event.pointerId !== pointerStart.pointerId) return;
      const endedPoint = eventPoint(event);
      const distance = pointDistance(pointerStart.point, endedPoint);
      const durationMs = Math.round(performance.now() - pointerStart.startedAt);
      const base = {
        element: pointerStart.element,
        pointerType: pointerStart.pointerType,
        durationMs,
      };
      if (distance >= DRAG_DISTANCE_PX) {
        suppressClickUntil = performance.now() + 350;
        send({
          kind: "drag",
          ...base,
          targetElement: targetMetaFromEvent(event),
          startX: pointerStart.point.x,
          startY: pointerStart.point.y,
          endX: endedPoint.x,
          endY: endedPoint.y,
          deltaX: endedPoint.x - pointerStart.point.x,
          deltaY: endedPoint.y - pointerStart.point.y,
        });
      } else if (durationMs >= LONG_PRESS_MS) {
        suppressClickUntil = performance.now() + 350;
        send({
          kind: "long-press",
          ...base,
          x: endedPoint.x,
          y: endedPoint.y,
        });
      }
      pointerStart = null;
    },
    true,
  );

  document.addEventListener(
    "pointercancel",
    () => {
      pointerStart = null;
    },
    true,
  );

  document.addEventListener(
    "contextmenu",
    (event) => {
      if (!recording || replaying) return;
      const meta = targetMetaFromEvent(event);
      if (!meta) return;
      const point = eventPoint(event);
      send({ kind: "context-menu", element: meta, x: point.x, y: point.y });
    },
    true,
  );

  document.addEventListener(
    "dblclick",
    (event) => {
      if (!recording || replaying) return;
      const meta = targetMetaFromEvent(event);
      if (!meta) return;
      const point = eventPoint(event);
      send({ kind: "double-click", element: meta, x: point.x, y: point.y });
    },
    true,
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!recording || replaying || !shouldRecordKey(event)) return;
      send({
        kind: "key",
        key: event.key,
        code: event.code,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
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

  function dispatchPointerLike(el, type, point, options = {}) {
    const init = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: point.x,
      clientY: point.y,
      button: options.button ?? 0,
      buttons: options.buttons ?? 1,
      pointerId: options.pointerId ?? 1,
      pointerType: options.pointerType || "mouse",
      isPrimary: true,
    };
    if (typeof PointerEvent === "function") el.dispatchEvent(new PointerEvent(type, init));
    const mouseType = type.replace(/^pointer/, "mouse");
    if (mouseType !== type) el.dispatchEvent(new MouseEvent(mouseType, init));
  }

  function centerOf(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  }

  async function replayPointerGesture(event, type) {
    const selector = selectorForEvent(event);
    const el = selector ? document.querySelector(selector) : null;
    if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
    el.scrollIntoView({ block: "center", inline: "center" });
    await wait(80);
    const start = centerOf(el);
    if (type === "long-press") {
      dispatchPointerLike(el, "pointerdown", start, { pointerType: event.pointerType });
      await wait(Math.max(120, Math.min(Number(event.durationMs || 700), 1500)));
      dispatchPointerLike(el, "pointerup", start, { buttons: 0, pointerType: event.pointerType });
      return { ok: true, kind: event.kind, selector };
    }
    const end = {
      x: Math.round(start.x + Number(event.deltaX || 0)),
      y: Math.round(start.y + Number(event.deltaY || 0)),
    };
    dispatchPointerLike(el, "pointerdown", start, { pointerType: event.pointerType });
    const steps = 8;
    for (let i = 1; i <= steps; i += 1) {
      await wait(Math.max(12, Math.min(Number(event.durationMs || 240) / steps, 80)));
      const current = {
        x: Math.round(start.x + ((end.x - start.x) * i) / steps),
        y: Math.round(start.y + ((end.y - start.y) * i) / steps),
      };
      dispatchPointerLike(document.elementFromPoint(current.x, current.y) || el, "pointermove", current, {
        pointerType: event.pointerType,
      });
    }
    dispatchPointerLike(document.elementFromPoint(end.x, end.y) || el, "pointerup", end, {
      buttons: 0,
      pointerType: event.pointerType,
    });
    return { ok: true, kind: event.kind, selector };
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

    if (event.kind === "double-click" || event.kind === "context-menu") {
      const selector = selectorForEvent(event);
      const el = selector ? document.querySelector(selector) : null;
      if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
      el.scrollIntoView({ block: "center", inline: "center" });
      await wait(80);
      const point = centerOf(el);
      const type = event.kind === "double-click" ? "dblclick" : "contextmenu";
      el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: point.x,
        clientY: point.y,
        button: event.kind === "context-menu" ? 2 : 0,
      }));
      return { ok: true, kind: event.kind, selector };
    }

    if (event.kind === "long-press") return replayPointerGesture(event, "long-press");
    if (event.kind === "drag") return replayPointerGesture(event, "drag");

    if (event.kind === "key") {
      const target = document.activeElement || document.body;
      const init = {
        bubbles: true,
        cancelable: true,
        key: event.key,
        code: event.code,
        ctrlKey: Boolean(event.ctrlKey),
        metaKey: Boolean(event.metaKey),
        altKey: Boolean(event.altKey),
        shiftKey: Boolean(event.shiftKey),
      };
      target.dispatchEvent(new KeyboardEvent("keydown", init));
      target.dispatchEvent(new KeyboardEvent("keyup", init));
      return { ok: true, kind: event.kind };
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
      ["click", "input", "scroll", "submit", "long-press", "drag", "double-click", "context-menu", "key"].includes(event.kind),
    );
    const normalized = [];
    for (const event of playable) {
      const previous = normalized[normalized.length - 1];
      if (
        event.kind === "double-click" &&
        previous?.kind === "click" &&
        selectorForEvent(previous) === selectorForEvent(event)
      ) {
        normalized.pop();
        const prior = normalized[normalized.length - 1];
        if (prior?.kind === "click" && selectorForEvent(prior) === selectorForEvent(event)) {
          normalized.pop();
        }
      }
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
