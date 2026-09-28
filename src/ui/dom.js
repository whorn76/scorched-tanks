// Tiny DOM helpers. Text always goes in through textContent / text nodes, never innerHTML, so
// names and chat from other players can't inject markup.

/**
 * h('button', { class: 'big', onclick: fn, text: 'Go' }, child, 'more text')
 * Props: class, text, style (object), dataset (object), on* listeners, anything else becomes
 * an attribute (true → present, false/null → absent).
 */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = String(value);
    else if (key === 'style') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key === 'value') el.value = value;
    else if (key === 'checked') el.checked = !!value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else if (child instanceof Node) el.append(child);
    else el.append(document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

/** A <select> from [value, label] pairs. */
export function select(options, current, onchange, props = {}) {
  const el = h('select', { ...props, onchange: (e) => onchange(e.target.value, e) });
  for (const [value, label] of options) {
    const opt = h('option', { value: String(value), text: label });
    if (String(value) === String(current)) opt.selected = true;
    el.append(opt);
  }
  return el;
}

export const money = (n) => `$${Math.floor(n).toLocaleString('en-US')}`;
