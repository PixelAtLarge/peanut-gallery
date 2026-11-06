// All colours and fonts come from theme CSS variables (see @peanut-gallery/core theme.ts).
export const css = `
:host { all: initial; }
* { box-sizing: border-box; font-family: var(--pg-font-body); font-size: 13px; line-height: 1.4; color: var(--pg-text); }
.pg-hidden { display: none !important; }

.pg-toolbar {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  display: flex; align-items: center; gap: 6px;
  background: var(--pg-toolbar); border-radius: 999px; padding: 6px 8px 6px 14px;
  box-shadow: 0 10px 28px rgba(21, 42, 74, .28); user-select: none;
}
.pg-toolbar .pg-brand { font-weight: 700; color: var(--pg-on-toolbar); margin-right: 4px; letter-spacing: .01em; }
.pg-btn {
  appearance: none; border: 0; cursor: pointer; border-radius: 999px; padding: 6px 12px;
  background: var(--pg-toolbar-button); color: var(--pg-on-toolbar); font-weight: 600;
}
.pg-btn:hover { background: var(--pg-toolbar-button-hover); }
.pg-btn.pg-primary { background: var(--pg-primary); color: var(--pg-on-primary); }
.pg-btn.pg-primary:hover { background: var(--pg-primary-hover); }
.pg-btn.pg-active, .pg-btn.pg-active:hover { background: var(--pg-accent); color: var(--pg-on-accent); }
.pg-btn:disabled { opacity: .5; cursor: default; }
.pg-btn:focus-visible, .pg-pin:focus-visible { outline: 2px solid var(--pg-accent); outline-offset: 2px; }
.pg-count { background: var(--pg-count); color: var(--pg-on-count); border-radius: 999px; padding: 1px 7px; font-weight: 700; margin-left: 6px; }

.pg-highlight {
  position: absolute; z-index: 2147482000; pointer-events: none;
  outline: 2px solid var(--pg-highlight); outline-offset: 2px; background: var(--pg-highlight-tint); border-radius: 3px;
}
.pg-tag {
  position: absolute; top: -23px; left: -2px; background: var(--pg-highlight); color: var(--pg-on-primary); font-size: 11px;
  padding: 2px 6px; border-radius: 4px; white-space: nowrap; font-family: var(--pg-font-mono);
}

.pg-pin {
  position: absolute; z-index: 2147482500; width: 24px; height: 24px; margin: -12px 0 0 -12px;
  border-radius: 999px 999px 999px 2px; background: var(--pg-accent); color: var(--pg-on-accent); font-weight: 700; font-size: 12px;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  box-shadow: 0 2px 8px rgba(21, 42, 74, .35); border: 2px solid var(--pg-surface);
}
.pg-pin.pg-low { background: var(--pg-pin-low); }
.pg-pin:hover { transform: scale(1.1); }

.pg-composer, .pg-panel {
  position: absolute; z-index: 2147483100; background: var(--pg-surface); border-radius: 12px;
  border: 1px solid var(--pg-line); box-shadow: 0 14px 40px rgba(21, 42, 74, .22); padding: 12px; width: 300px;
}
.pg-composer textarea {
  width: 100%; min-height: 80px; resize: vertical; border: 1px solid var(--pg-line); border-radius: 8px; padding: 8px;
  font-size: 13px; background: var(--pg-surface);
}
.pg-composer textarea:focus { outline: 2px solid var(--pg-primary); border-color: transparent; }
.pg-row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
.pg-row .pg-spacer { flex: 1; }
.pg-composer select { border: 1px solid var(--pg-line); border-radius: 8px; padding: 5px 6px; background: var(--pg-surface); }
.pg-meta { color: var(--pg-muted); font-size: 11px; margin-bottom: 6px; font-family: var(--pg-font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-btn.pg-ghost { background: var(--pg-ghost); color: var(--pg-text); }
.pg-btn.pg-ghost:hover { background: var(--pg-ghost-hover); }
.pg-btn.pg-danger { background: var(--pg-danger); color: var(--pg-on-danger); }

.pg-panel { position: fixed; right: 16px; bottom: 64px; width: 340px; max-height: 70vh; overflow: auto; }
.pg-panel h3 { margin: 0 0 8px; font-family: var(--pg-font-display); font-weight: 400; font-size: 18px; color: var(--pg-heading); }
.pg-item { border-top: 1px solid var(--pg-line); padding: 8px 0; }
.pg-item .pg-text { white-space: pre-wrap; }
.pg-item .pg-meta { margin: 2px 0 0; }
.pg-item .pg-kind { display: inline-block; background: var(--pg-chip); color: var(--pg-on-chip); border-radius: 4px; padding: 0 5px; font-size: 11px; font-weight: 600; margin-right: 4px; }
.pg-empty { color: var(--pg-muted); padding: 12px 0; }
.pg-link { color: var(--pg-link); }
.pg-toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); background: var(--pg-toast); color: var(--pg-on-toast); padding: 8px 14px; border-radius: 999px; z-index: 2147483200; font-weight: 500; }
`;
