export const css = `
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; font-size: 13px; line-height: 1.4; color: #111; }
.pg-hidden { display: none !important; }

.pg-toolbar {
  position: fixed; right: 16px; bottom: 16px; z-index: 2147483000;
  display: flex; align-items: center; gap: 6px;
  background: #111; color: #fff; border-radius: 999px; padding: 6px 8px 6px 12px;
  box-shadow: 0 8px 24px rgba(0,0,0,.25); user-select: none;
}
.pg-toolbar .pg-brand { font-weight: 600; color: #fff; margin-right: 4px; letter-spacing: .01em; }
.pg-btn {
  appearance: none; border: 0; cursor: pointer; border-radius: 999px; padding: 6px 12px;
  background: #2a2a2a; color: #fff; font-weight: 500;
}
.pg-btn:hover { background: #3a3a3a; }
.pg-btn.pg-primary { background: #4f6df5; }
.pg-btn.pg-primary:hover { background: #3f5ce0; }
.pg-btn.pg-active { background: #f5b64f; color: #111; }
.pg-btn:disabled { opacity: .5; cursor: default; }
.pg-count { background: #fff; color: #111; border-radius: 999px; padding: 1px 7px; font-weight: 700; margin-left: 4px; }

.pg-highlight {
  position: absolute; z-index: 2147482000; pointer-events: none;
  outline: 2px solid #4f6df5; outline-offset: 2px; background: rgba(79,109,245,.08); border-radius: 3px;
}
.pg-tag {
  position: absolute; top: -22px; left: -2px; background: #4f6df5; color: #fff; font-size: 11px;
  padding: 2px 6px; border-radius: 4px; white-space: nowrap; font-family: ui-monospace, monospace;
}

.pg-pin {
  position: absolute; z-index: 2147482500; width: 24px; height: 24px; margin: -12px 0 0 -12px;
  border-radius: 999px 999px 999px 2px; background: #f5b64f; color: #111; font-weight: 700; font-size: 12px;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  box-shadow: 0 2px 8px rgba(0,0,0,.3); border: 2px solid #fff;
}
.pg-pin.pg-low { background: #ddd; }
.pg-pin:hover { transform: scale(1.1); }

.pg-composer, .pg-panel {
  position: absolute; z-index: 2147483100; background: #fff; border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,.25); padding: 12px; width: 300px;
}
.pg-composer textarea {
  width: 100%; min-height: 80px; resize: vertical; border: 1px solid #ccc; border-radius: 6px; padding: 8px; font-size: 13px;
}
.pg-composer textarea:focus { outline: 2px solid #4f6df5; border-color: transparent; }
.pg-row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
.pg-row .pg-spacer { flex: 1; }
.pg-composer select { border: 1px solid #ccc; border-radius: 6px; padding: 5px 6px; background: #fff; }
.pg-meta { color: #666; font-size: 11px; margin-bottom: 6px; font-family: ui-monospace, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-btn.pg-ghost { background: #eee; color: #111; }
.pg-btn.pg-ghost:hover { background: #e0e0e0; }
.pg-btn.pg-danger { background: #fde8e8; color: #b00020; }

.pg-panel { position: fixed; right: 16px; bottom: 64px; width: 340px; max-height: 70vh; overflow: auto; }
.pg-panel h3 { margin: 0 0 8px; font-size: 14px; }
.pg-item { border-top: 1px solid #eee; padding: 8px 0; }
.pg-item .pg-text { white-space: pre-wrap; }
.pg-item .pg-meta { margin: 2px 0 0; }
.pg-item .pg-kind { display: inline-block; background: #eef; color: #335; border-radius: 4px; padding: 0 5px; font-size: 11px; margin-right: 4px; }
.pg-empty { color: #666; padding: 12px 0; }
.pg-link { color: #4f6df5; }
.pg-toast { position: fixed; left: 50%; bottom: 72px; transform: translateX(-50%); background: #111; color: #fff; padding: 8px 14px; border-radius: 8px; z-index: 2147483200; }
`;
