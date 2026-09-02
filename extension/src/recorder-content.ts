// @ts-nocheck
(() => {
  const RECORDER_SCRIPT_VERSION = 13;
  if (globalThis.__tabworksRecorderVersion === RECORDER_SCRIPT_VERSION) return;
  globalThis.__tabworksRecorderVersion = RECORDER_SCRIPT_VERSION;
  globalThis.__tabworksRecorderLoaded = true;

  let recording = null;
  let replaying = false;
  let seq = 0;
  let lastScrollTimer = null;
  let pointerStart = null;
  let mainPointerStart = null;
  let suppressClickUntil = 0;
  let replayCursor = null;
  let replayCursorPoint = null;
  let replayCursorSeq = 0;
  const inputTimers = new WeakMap();
  const handledEvents = new WeakSet();
  const recentRecordedEvents = [];
  const MAIN_EVENT_CHANNEL = "__tabworksRecorderMainEvent";
  const MAIN_ACK_CHANNEL = "__tabworksRecorderMainAck";
  const REPLAY_CURSOR_CHANNEL = "__tabworksReplayCursor";
  const DRAG_DISTANCE_PX = 12;
  const LONG_PRESS_MS = 650;
  const replayCursorPending = new Map();

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

  function frameContextForMessageSource(source, payload) {
    const payloadContext = payload?.frameContext || {};
    if (!source || source === window) return payloadContext;

    const context = {
      isTop: false,
      url: payloadContext.url || payload?.url || "",
      title: payloadContext.title || payload?.title || "",
      frameName: payloadContext.frameName || "",
      frameSelector: payloadContext.frameSelector || "",
      frameIndex: Number.isInteger(payloadContext.frameIndex)
        ? payloadContext.frameIndex
        : null,
      frameRect: payloadContext.frameRect || null,
    };

    try {
      const frames = Array.from(document.querySelectorAll("iframe,frame"));
      const frameEl = frames.find((item) => item.contentWindow === source);
      if (!frameEl) return context;
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
      /* Cross-origin frames can still post messages, but details may be hidden. */
    }

    return context;
  }

  function isTopFrame() {
    try {
      return window.top === window;
    } catch {
      return true;
    }
  }

  function frameViewportPointFromChildMessage(source, payload) {
    const point = payload?.point || {};
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!source || source === window) return { x, y };
    const context = frameContextForMessageSource(source, payload);
    const rect = context?.frameRect;
    if (
      !rect ||
      !Number.isFinite(Number(rect.x)) ||
      !Number.isFinite(Number(rect.y))
    ) {
      return { x, y };
    }
    return {
      x: Math.round(Number(rect.x) + x),
      y: Math.round(Number(rect.y) + y),
    };
  }

  function postReplayCursorAck(target, requestId, ok = true, error = "") {
    if (!target || !requestId) return;
    try {
      target.postMessage(
        {
          [REPLAY_CURSOR_CHANNEL]: true,
          ack: true,
          requestId,
          ok,
          error,
        },
        "*",
      );
    } catch {
      /* The requesting frame may have navigated away. */
    }
  }

  function sendReplayCursorRequestToParent(payload, timeoutMs = 1800) {
    if (isTopFrame()) return Promise.resolve();
    const requestId =
      payload.requestId || `${Date.now()}-${++replayCursorSeq}-${Math.random().toString(36).slice(2, 7)}`;
    const message = {
      ...payload,
      [REPLAY_CURSOR_CHANNEL]: true,
      requestId,
      frameContext: getFrameContext(),
    };
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        replayCursorPending.delete(requestId);
        resolve({ ok: false, error: "cursor ack timeout" });
      }, timeoutMs);
      replayCursorPending.set(requestId, (response) => {
        clearTimeout(timeout);
        resolve(response);
      });
      try {
        window.parent.postMessage(message, "*");
      } catch {
        clearTimeout(timeout);
        replayCursorPending.delete(requestId);
        resolve({ ok: false, error: "cursor postMessage failed" });
      }
    });
  }

  function send(event) {
    if (!recording || replaying) return;
    if (isDuplicateRecordedEvent(event)) return;
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

  function isDuplicateRecordedEvent(event) {
    if (event.kind === "start" || event.kind === "stop") return false;
    const selector =
      event.element?.preferredSelector ||
      event.element?.selectors?.find((item) => item.unique)?.selector ||
      "";
    const key = [
      event.kind,
      selector,
      Math.round(Number(event.x ?? event.startX ?? 0)),
      Math.round(Number(event.y ?? event.startY ?? 0)),
      event.value === undefined ? "" : JSON.stringify(event.value),
    ].join("|");
    const timestamp = performance.now();
    while (
      recentRecordedEvents.length &&
      timestamp - recentRecordedEvents[0].timestamp > 180
    ) {
      recentRecordedEvents.shift();
    }
    if (recentRecordedEvents.some((item) => item.key === key)) return true;
    if (
      event.kind === "click" &&
      recentRecordedEvents.some(
        (item) =>
          item.event?.kind === "click" &&
          timestamp - item.timestamp <= 350 &&
          closeNumber(item.event?.x, event.x, 12) &&
          closeNumber(item.event?.y, event.y, 12),
      )
    ) {
      return true;
    }
    recentRecordedEvents.push({ key, timestamp, event });
    return false;
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
    const path = event.composedPath?.() || [];
    const raw =
      path.find((node) => node?.nodeType === Node.ELEMENT_NODE) ||
      event.target?.parentElement ||
      event.target;
    const fallback = document.elementFromPoint?.(event.clientX || 0, event.clientY || 0);
    const el =
      raw?.nodeType === Node.ELEMENT_NODE
        ? raw
        : fallback?.nodeType === Node.ELEMENT_NODE
          ? fallback
          : null;
    return (
      el?.closest?.("button,a,input,textarea,select,[role],[data-testid],[contenteditable='true']") ||
      el ||
      fallback
    );
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

  function antCascaderMetaFromTarget(target, event) {
    const item = target?.closest?.(".ant-cascader-menu-item");
    if (!item) return null;
    const checkbox =
      item.querySelector(".ant-cascader-checkbox-inner") ||
      item.querySelector(".ant-cascader-checkbox");
    const content = item.querySelector(".ant-cascader-menu-item-content") || item;
    const checkboxRect = checkbox?.getBoundingClientRect?.();
    return {
      itemText: cleanLabel(content.innerText || content.textContent || ""),
      itemSelector: deepCssPath(item, 10),
      checkboxSelector: checkbox ? deepCssPath(checkbox, 10) : "",
      clickedCheckbox:
        Boolean(checkboxRect) &&
        Number.isFinite(Number(checkboxRect.left)) &&
        Number(event?.clientX) >= checkboxRect.left - 8 &&
        Number(event?.clientX) <= checkboxRect.right + 8 &&
        Number(event?.clientY) >= checkboxRect.top - 8 &&
        Number(event?.clientY) <= checkboxRect.bottom + 8,
    };
  }

  function antSelectRemoveMetaFromTarget(target) {
    const remove = target?.closest?.(".ant-select-selection-item-remove");
    if (!remove) return null;
    const item = remove.closest(".ant-select-selection-item");
    if (!item) return null;
    const content =
      item.querySelector(".ant-select-selection-item-content") || item;
    return {
      itemText: cleanLabel(content.innerText || content.textContent || ""),
      itemSelector: deepCssPath(item, 10),
      removeSelector: deepCssPath(remove, 10),
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

  function takeEvent(event) {
    if (handledEvents.has(event)) return false;
    handledEvents.add(event);
    return true;
  }

  function addCaptureListener(type, handler) {
    const guardedHandler = (event) => {
      // 脚本只在开始录制时动态注入；停止后保留消息端点用于回放，
      // 但不再采集、分析或同步页面事件。
      if (!recording && !replaying) return;
      handler(event);
    };
    window.addEventListener(type, guardedHandler, true);
    document.addEventListener(type, guardedHandler, true);
  }

  addCaptureListener("click", (event) => {
    if (!takeEvent(event) || replaying) return;
    if (performance.now() < suppressClickUntil) return;
    const meta = targetMetaFromEvent(event);
    if (!meta) return;
    const point = eventPoint(event);
    const target = targetElementFromEvent(event);
    const localPoint = localPointForEvent(event, target);
    const antCascader = antCascaderMetaFromTarget(target, event);
    const antSelectRemove = antSelectRemoveMetaFromTarget(target);
    const clickEvent = {
      kind: "click",
      element: meta,
      x: point.x,
      y: point.y,
      antCascader,
      antSelectRemove,
      offsetX: localPoint?.offsetX,
      offsetY: localPoint?.offsetY,
      elementWidth: localPoint?.width,
      elementHeight: localPoint?.height,
      button: event.button,
    };
    if (!recording) {
      syncRecordingState(() => send(clickEvent));
      return;
    }
    send(clickEvent);
  });

  function beginPointerGesture(event) {
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
  }

  function elementFromPointPayload(payload) {
    if (!Number.isFinite(payload?.x) || !Number.isFinite(payload?.y)) {
      return document.activeElement || document.body;
    }
    return document.elementFromPoint(payload.x, payload.y) || document.activeElement || document.body;
  }

  function mainPoint(payload) {
    return {
      x: Math.round(Number(payload?.x || 0)),
      y: Math.round(Number(payload?.y || 0)),
    };
  }

  function recordMainBridgeEvent(payload) {
    if (!payload || replaying) return;
    if (payload.kind === "pointerdown" || payload.kind === "pointerup") return;
    if (!recording) {
      syncRecordingState(() => recordMainBridgeEvent(payload));
      return;
    }
    const point = mainPoint(payload);
    const target = elementFromPointPayload(payload);
    const meta =
      payload.element ||
      selectorMeta(
        target?.closest?.("button,a,input,textarea,select,[role],[data-testid],[contenteditable='true']") ||
          target,
      );
    const frameOverrides = {
      inFrame: Boolean(payload.inFrame || payload.frameContext?.isTop === false),
      frameContext: payload.frameContext,
      url: payload.url,
      title: payload.title,
    };

    if (payload.kind === "pointerdown") {
      mainPointerStart = {
        pointerId: payload.pointerId,
        pointerType: payload.pointerType || "mouse",
        startedAt: performance.now(),
        point,
        element: meta,
        localPoint: localPointForEvent({ clientX: point.x, clientY: point.y }, target),
        sortable: sortableSnapshotFromTarget(target),
      };
      return;
    }

    if (payload.kind === "pointerup") {
      if (!mainPointerStart || payload.pointerId !== mainPointerStart.pointerId) return;
      const distance = pointDistance(mainPointerStart.point, point);
      const durationMs = Math.round(performance.now() - mainPointerStart.startedAt);
      if (distance >= DRAG_DISTANCE_PX) {
        const dragEvent = {
          kind: "drag",
          element: mainPointerStart.element,
          pointerType: mainPointerStart.pointerType,
          durationMs,
          targetElement: meta,
          startX: mainPointerStart.point.x,
          startY: mainPointerStart.point.y,
          endX: point.x,
          endY: point.y,
          startOffsetX: mainPointerStart.localPoint?.offsetX,
          startOffsetY: mainPointerStart.localPoint?.offsetY,
          elementWidth: mainPointerStart.localPoint?.width,
          elementHeight: mainPointerStart.localPoint?.height,
          deltaX: point.x - mainPointerStart.point.x,
          deltaY: point.y - mainPointerStart.point.y,
        };
        const sortableBefore = mainPointerStart.sortable;
        setTimeout(() => {
          const sortable = sortableAfter(sortableBefore);
          send(
            sortable
              ? { ...dragEvent, sortable, source: "main-world", ...frameOverrides }
              : { ...dragEvent, source: "main-world", ...frameOverrides },
          );
        }, 120);
      } else if (durationMs >= LONG_PRESS_MS) {
        send({
          kind: "long-press",
          element: mainPointerStart.element,
          pointerType: mainPointerStart.pointerType,
          durationMs,
          x: point.x,
          y: point.y,
          source: "main-world",
          ...frameOverrides,
        });
      }
      mainPointerStart = null;
      return;
    }

    if (payload.kind === "input" || payload.kind === "change") {
      if (!meta) return;
      send({
        kind: "input",
        trigger: payload.kind,
        element: meta,
        value: payload.value ?? "",
        redacted: false,
        source: "main-world",
        ...frameOverrides,
      });
      return;
    }

    if (!meta) return;
    if (payload.kind === "click") {
      const localPoint = localPointForEvent({ clientX: point.x, clientY: point.y }, target);
      const antCascader = antCascaderMetaFromTarget(target, {
        clientX: point.x,
        clientY: point.y,
      });
      const antSelectRemove = antSelectRemoveMetaFromTarget(target);
      send({
        kind: "click",
        element: meta,
        x: point.x,
        y: point.y,
        antCascader,
        antSelectRemove,
        offsetX: localPoint?.offsetX,
        offsetY: localPoint?.offsetY,
        elementWidth: localPoint?.width,
        elementHeight: localPoint?.height,
        button: payload.button,
        source: "main-world",
        ...frameOverrides,
      });
    } else if (payload.kind === "double-click" || payload.kind === "context-menu") {
      send({
        kind: payload.kind,
        element: meta,
        x: point.x,
        y: point.y,
        source: "main-world",
        ...frameOverrides,
      });
    }
  }

  async function handleReplayCursorMessage(event, data) {
    if (data.ack) {
      const resolve = replayCursorPending.get(data.requestId);
      if (resolve) {
        replayCursorPending.delete(data.requestId);
        resolve(data);
      }
      return;
    }

    const target = event.source;
    const point = frameViewportPointFromChildMessage(target, data);
    if (!point) {
      postReplayCursorAck(target, data.requestId, false, "invalid cursor point");
      return;
    }

    try {
      if (isTopFrame()) {
        if (data.action === "hide") {
          hideLocalReplayCursor();
        } else if (data.action === "pulse") {
          pulseLocalReplayCursor(point);
        } else {
          await moveLocalReplayCursor(point, data.options || {});
        }
      } else {
        await sendReplayCursorRequestToParent({
          ...data,
          point,
          frameContext: getFrameContext(),
        });
      }
      postReplayCursorAck(target, data.requestId, true);
    } catch (err) {
      postReplayCursorAck(
        target,
        data.requestId,
        false,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  window.addEventListener(
    "message",
    (event) => {
      const data = event.data;
      if (data?.[REPLAY_CURSOR_CHANNEL] === true) {
        handleReplayCursorMessage(event, data);
        return;
      }
      if (!data || data[MAIN_EVENT_CHANNEL] !== true) return;
      const sameWindow = event.source === window;
      const isChildFrame = window.top !== window;
      if (sameWindow && isChildFrame && !recording) {
        return;
      }
      if (sameWindow && data.id && recording) {
        window.postMessage({ [MAIN_ACK_CHANNEL]: true, id: data.id }, "*");
      }
      if (!sameWindow && !data.fallbackToParent) return;
      if (!sameWindow && isChildFrame) return;
      recordMainBridgeEvent({
        ...data.event,
        frameContext: frameContextForMessageSource(event.source, data.event),
        inFrame: !sameWindow || data.event?.inFrame,
      });
    },
    true,
  );

  addCaptureListener("pointerdown", (event) => {
    if (!takeEvent(event) || replaying || event.button !== 0 || !event.isPrimary) return;
    if (!recording) {
      syncRecordingState(() => beginPointerGesture(event));
      return;
    }
    beginPointerGesture(event);
  });

  addCaptureListener("pointermove", (event) => {
    if (!takeEvent(event) || !recording || replaying || !pointerStart || event.pointerId !== pointerStart.pointerId) return;
    pointerStart.lastPoint = eventPoint(event);
  });

  addCaptureListener("pointerup", (event) => {
    if (!takeEvent(event) || !recording || replaying || !pointerStart || event.pointerId !== pointerStart.pointerId) return;
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
  });

  addCaptureListener("pointercancel", (event) => {
    if (!takeEvent(event)) return;
    pointerStart = null;
  });

  addCaptureListener("contextmenu", (event) => {
    if (!takeEvent(event) || !recording || replaying) return;
    const meta = targetMetaFromEvent(event);
    if (!meta) return;
    const point = eventPoint(event);
    send({ kind: "context-menu", element: meta, x: point.x, y: point.y });
  });

  addCaptureListener("dblclick", (event) => {
    if (!takeEvent(event) || !recording || replaying) return;
    const meta = targetMetaFromEvent(event);
    if (!meta) return;
    const point = eventPoint(event);
    send({ kind: "double-click", element: meta, x: point.x, y: point.y });
  });

  addCaptureListener("keydown", (event) => {
    if (!takeEvent(event) || !recording || replaying || !shouldRecordKey(event)) return;
    send({
      kind: "key",
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
    });
  });

  addCaptureListener("input", (event) => {
    if (!takeEvent(event) || replaying || !isInputLike(event.target)) return;
    const target = event.target;
    if (!recording) {
      syncRecordingState(() => recordInput(target, "input"));
      return;
    }
    clearTimeout(inputTimers.get(target));
    inputTimers.set(target, setTimeout(() => recordInput(target, "input"), 350));
  });

  addCaptureListener("change", (event) => {
    if (!takeEvent(event) || replaying || !isInputLike(event.target)) return;
    if (!recording) {
      const target = event.target;
      syncRecordingState(() => recordInput(target, "change"));
      return;
    }
    clearTimeout(inputTimers.get(event.target));
    recordInput(event.target, "change");
  });

  addCaptureListener("submit", (event) => {
    if (!takeEvent(event) || !recording || replaying) return;
    const meta = selectorMeta(event.target);
    send({ kind: "submit", element: meta });
  });

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

  function clampScrollTarget(x, y) {
    const maxX = Math.max(
      0,
      document.documentElement.scrollWidth,
      document.body?.scrollWidth || 0,
    ) - window.innerWidth;
    const maxY = Math.max(
      0,
      document.documentElement.scrollHeight,
      document.body?.scrollHeight || 0,
    ) - window.innerHeight;
    return {
      x: Math.max(0, Math.min(Number(x) || 0, maxX)),
      y: Math.max(0, Math.min(Number(y) || 0, maxY)),
    };
  }

  function smoothScrollTo(x, y) {
    const target = clampScrollTarget(x, y);
    const startX = window.scrollX;
    const startY = window.scrollY;
    const deltaX = target.x - startX;
    const deltaY = target.y - startY;
    const distance = Math.hypot(deltaX, deltaY);
    if (distance < 1) return Promise.resolve();
    const duration = Math.max(260, Math.min(900, distance * 0.55));
    const startedAt = performance.now();
    return new Promise((resolve) => {
      function tick(nowTime) {
        const progress = Math.min(1, (nowTime - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        window.scrollTo(startX + deltaX * eased, startY + deltaY * eased);
        if (progress < 1) requestAnimationFrame(tick);
        else resolve();
      }
      requestAnimationFrame(tick);
    });
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

  function selectorForSortableEvent(event) {
    const selectors = event?.sortable?.rowElement?.selectors || [];
    return (
      selectors.find((item) => item.unique)?.selector ||
      event?.sortable?.rowElement?.preferredSelector ||
      ""
    );
  }

  function eventTime(event) {
    const time = Date.parse(event?.at || "");
    return Number.isFinite(time) ? time : null;
  }

  function closeNumber(a, b, tolerance = 6) {
    const left = Number(a);
    const right = Number(b);
    if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
    return Math.abs(left - right) <= tolerance;
  }

  function sameSortableMove(a, b) {
    if (!a?.sortable || !b?.sortable) return false;
    if (
      a.sortable.sourceLabel ||
      b.sortable.sourceLabel ||
      a.sortable.rowElement ||
      b.sortable.rowElement
    ) {
      const sameSourceLabel =
        String(a.sortable.sourceLabel || "") === String(b.sortable.sourceLabel || "");
      const sameRowSelector =
        selectorForEvent(a) &&
        selectorForEvent(a) === selectorForEvent(b);
      if (sameSourceLabel || sameRowSelector) return true;
    }
    return (
      String(a.sortable.sourceLabel || "") === String(b.sortable.sourceLabel || "") &&
      Number(a.sortable.fromIndex) === Number(b.sortable.fromIndex) &&
      Number(a.sortable.toIndex) === Number(b.sortable.toIndex) &&
      Number(a.sortable.moveDelta) === Number(b.sortable.moveDelta)
    );
  }

  function sameDragGeometry(a, b) {
    return (
      closeNumber(a?.startX, b?.startX) &&
      closeNumber(a?.startY, b?.startY) &&
      closeNumber(a?.endX, b?.endX) &&
      closeNumber(a?.endY, b?.endY)
    );
  }

  function isDuplicateDragEvent(previous, next) {
    if (previous?.kind !== "drag" || next?.kind !== "drag") return false;
    const previousAt = eventTime(previous);
    const nextAt = eventTime(next);
    if (
      previousAt !== null &&
      nextAt !== null &&
      Math.abs(nextAt - previousAt) > 900
    ) {
      return false;
    }
    return sameSortableMove(previous, next) || sameDragGeometry(previous, next);
  }

  function isDuplicateClickEvent(previous, next) {
    if (previous?.kind !== "click" || next?.kind !== "click") return false;
    const previousAt = eventTime(previous);
    const nextAt = eventTime(next);
    if (
      previousAt !== null &&
      nextAt !== null &&
      Math.abs(nextAt - previousAt) > 350
    ) {
      return false;
    }
    return closeNumber(previous?.x, next?.x, 12) && closeNumber(previous?.y, next?.y, 12);
  }

  function findEventElement(event) {
    const selector = selectorForEvent(event);
    return selector ? deepQuerySelector(selector) : null;
  }

  function ensureReplayCursor() {
    if (replayCursor) return replayCursor;
    replayCursor = document.createElement("div");
    replayCursor.setAttribute("data-tabworks-replay-cursor", "true");
    const cursorAssetUrl = chrome.runtime.getURL("images/replay-cursor.svg");
    replayCursor.innerHTML = `
      <div class="tw-replay-cursor-sprite-wrap">
        <img class="tw-replay-cursor-asset" alt="" draggable="false" src="${cursorAssetUrl}">
      </div>
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
  transform-origin: 12px 12px;
  transition: transform 180ms cubic-bezier(.2,.8,.2,1), opacity 120ms ease;
  opacity: 0;
}
[data-tabworks-replay-cursor] .tw-replay-cursor-sprite-wrap {
  transform: translate3d(10px, 8px, 0);
}
[data-tabworks-replay-cursor] .tw-replay-cursor-asset {
  display: block;
  width: 23px;
  height: 24px;
  transform: rotate(0deg) scale(1);
  transform-origin: 0 0;
  filter:
    drop-shadow(0 0 6px rgba(51, 156, 255, .9))
    drop-shadow(0 0 15px rgba(51, 156, 255, .48));
  -webkit-user-drag: none;
  user-select: none;
}
[data-tabworks-replay-cursor] .tw-replay-cursor-ring {
  position: absolute;
  left: 3px;
  top: 3px;
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

  async function moveLocalReplayCursor(point, _options = {}) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    const cursor = ensureReplayCursor();
    const from = replayCursorPoint || point;
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const duration = Math.max(120, Math.min(480, distance * 1.2));
    cursor.style.transitionDuration = `${Math.round(duration)}ms, 120ms`;
    cursor.style.opacity = "1";
    cursor.classList.remove("click");
    cursor.style.transform = `translate3d(${Math.round(point.x - 12)}px, ${Math.round(point.y - 12)}px, 0)`;
    replayCursorPoint = point;
    await wait(duration);
  }

  function pulseLocalReplayCursor(point) {
    const cursor = ensureReplayCursor();
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      cursor.style.transitionDuration = "0ms, 120ms";
      cursor.style.opacity = "1";
      cursor.style.transform = `translate3d(${Math.round(point.x - 12)}px, ${Math.round(point.y - 12)}px, 0)`;
      replayCursorPoint = point;
    }
    cursor.classList.remove("click");
    void cursor.offsetWidth;
    cursor.classList.add("click");
    setTimeout(() => cursor.classList.remove("click"), 280);
  }

  function hideLocalReplayCursor() {
    if (!replayCursor) return;
    replayCursor.style.opacity = "0";
    replayCursor.style.transform = "translate3d(-40px, -40px, 0)";
    replayCursor.classList.remove("click");
    replayCursorPoint = null;
  }

  async function moveReplayCursor(point, options = {}) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    if (isTopFrame()) {
      await moveLocalReplayCursor(point, options);
      return;
    }
    await sendReplayCursorRequestToParent({
      action: "move",
      point,
      options,
    });
  }

  async function pulseReplayCursor(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    if (isTopFrame()) {
      pulseLocalReplayCursor(point);
      return;
    }
    await sendReplayCursorRequestToParent(
      {
        action: "pulse",
        point,
      },
      180,
    );
  }

  async function hideReplayCursor() {
    if (isTopFrame()) {
      hideLocalReplayCursor();
      return;
    }
    await sendReplayCursorRequestToParent({
      action: "hide",
      point: replayCursorPoint || { x: -40, y: -40 },
    });
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
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent(type, init));
      return;
    }
    const mouseType = type.replace(/^pointer/, "mouse");
    if (mouseType !== type) el.dispatchEvent(new MouseEvent(mouseType, init));
  }

  function dispatchMouseLike(el, type, point, options = {}) {
    el.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        detail: options.detail ?? 1,
        clientX: point.x,
        clientY: point.y,
        button: options.button ?? 0,
        buttons: options.buttons ?? 0,
        ctrlKey: Boolean(options.ctrlKey),
        metaKey: Boolean(options.metaKey),
        altKey: Boolean(options.altKey),
        shiftKey: Boolean(options.shiftKey),
      }),
    );
  }

  function topViewportPoint(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (isTopFrame()) return { x, y };
    const context = getFrameContext();
    const rect = context?.frameRect;
    if (
      rect &&
      Number.isFinite(Number(rect.x)) &&
      Number.isFinite(Number(rect.y))
    ) {
      return {
        x: Math.round(Number(rect.x) + x),
        y: Math.round(Number(rect.y) + y),
      };
    }
    return { x, y };
  }

  function trustedReplayClick(point) {
    const topPoint = topViewportPoint(point);
    if (!topPoint) return Promise.resolve({ ok: false, error: "invalid point" });
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "tabworks-recording-trusted-click",
          x: topPoint.x,
          y: topPoint.y,
        },
        (response) => {
          const err = chrome.runtime.lastError;
          if (err) {
            resolve({ ok: false, error: err.message });
            return;
          }
          resolve(response || { ok: false, error: "empty response" });
        },
      );
    });
  }

  function isVisibleElement(el) {
    if (!el?.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      !el.closest?.(".ant-select-dropdown-hidden")
    );
  }

  function findAntCascaderClickTarget(event) {
    const meta = event?.antCascader;
    if (!meta?.clickedCheckbox) return null;
    const candidates = [
      meta.checkboxSelector ? deepQuerySelector(meta.checkboxSelector) : null,
      meta.itemSelector ? deepQuerySelector(meta.itemSelector) : null,
    ].filter(Boolean).filter(isVisibleElement);
    const menus = Array.from(
      document.querySelectorAll(".ant-cascader-menu-item"),
    ).filter(isVisibleElement);
    if (meta.itemText) {
      const matched = menus.find((item) => {
        const content =
          item.querySelector(".ant-cascader-menu-item-content") || item;
        return cleanLabel(content.innerText || content.textContent || "") === meta.itemText;
      });
      if (matched) candidates.unshift(matched);
    }

    for (const candidate of candidates) {
      const checkbox =
        candidate.matches?.(".ant-cascader-checkbox-inner, .ant-cascader-checkbox")
          ? candidate
          : candidate.querySelector?.(".ant-cascader-checkbox-inner") ||
            candidate.querySelector?.(".ant-cascader-checkbox");
      if (checkbox && isVisibleElement(checkbox)) {
        return { el: checkbox, mode: "ant-cascader-checkbox" };
      }
    }
    return null;
  }

  async function waitForAntCascaderClickTarget(event, timeoutMs = 1200) {
    const startedAt = performance.now();
    let target = findAntCascaderClickTarget(event);
    while (!target && performance.now() - startedAt < timeoutMs) {
      await wait(50);
      target = findAntCascaderClickTarget(event);
    }
    return target;
  }

  function findAntSelectRemoveTarget(event) {
    const meta = event?.antSelectRemove;
    if (!meta?.itemText) return null;
    const directRemove = meta.removeSelector ? deepQuerySelector(meta.removeSelector) : null;
    if (directRemove && isVisibleElement(directRemove)) {
      return { el: directRemove, mode: "ant-select-remove" };
    }
    const items = Array.from(
      document.querySelectorAll(".ant-select-selection-item"),
    ).filter(isVisibleElement);
    const matched = items.find((item) => {
      const content =
        item.querySelector(".ant-select-selection-item-content") || item;
      return cleanLabel(content.innerText || content.textContent || "") === meta.itemText;
    });
    const remove = matched?.querySelector?.(".ant-select-selection-item-remove");
    if (remove && isVisibleElement(remove)) {
      return { el: remove, mode: "ant-select-remove" };
    }
    return null;
  }

  async function waitForAntSelectRemoveTarget(event, timeoutMs = 800) {
    const startedAt = performance.now();
    let target = findAntSelectRemoveTarget(event);
    while (!target && performance.now() - startedAt < timeoutMs) {
      await wait(50);
      target = findAntSelectRemoveTarget(event);
    }
    return target;
  }

  function replayClickTarget(el) {
    const antSelect = el?.closest?.(".ant-select, .ant-cascader");
    const selector = antSelect?.querySelector?.(".ant-select-selector");
    if (selector) {
      return {
        el: selector,
        mode: antSelect.matches(".ant-cascader") ? "ant-cascader" : "ant-select",
      };
    }
    return {
      el:
      el?.closest?.(
        "button,a,label,input,textarea,select,[role='button'],[role='option'],[role='menuitem'],[role='menuitemcheckbox'],.ant-cascader-menu-item,.ant-select-item-option",
      ) || el,
      mode: "default",
    };
  }

  function dispatchReplayClick(target, point, event = {}) {
    const el = target?.el || target;
    const mode = target?.mode || "default";
    const button = Number.isInteger(event.button) ? event.button : 0;
    dispatchPointerLike(el, "pointermove", point, {
      buttons: 0,
      pointerType: event.pointerType,
    });
    dispatchMouseLike(el, "mousemove", point, { button, buttons: 0 });
    dispatchPointerLike(el, "pointerdown", point, {
      button,
      buttons: button === 0 ? 1 : 2,
      pointerType: event.pointerType,
    });
    dispatchMouseLike(el, "mousedown", point, {
      button,
      buttons: button === 0 ? 1 : 2,
    });
    if (button === 0 && typeof el.focus === "function") {
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    }
    dispatchPointerLike(el, "pointerup", point, {
      button,
      buttons: 0,
      pointerType: event.pointerType,
    });
    dispatchMouseLike(el, "mouseup", point, { button, buttons: 0 });
    if (mode === "ant-select" || mode === "ant-cascader") {
      return;
    }
    if (button === 0 && typeof el.click === "function") {
      el.click();
    } else {
      dispatchMouseLike(el, "click", point, { button, buttons: 0 });
    }
  }

  function centerOf(el) {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  }

  function pointForReplayClick(el, event) {
    const rect = el.getBoundingClientRect();
    const offsetX = Number(event?.offsetX);
    const offsetY = Number(event?.offsetY);
    const recordedWidth = Number(event?.elementWidth);
    const recordedHeight = Number(event?.elementHeight);
    if (Number.isFinite(offsetX) && Number.isFinite(offsetY)) {
      const scaleX =
        Number.isFinite(recordedWidth) && recordedWidth > 0
          ? rect.width / recordedWidth
          : 1;
      const scaleY =
        Number.isFinite(recordedHeight) && recordedHeight > 0
          ? rect.height / recordedHeight
          : 1;
      return {
        x: Math.round(rect.left + offsetX * scaleX),
        y: Math.round(rect.top + offsetY * scaleY),
      };
    }
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
      await pulseReplayCursor(start);
      dispatchPointerLike(el, "pointerup", start, { buttons: 0, pointerType: event.pointerType });
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
      let target =
        (await waitForAntSelectRemoveTarget(event)) ||
        (await waitForAntCascaderClickTarget(event));
      const el = target ? target.el : findEventElement(event);
      if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
      if (typeof el.scrollIntoView === "function") {
        el.scrollIntoView({ block: "center", inline: "center" });
      }
      await wait(80);
      target = target || replayClickTarget(el);
      const point =
        target.mode === "ant-cascader-checkbox" ||
        target.mode === "ant-select-remove"
          ? centerOf(target.el)
          : pointForReplayClick(target.el, event);
      await moveReplayCursor(point);
      await pulseReplayCursor(point);
      if (
        target.mode === "ant-select" ||
        target.mode === "ant-cascader" ||
        target.mode === "ant-cascader-checkbox" ||
        target.mode === "ant-select-remove"
      ) {
        const trusted = await trustedReplayClick(point);
        if (trusted?.ok !== false) {
          return { ok: true, kind: event.kind, selector, trustedClick: true };
        }
      }
      dispatchReplayClick(target, point, event);
      return { ok: true, kind: event.kind, selector };
    }

    if (event.kind === "double-click" || event.kind === "context-menu") {
      const selector = selectorForEvent(event);
      const el = findEventElement(event);
      if (!el) return { ok: false, kind: event.kind, selector, error: "元素未找到" };
      el.scrollIntoView({ block: "center", inline: "center" });
      await wait(80);
      const target = replayClickTarget(el);
      const point = centerOf(target.el);
      await moveReplayCursor(point);
      const type = event.kind === "double-click" ? "dblclick" : "contextmenu";
      await pulseReplayCursor(point);
      target.el.dispatchEvent(new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
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
      const target = replayClickTarget(el);
      const point = centerOf(target.el);
      await moveReplayCursor(point);
      await pulseReplayCursor(point);
      if (typeof target.el.focus === "function") target.el.focus();
      else if (typeof el.focus === "function") el.focus();
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
      await smoothScrollTo(event.scrollX || 0, event.scrollY || 0);
      return { ok: true, kind: event.kind };
    }

    if (event.kind === "submit") {
      const selector = selectorForEvent(event);
      const el = findEventElement(event);
      if (!el) return { ok: false, kind: event.kind, selector, error: "表单未找到" };
      el.scrollIntoView({ block: "center", inline: "center" });
      await wait(80);
      const point = centerOf(el);
      await moveReplayCursor(point);
      await pulseReplayCursor(point);
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
        normalized
          .slice(-8)
          .some(
            (item) =>
              isDuplicateDragEvent(item, event) ||
              isDuplicateClickEvent(item, event),
          )
      ) {
        continue;
      }
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
      if (options.hideCursorOnComplete !== false) {
        await hideReplayCursor();
      }
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
      if (!recording || recording.sessionId !== message.sessionId) {
        startRecordingSession(message.sessionId);
      }
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
