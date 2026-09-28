// The chat box for online games: recent lines fade out, T (or the chat button) opens the input.
// Everything is inserted as text, never HTML.
import { h } from './dom.js';

const KEEP = 60;
const FADE_MS = 9000;

export class ChatBox {
  constructor(root) {
    this.root = root;
    this.log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
    this.input = h('input', { class: 'chat-input', maxlength: 200, placeholder: 'Say something… (Enter to send, Esc to close)', 'aria-label': 'Chat message' });
    this.form = h('form', {
      class: 'chat-form',
      onsubmit: (e) => {
        e.preventDefault();
        const text = this.input.value.trim();
        if (text) this.sendHandler?.(text);
        this.input.value = '';
        if (!this.pinned) this.close();
      },
    }, this.input);
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.input.value = '';
        if (!this.pinned) this.close();
        this.input.blur();
      }
      e.stopPropagation();
    });
    root.replaceChildren(this.log, this.form);
    this.isOpen = false;
    this.pinned = false;
    this.visible = false;
    this.timer = setInterval(() => this.fade(), 1000);
    this.close();
  }

  onSend(fn) {
    this.sendHandler = fn;
  }

  /** Shows the box (online games only). `pinned` keeps the input open (the lobby). */
  show(visible, pinned = false) {
    if (visible === this.visible && pinned === this.pinned) return;
    const wasPinned = this.pinned;
    this.visible = visible;
    this.pinned = pinned;
    this.root.hidden = !visible;
    this.root.classList.toggle('pinned', pinned);
    if (pinned) this.open(false);
    else if (!visible || wasPinned) {
      this.input.blur();
      this.close();
    }
  }

  open(focus = true) {
    if (!this.visible) return;
    this.isOpen = true;
    this.root.classList.add('open');
    this.form.hidden = false;
    if (focus) this.input.focus({ preventScroll: true });
    this.fade();
  }

  close() {
    this.isOpen = false;
    this.root.classList.remove('open');
    this.form.hidden = !this.pinned;
    this.fade();
  }

  clear() {
    this.log.replaceChildren();
  }

  add({ name = '', color = '#cccccc', text, system = false }) {
    const line = h('div', { class: `chat-line${system ? ' system' : ''}` });
    line.dataset.time = String(Date.now());
    if (!system && name) line.append(h('span', { class: 'chat-name', style: { color }, text: `${name}: ` }));
    line.append(h('span', { class: 'chat-text', text }));
    this.log.append(line);
    while (this.log.children.length > KEEP) this.log.firstChild.remove();
    this.log.scrollTop = this.log.scrollHeight;
    this.fade();
  }

  fade() {
    const now = Date.now();
    for (const line of this.log.children) {
      const old = now - Number(line.dataset.time) > FADE_MS;
      line.classList.toggle('faded', old && !this.isOpen && !this.pinned);
    }
  }
}
