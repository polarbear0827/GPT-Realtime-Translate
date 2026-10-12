// Small UI primitives: toasts, confirm dialog, popup menu.

const TOAST_TIMEOUT_MS = { info: 5000, success: 4000, warning: 9000, error: 0 };

export function createToaster(container) {
  const byKey = new Map();

  function show(level, message, { key, timeout = TOAST_TIMEOUT_MS[level] ?? 5000, actions = [] } = {}) {
    if (key && byKey.has(key)) byKey.get(key).close();
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.dataset.level = level;
    toast.setAttribute("role", level === "error" ? "alert" : "status");
    const text = document.createElement("p");
    text.textContent = message;
    toast.append(text);

    let timer = 0;
    const close = () => {
      clearTimeout(timer);
      toast.remove();
      if (key && byKey.get(key)?.toast === toast) byKey.delete(key);
    };
    for (const action of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = action.label;
      button.addEventListener("click", () => {
        close();
        action.onClick?.();
      });
      toast.append(button);
    }
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "ghost";
    dismiss.setAttribute("aria-label", "關閉通知");
    dismiss.textContent = "✕";
    dismiss.addEventListener("click", close);
    toast.append(dismiss);

    container.append(toast);
    while (container.children.length > 4) container.firstElementChild.remove();
    if (timeout > 0) timer = setTimeout(close, timeout);
    const handle = { toast, close };
    if (key) byKey.set(key, handle);
    return handle;
  }

  return {
    show,
    dismiss(key) {
      byKey.get(key)?.close();
    },
  };
}

export function confirmDialog(dialog, message, { okText = "確定", cancelText = "取消" } = {}) {
  if (typeof dialog.showModal !== "function") return Promise.resolve(window.confirm(message));
  dialog.querySelector("#confirmMessage").textContent = message;
  dialog.querySelector("#confirmOkBtn").textContent = okText;
  dialog.querySelector("#confirmCancelBtn").textContent = cancelText;
  dialog.returnValue = "cancel";
  dialog.showModal();
  dialog.querySelector("#confirmCancelBtn").focus();
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue === "ok"), { once: true });
  });
}

export function bindMenu(button, menu, onSelect) {
  const items = () => [...menu.querySelectorAll("button:not(:disabled)")];
  const setOpen = (open) => {
    menu.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    if (open) items()[0]?.focus();
  };
  button.addEventListener("click", () => setOpen(menu.hidden));
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("button[data-export]");
    if (!item || item.disabled) return;
    setOpen(false);
    button.focus();
    onSelect(item.dataset.export);
  });
  menu.addEventListener("keydown", (event) => {
    const list = items();
    const index = list.indexOf(document.activeElement);
    if (event.key === "ArrowDown") list[(index + 1) % list.length]?.focus();
    else if (event.key === "ArrowUp") list[(index - 1 + list.length) % list.length]?.focus();
    else if (event.key === "Escape") {
      setOpen(false);
      button.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!menu.hidden && !menu.contains(event.target) && event.target !== button) setOpen(false);
  });
  return { close: () => setOpen(false), get isOpen() { return !menu.hidden; } };
}
