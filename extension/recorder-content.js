(() => {
  if (globalThis.__tabworksRecorderLoaded) return;
  globalThis.__tabworksRecorderLoaded = true;

  let recording = null;
  let replaying = false;
  let seq = 0;
  let lastScrollTimer = null;
  let pointerStart = null;
  let suppressClickUntil = 0;
  let replayCursor = null;
  let replayCursorPoint = null;
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

  function cssPath(el, maxParts = 5) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < maxParts) {
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

  function deepCssPath(el, maxParts = 5) {
    const segments = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE) {
      segments.unshift(cssPath(current, maxParts));
      const root = current.getRootNode?.();
      current = root instanceof ShadowRoot ? root.host : null;
    }
    return segments.filter(Boolean).join(" >>> ");
  }

  function deepQuerySelector(selector, root = document) {
    if (!selector) return null;
    const parts = String(selector).split(/\s*>>>\s*/).filter(Boolean);
    let scope = root;
    let found = null;
    for (const [index, part] of parts.entries()) {
      found = scope.querySelector?.(part) || null;
      if (!found) return null;
      if (index < parts.length - 1) scope = found.shadowRoot;
      if (!scope && index < parts.length - 1) return null;
    }
    return found;
  }

  function deepSelectorCount(selector) {
    if (!selector) return 0;
    const parts = String(selector).split(/\s*>>>\s*/).filter(Boolean);
    if (parts.length <= 1) return selectorCount(selector);
    const last = parts.pop();
    const host = deepQuerySelector(parts.join(" >>> "));
    if (!host?.shadowRoot) return 0;
    try {
      return host.shadowRoot.querySelectorAll(last).length;
    } catch {
      return 0;
    }
  }

  function selectorCount(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  }

  function addCandidate(candidates, kind, selector) {
    if (!selector) return;
    const count = selector.includes(">>>")
      ? deepSelectorCount(selector)
      : selectorCount(selector);
    candidates.push({
      kind,
      selector,
      unique: count === 1,
      count,
    });
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

    if (testId) addCandidate(candidates, "testid", `[data-testid="${cssEscape(testId)}"]`);
    if (id) addCandidate(candidates, "id", `#${cssEscape(id)}`);
    if (ariaLabel) addCandidate(candidates, "aria", `[aria-label="${cssEscape(ariaLabel)}"]`);
    if (name) addCandidate(candidates, "name", `[name="${cssEscape(name)}"]`);
    addCandidate(candidates, "css", deepCssPath(el));
    addCandidate(candidates, "css-full", deepCssPath(el, 12));

    const preferred =
      candidates.find((item) => item.unique)?.selector ||
      candidates.find((item) => item.kind === "css-full")?.selector ||
      candidates.find((item) => item.selector)?.selector ||
      "";

    return {
      tag: el.tagName,
      type: el.type || null,
      role,
      text,
      testId,
      ariaLabel,
      name,
      selectors: candidates.filter((item) => item.selector),
      preferredSelector: preferred,
    };
  }

  function getFrameContext() {
    const context = {
      isTop: window.top === window,
      url: location.href,
      title: document.title,
      frameName: window.name || "",
      frameSelector: "",
      frameIndex: null,
      frameRect: null,
    };
    if (context.isTop) return context;

    try {
      const frameEl = window.frameElement;
      if (!frameEl) return context;
      const ownerDocument = frameEl.ownerDocument;
      const frames = Array.from(ownerDocument.querySelectorAll("iframe,frame"));
      const rect = frameEl.getBoundingClientRect();
      context.frameName = frameEl.getAttribute("name") || context.frameName;
      context.frameSelector = deepCssPath(frameEl, 8);
      context.frameIndex = frames.indexOf(frameEl);
      context.frameRect = {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    } catch {
      /* Cross-origin parents may hide frameElement details. */
    }
    return context;
  }

  function send(event) {
    if (!recording || replaying) return;
    const frameContext = getFrameContext();
    chrome.runtime.sendMessage({
      type: "tabworks-recording-event",
      sessionId: recording.sessionId,
      event: {
        seq: ++seq,
        at: now(),
        url: location.href,
        title: document.title,
        inFrame: !frameContext.isTop,
        frameContext,
        ...event,
      },
    });
  }

  function startRecordingSession(sessionId) {
    recording = {
      sessionId,
      startedAt: now(),
    };
    seq = 0;
    send({ kind: "start", viewport: { width: innerWidth, height: innerHeight } });
  }

  function syncRecordingState(afterStart) {
    if (recording) {
      if (typeof afterStart === "function") afterStart();
      return;
    }
    chrome.runtime.sendMessage({ type: "tabworks-recording-sync" }, (response) => {
      if (chrome.runtime.lastError) return;
      if (response?.recording && response.sessionId && !recording) {
        startRecordingSession(response.sessionId);
      }
      if (recording && typeof afterStart === "function") afterStart();
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

  function targetElementFromEvent(event) {
    const raw = event.composedPath?.()[0] || event.target;
    return raw?.closest?.("button,a,input,textarea,select,[role],[data-testid],[contenteditable='true']") || raw;
  }

  function targetMetaFromEvent(event) {
    return selectorMeta(targetElementFromEvent(event));
  }

  function localPointForEvent(event, el) {
    if (!el?.getBoundingClientRect) return null;
    const rect = el.getBoundingClientRect();
    return {
      offsetX: Math.round((event.clientX - rect.left) * 100) / 100,
      offsetY: Math.round((event.clientY - rect.top) * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  }

  function cleanLabel(value) {
    return String(value || "")
      .replace(/To pick up a draggable item[\s\S]*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function rowLabel(el) {
    const text = cleanLabel(el?.innerText || el?.textContent || "");
    return text.slice(0, 80);
  }

  function sortableSnapshotFromTarget(target) {
    let row = target;
    while (row && row !== document.body) {
      const rect = row.getBoundingClientRect?.();
      const label = rowLabel(row);
      if (
        rect &&
        rect.width >= 120 &&
        rect.height >= 28 &&
        rect.height <= 90 &&
        label &&
        !/^(取\s*消|确\s*定|自定义导航栏)/.test(label)
      ) {
        break;
      }
      row = row.parentElement;
    }
    if (!row || row === document.body) return null;
    const container = row.parentElement;
    if (!container) return null;
    const rows = Array.from(container.children).filter((child) => {
      const rect = child.getBoundingClientRect?.();
      const label = rowLabel(child);
      return rect && rect.width >= 120 && rect.height >= 28 && rect.height <= 90 && label;
    });
    if (rows.length < 2) return null;
    const labels = rows.map(rowLabel);
    const sourceLabel = rowLabel(row);
    const fromIndex = rows.indexOf(row);
    if (fromIndex < 0 || !sourceLabel) return null;
    return {
      sourceLabel,
      fromIndex,
      labels,
      container: selectorMeta(container),
      rowSelector: selectorMeta(row),
    };
  }

  function sortableAfter(before) {
    if (!before?.labels?.length || !before.sourceLabel) return null;
    const containerSelector = before.container?.preferredSelector;
    const scope = containerSelector ? deepQuerySelector(containerSelector) : document;
    const matching = [];
    for (const el of Array.from((scope || document).querySelectorAll("*"))) {
      if (rowLabel(el) === before.sourceLabel) matching.push(el);
    }
    const source = matching.find((el) => {
      const rect = el.getBoundingClientRect?.();
      return rect && rect.width >= 120 && rect.height >= 28 && rect.height <= 90;
    });
    const container = source?.parentElement;
    if (!container) return null;
    const labels = Array.from(container.children)
      .map(rowLabel)
      .filter(Boolean);
    const toIndex = labels.indexOf(before.sourceLabel);
    if (toIndex < 0) return null;
    return {
      sourceLabel: before.sourceLabel,
      fromIndex: before.fromIndex,
      toIndex,
      moveDelta: toIndex - before.fromIndex,
      before: before.labels,
      after: labels,
      rowElement: before.rowSelector,
    };
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
      if (replaying) return;
      if (performance.now() < suppressClickUntil) return;
      const meta = targetMetaFromEvent(event);
      if (!meta) return;
      const point = eventPoint(event);
      const clickEvent = {
        kind: "click",
        element: meta,
        x: point.x,
        y: point.y,
        button: event.button,
      };
      if (!recording) {
        syncRecordingState(() => send(clickEvent));
        return;
      }
      send(clickEvent);
    },
    true,
  );

  document.addEventListener(
    "pointerdown",
    (event) => {
      if (replaying || event.button !== 0 || !event.isPrimary) return;
      if (!recording) {
        syncRecordingState();
        return;
      }
      const point = eventPoint(event);
      const target = targetElementFromEvent(event);
      pointerStart = {
        pointerId: event.pointerId,
        pointerType: event.pointerType || "mouse",
        startedAt: performance.now(),
        point,
        lastPoint: point,
        element: selectorMeta(target),
        localPoint: localPointForEvent(event, target),
        sortable: sortableSnapshotFromTarget(target),
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
        const dragEvent = {
          kind: "drag",
          ...base,
          targetElement: targetMetaFromEvent(event),
          startX: pointerStart.point.x,
          startY: pointerStart.point.y,
          endX: endedPoint.x,
          endY: endedPoint.y,
          startOffsetX: pointerStart.localPoint?.offsetX,
          startOffsetY: pointerStart.localPoint?.offsetY,
          elementWidth: pointerStart.localPoint?.width,
          elementHeight: pointerStart.localPoint?.height,
          deltaX: endedPoint.x - pointerStart.point.x,
          deltaY: endedPoint.y - pointerStart.point.y,
        };
        const sortableBefore = pointerStart.sortable;
        setTimeout(() => {
          const sortable = sortableAfter(sortableBefore);
          send(sortable ? { ...dragEvent, sortable } : dragEvent);
        }, 120);
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
      if (replaying || !isInputLike(event.target)) return;
      const target = event.target;
      if (!recording) {
        syncRecordingState(() => recordInput(target, "input"));
        return;
      }
      clearTimeout(inputTimers.get(target));
      inputTimers.set(target, setTimeout(() => recordInput(target, "input"), 350));
    },
    true,
  );

  document.addEventListener(
    "change",
    (event) => {
      if (replaying || !isInputLike(event.target)) return;
      if (!recording) {
        const target = event.target;
        syncRecordingState(() => recordInput(target, "change"));
        return;
      }
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
    const selectors = event?.element?.selectors || [];
    return (
      selectors.find((item) => item.unique)?.selector ||
      event?.element?.preferredSelector ||
      selectors.find((item) => item.selector)?.selector ||
      ""
    );
  }

  function findEventElement(event) {
    const selector = selectorForEvent(event);
    return selector ? deepQuerySelector(selector) : null;
  }

  function ensureReplayCursor() {
    if (replayCursor) return replayCursor;
    replayCursor = document.createElement("div");
    replayCursor.setAttribute("data-tabworks-replay-cursor", "true");
    replayCursor.innerHTML = `
      <div class="tw-replay-cursor-glow"></div>
      <svg class="tw-replay-cursor-arrow" viewBox="0 0 24 24" aria-hidden="true">
        <path class="tw-replay-cursor-fill" d="M5.7 4.1C5.1 3.7 4.4 4.25 4.62 4.98L8.95 20.15C9.18 20.95 10.28 21.08 10.68 20.34L12.94 16.12C13.12 15.78 13.48 15.58 13.86 15.6L19.05 15.8C19.92 15.84 20.25 14.69 19.52 14.22L5.7 4.1Z" />
      </svg>
      <div class="tw-replay-cursor-ring"></div>
    `;
    const style = document.createElement("style");
    style.textContent = `
[data-tabworks-replay-cursor] {
  position: fixed;
  left: 0;
  top: 0;
  width: 24px;
  height: 24px;
  z-index: 2147483647;
  pointer-events: none;
  transform: translate3d(-40px, -40px, 0);
  transition: transform 180ms cubic-bezier(.2,.8,.2,1), opacity 120ms ease;
  opacity: 0;
}
[data-tabworks-replay-cursor] .tw-replay-cursor-glow {
  position: absolute;
  left: -14px;
  top: -12px;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(64, 156, 255, .36) 0%, rgba(64, 156, 255, .20) 34%, rgba(64, 156, 255, 0) 70%);
  filter: blur(2px);
}
[data-tabworks-replay-cursor] .tw-replay-cursor-arrow {
  position: relative;
  display: block;
  width: 24px;
  height: 24px;
  overflow: visible;
  filter:
    drop-shadow(0 1px 1px rgba(15, 23, 42, .34))
    drop-shadow(0 0 6px rgba(74, 158, 255, .56));
}
[data-tabworks-replay-cursor] .tw-replay-cursor-fill {
  fill: #05070a;
  stroke: #fff;
  stroke-width: 2.55;
  stroke-linecap: round;
  stroke-linejoin: round;
  paint-order: stroke fill;
}
[data-tabworks-replay-cursor] .tw-replay-cursor-ring {
  position: absolute;
  left: -6px;
  top: -6px;
  width: 20px;
  height: 20px;
  border: 2px solid rgba(64, 156, 255, .58);
  border-radius: 50%;
  opacity: 0;
  transform: scale(.6);
}
[data-tabworks-replay-cursor].click .tw-replay-cursor-ring {
  animation: twReplayCursorPulse 260ms ease-out;
}
@keyframes twReplayCursorPulse {
  0% { opacity: .9; transform: scale(.45); }
  100% { opacity: 0; transform: scale(1.4); }
}`;
    document.documentElement.appendChild(style);
    document.documentElement.appendChild(replayCursor);
    return replayCursor;
  }

  async function moveReplayCursor(point, options = {}) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const cursor = ensureReplayCursor();
    const from = replayCursorPoint || point;
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const duration = Math.max(120, Math.min(480, distance * 1.2));
    cursor.style.transitionDuration = `${Math.round(duration)}ms, 120ms`;
    cursor.style.opacity = "1";
    cursor.classList.remove("click");
    cursor.style.transform = `translate3d(${Math.round(point.x - 5)}px, ${Math.round(point.y - 4)}px, 0)`;
    replayCursorPoint = point;
    await wait(duration);
    if (options.click) {
      cursor.classList.add("click");
      await wait(220);
      cursor.classList.remove("click");
    }
  }

  function showToast(message, kind = "success") {
    const existing = document.querySelector("[data-tabworks-toast]");
    if (existing) existing.remove();

    const toast = document.createElement("div");
    toast.setAttribute("data-tabworks-toast", "true");
    toast.className = kind === "error" ? "error" : "success";
    toast.textContent = message;

    const styleId = "tabworks-toast-style";
    if (!document.getElementById(styleId)) {
      const style = document.createElement("style");
      style.id = styleId;
      style.textContent = `
[data-tabworks-toast] {
  position: fixed;
  right: 18px;
  top: 18px;
  z-index: 2147483647;
  max-width: min(360px, calc(100vw - 36px));
  padding: 10px 13px;
  border-radius: 12px;
  color: #152033;
  background: rgba(255, 255, 255, .96);
  border: 1px solid rgba(15, 23, 42, .10);
  box-shadow: 0 12px 32px rgba(15, 23, 42, .16), 0 2px 6px rgba(15, 23, 42, .10);
  font: 500 13px/1.45 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
  opacity: 0;
  transform: translate3d(0, -8px, 0) scale(.98);
  transition: opacity 160ms ease, transform 180ms cubic-bezier(.2,.8,.2,1);
  pointer-events: none;
}
[data-tabworks-toast].success {
  border-color: rgba(18, 128, 92, .22);
}
[data-tabworks-toast].error {
  border-color: rgba(194, 65, 58, .24);
}
[data-tabworks-toast].show {
  opacity: 1;
  transform: translate3d(0, 0, 0) scale(1);
}`;
      document.documentElement.appendChild(style);
    }

    document.documentElement.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => toast.remove(), 180);
    }, 2800);
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
    const el = findEventElement(event);
    if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
    el.scrollIntoView({ block: "center", inline: "center" });
    await wait(80);
    const start = centerOf(el);
    if (type === "long-press") {
      await moveReplayCursor(start);
      dispatchPointerLike(el, "pointerdown", start, { pointerType: event.pointerType });
      await wait(Math.max(120, Math.min(Number(event.durationMs || 700), 1500)));
      dispatchPointerLike(el, "pointerup", start, { buttons: 0, pointerType: event.pointerType });
      await moveReplayCursor(start, { click: true });
      return { ok: true, kind: event.kind, selector };
    }
    const end = {
      x: Math.round(start.x + Number(event.deltaX || 0)),
      y: Math.round(start.y + Number(event.deltaY || 0)),
    };
    await moveReplayCursor(start);
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
      await moveReplayCursor(current);
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
      const el = findEventElement(event);
      if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
      el.scrollIntoView({ block: "center", inline: "center" });
      await wait(80);
      await moveReplayCursor(centerOf(el), { click: true });
      el.click();
      return { ok: true, kind: event.kind, selector };
    }

    if (event.kind === "double-click" || event.kind === "context-menu") {
      const selector = selectorForEvent(event);
      const el = findEventElement(event);
      if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
      el.scrollIntoView({ block: "center", inline: "center" });
      await wait(80);
      const point = centerOf(el);
      await moveReplayCursor(point, { click: true });
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
      const el = findEventElement(event);
      if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
      el.scrollIntoView({ block: "center", inline: "center" });
      await wait(80);
      await moveReplayCursor(centerOf(el), { click: true });
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
      const el = findEventElement(event);
      if (!el) return { ok: false, kind: event.kind, selector, error: "表单未找到" };
      el.scrollIntoView({ block: "center", inline: "center" });
      await wait(80);
      await moveReplayCursor(centerOf(el), { click: true });
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
      startRecordingSession(message.sessionId);
      sendResponse({
        ok: true,
        url: location.href,
        title: document.title,
        frameContext: getFrameContext(),
      });
      return true;
    }

    if (message?.type === "tabworks-recording-stop") {
      send({ kind: "stop" });
      recording = null;
      sendResponse({
        ok: true,
        url: location.href,
        title: document.title,
        frameContext: getFrameContext(),
      });
      return true;
    }

    if (message?.type === "tabworks-recording-status") {
      sendResponse({ ok: true, recording: Boolean(recording), sessionId: recording?.sessionId });
      return true;
    }

    if (message?.type === "tabworks-frame-context") {
      sendResponse({
        ok: true,
        url: location.href,
        title: document.title,
        frameContext: getFrameContext(),
      });
      return true;
    }

    if (message?.type === "tabworks-recording-toast") {
      showToast(message.message || "执行完成", message.kind || "success");
      sendResponse({ ok: true });
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

  syncRecordingState();
})();
