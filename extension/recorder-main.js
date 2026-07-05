(() => {
  // extension/src/recorder-main.ts
  (() => {
    const MAIN_BRIDGE_VERSION = 4;
    globalThis.__tabworksRecorderMainBridgeVersion = MAIN_BRIDGE_VERSION;
    const CHANNEL = "__tabworksRecorderMainEvent";
    const ACK_CHANNEL = "__tabworksRecorderMainAck";
    const state = globalThis.__tabworksRecorderMainBridgeState || {};
    state.controller?.abort?.();
    state.controller = new AbortController;
    state.handledEvents = new WeakSet;
    state.acknowledged = new Set;
    state.eventSeq = 0;
    globalThis.__tabworksRecorderMainBridgeState = state;
    function cssEscape(value) {
      if (globalThis.CSS?.escape)
        return CSS.escape(value);
      return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    }
    function textOf(el) {
      return (el?.innerText || el?.textContent || "").trim().replace(/\s+/g, " ");
    }
    function cssPath(el, maxParts = 6) {
      const parts = [];
      let current = el;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < maxParts) {
        const tag = current.tagName.toLowerCase();
        if (current.id) {
          parts.unshift(`${tag}#${cssEscape(current.id)}`);
          break;
        }
        let part = tag;
        const className = String(current.className || "").split(/\s+/).filter(Boolean).slice(0, 2);
        if (className.length) {
          part += className.map((item) => `.${cssEscape(item)}`).join("");
        }
        const parent = current.parentElement;
        if (parent) {
          const sameTag = Array.from(parent.children).filter((child) => child.tagName === current.tagName);
          if (sameTag.length > 1)
            part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        current = parent;
      }
      return parts.join(" > ");
    }
    function selectorCount(selector) {
      try {
        return document.querySelectorAll(selector).length;
      } catch {
        return 0;
      }
    }
    function selectorCandidate(kind, selector) {
      if (!selector)
        return null;
      const count = selectorCount(selector);
      return { kind, selector, unique: count === 1, count };
    }
    function elementRole(el) {
      const explicit = el.getAttribute?.("role");
      if (explicit)
        return explicit;
      const tag = el.tagName?.toLowerCase();
      if (tag === "button")
        return "button";
      if (tag === "a")
        return "link";
      if (tag === "input" || tag === "textarea" || tag === "select")
        return "textbox";
      return null;
    }
    function selectorMeta(el) {
      if (!el || el.nodeType !== Node.ELEMENT_NODE)
        return null;
      const candidates = [];
      const testId = el.getAttribute("data-testid");
      const aria = el.getAttribute("aria-label");
      const name = el.getAttribute("name");
      const id = el.id;
      const role = elementRole(el);
      candidates.push(selectorCandidate("testid", testId ? `[data-testid="${cssEscape(testId)}"]` : ""));
      candidates.push(selectorCandidate("id", id ? `#${cssEscape(id)}` : ""));
      candidates.push(selectorCandidate("role-name", role && aria ? `[role="${cssEscape(role)}"][aria-label="${cssEscape(aria)}"]` : ""));
      candidates.push(selectorCandidate("name", name ? `[name="${cssEscape(name)}"]` : ""));
      candidates.push(selectorCandidate("css", cssPath(el)));
      const selectors = candidates.filter(Boolean);
      const preferred = selectors.find((item) => item.unique && item.kind !== "css") || selectors.find((item) => item.unique) || selectors[0] || null;
      return {
        tag: el.tagName?.toLowerCase(),
        role,
        text: textOf(el).slice(0, 120),
        ariaLabel: aria || "",
        selectors,
        preferredSelector: preferred?.selector || ""
      };
    }
    function targetElement(event) {
      const path = event.composedPath?.() || [];
      const raw = path.find((node) => node?.nodeType === Node.ELEMENT_NODE) || event.target?.parentElement || event.target;
      if (!raw || raw.nodeType !== Node.ELEMENT_NODE)
        return null;
      return raw.closest?.("button,a,input,textarea,select,[role],[data-testid],[contenteditable='true']") || raw;
    }
    function frameContext() {
      const context = {
        isTop: window.top === window,
        url: location.href,
        frameName: window.name || "",
        frameSelector: null,
        frameIndex: null,
        frameRect: null
      };
      if (context.isTop)
        return context;
      try {
        const frameEl = window.frameElement;
        if (!frameEl)
          return context;
        const ownerDocument = frameEl.ownerDocument;
        const frames = Array.from(ownerDocument.querySelectorAll("iframe,frame"));
        const rect = frameEl.getBoundingClientRect();
        context.frameName = frameEl.getAttribute("name") || context.frameName;
        context.frameSelector = cssPath(frameEl, 8);
        context.frameIndex = frames.indexOf(frameEl);
        context.frameRect = {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      } catch {}
      return context;
    }
    function takeEvent(event) {
      if (state.handledEvents.has(event))
        return false;
      state.handledEvents.add(event);
      return true;
    }
    function pointFromEvent(event) {
      if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
        return { x: Math.round(event.clientX), y: Math.round(event.clientY) };
      }
      const rect = event.target?.getBoundingClientRect?.();
      if (!rect)
        return { x: 0, y: 0 };
      return {
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2)
      };
    }
    function valueOf(target) {
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
        return target.type === "password" ? "" : target.value;
      }
      if (target?.isContentEditable)
        return target.textContent || "";
      return "";
    }
    function post(kind, event, extra = {}) {
      const point = pointFromEvent(event);
      const id = `main_${Date.now()}_${++state.eventSeq}`;
      const target = targetElement(event);
      const message = {
        [CHANNEL]: true,
        id,
        event: {
          kind,
          x: point.x,
          y: point.y,
          button: event.button,
          pointerId: event.pointerId,
          pointerType: event.pointerType || "mouse",
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          value: valueOf(event.target),
          element: selectorMeta(target),
          frameContext: frameContext(),
          inFrame: window.top !== window,
          url: location.href,
          title: document.title,
          ...extra
        }
      };
      window.postMessage(message, "*");
      if (window.parent && window.parent !== window) {
        setTimeout(() => {
          if (state.acknowledged.has(id)) {
            state.acknowledged.delete(id);
            return;
          }
          window.parent.postMessage({ ...message, fallbackToParent: true }, "*");
        }, 120);
      }
    }
    window.addEventListener("message", (event) => {
      const data = event.data;
      if (!data || data[ACK_CHANNEL] !== true || !data.id)
        return;
      state.acknowledged.add(data.id);
    }, { capture: true, signal: state.controller.signal });
    function addCaptureListener(type, handler) {
      window.addEventListener(type, handler, {
        capture: true,
        signal: state.controller.signal
      });
      document.addEventListener(type, handler, {
        capture: true,
        signal: state.controller.signal
      });
    }
    addCaptureListener("click", (event) => {
      if (takeEvent(event))
        post("click", event);
    });
    addCaptureListener("dblclick", (event) => {
      if (takeEvent(event))
        post("double-click", event);
    });
    addCaptureListener("contextmenu", (event) => {
      if (takeEvent(event))
        post("context-menu", event);
    });
    addCaptureListener("input", (event) => {
      if (takeEvent(event))
        post("input", event);
    });
    addCaptureListener("change", (event) => {
      if (takeEvent(event))
        post("change", event);
    });
  })();
})();
