/**
 * Where an element comes from in the code, read from the framework in the running app:
 * React (dev builds), Vue (dev builds), Svelte (dev builds), or `data-source`-style attributes
 * that build plugins add. Production builds strip this, so it's often absent: the CLI then
 * searches the code instead.
 */
export interface SourceHint {
  framework: 'react' | 'vue' | 'svelte' | 'attribute';
  /** Components from the element outwards, e.g. ["CartRow", "Cart"]. At most 4. */
  components: string[];
  /** File that renders the element, relative to the project (e.g. "src/pages/Cart.jsx"). */
  file?: string;
  line?: number;
}

const MAX_COMPONENTS = 4;
/** Folders a project path usually starts at; anything before them is the developer's machine. */
const ROOTS = ['src', 'app', 'pages', 'components', 'lib', 'routes', 'views', 'packages', 'apps', 'examples', 'resources', 'templates'];
/** Components that wrap everything and say nothing about where an element is. */
const WRAPPERS = /^(App|Root|Layout|Provider|.*Provider|.*Context|Router|BrowserRouter|HashRouter|MemoryRouter|Routes|Route|Outlet|RouterProvider|DataRoutes|RenderErrorBoundary|RenderedRoute|Location|Navigation|Await|StrictMode|Suspense|Fragment|ErrorBoundary|Transition|TransitionGroup|Portal|Slot|Anonymous|HotReload|ReactDevOverlay|AppRouter|InnerLayoutRouter|OuterLayoutRouter|ScrollAndFocusHandler|RedirectBoundary|NotFoundBoundary|LoadingBoundary|TemplateContext)$/;

/** A component name as plain identifier characters, or null. */
export const cleanName = (n: unknown): string | null => {
  if (typeof n !== 'string') return null;
  const s = n.replace(/[^\w$.]/g, '').slice(0, 40);
  return s && /^[A-Z_$]/.test(s) ? s : null;
};

/**
 * A path as the project sees it: no origin, query, `/@fs`, or the developer's home folder.
 * "http://localhost:5173/src/pages/Cart.jsx?t=1" → "src/pages/Cart.jsx";
 * "/Users/anna/shop/src/App.vue" → "src/App.vue".
 */
export function toProjectPath(raw: string): string | null {
  let p = raw.trim();
  if (!p) return null;
  try {
    if (/^(https?|file|webpack|vite):/i.test(p)) p = decodeURIComponent(new URL(p).pathname);
  } catch {
    /* not a URL */
  }
  p = p.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/^\/@fs(?=\/)/, '').replace(/^webpack:\/\/[^/]*\//, '');
  if (/(^|\/)(node_modules|\.vite|\.next\/static|@vite|@react-refresh)\//.test(p) || /\/(deps|chunk-)[^/]*\.js$/.test(p)) return null;
  const parts = p.split('/').filter((s) => s && s !== '.');
  // Cut at the first project root folder ("/Users/anna/shop/src/pages/Cart.jsx" → "src/pages/Cart.jsx").
  // If that keeps too much, the CLI matches the end of the path against the repo's files.
  let cut = -1;
  for (let i = parts.length - 2; i >= 0; i--) if (ROOTS.includes(parts[i])) cut = i;
  const kept = cut >= 0 ? parts.slice(cut) : p.startsWith('/') ? parts.slice(-1) : parts;
  const out = kept.join('/');
  return /\.[a-z0-9]+$/i.test(out) ? out.slice(0, 200) : null;
}

type Fiber = {
  type?: unknown;
  return?: Fiber | null;
  _debugSource?: { fileName?: string; lineNumber?: number };
  _debugStack?: { stack?: string } | string;
  _debugOwner?: Fiber | null;
};

const fiberName = (f: Fiber): string | null => {
  const t = f.type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: { displayName?: string; name?: string } } | string | undefined;
  if (!t || typeof t === 'string') return null;
  return cleanName(t.displayName ?? t.name ?? t.render?.displayName ?? t.render?.name ?? t.type?.displayName ?? t.type?.name);
};

/** First frame in a stack that's the app's own code: where the JSX was written. */
function frameFromStack(stack: string): { file: string; line?: number } | null {
  for (const m of stack.matchAll(/((?:https?|file):\/\/[^\s)]+?|\/[^\s():]+?\.[a-z]+[^\s():]*?):(\d+):(\d+)/gi)) {
    const file = toProjectPath(m[1]);
    if (file) return { file, line: Number(m[2]) };
  }
  return null;
}

function fromReact(el: Element): SourceHint | null {
  let node: Element | null = el;
  let fiber: Fiber | undefined;
  while (node && !fiber) {
    const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'));
    if (key) fiber = (node as unknown as Record<string, Fiber>)[key];
    else node = node.parentElement;
  }
  if (!fiber) return null;
  const components: string[] = [];
  let file: string | undefined;
  let line: number | undefined;
  for (let f: Fiber | null | undefined = fiber, i = 0; f && i < 200; f = f.return, i++) {
    // React ≤ 18: _debugSource on the element's fiber. React 19: a stack of where the JSX was created.
    if (!file && f._debugSource?.fileName) {
      file = toProjectPath(f._debugSource.fileName) ?? undefined;
      line = f._debugSource.lineNumber;
    }
    if (!file && f._debugStack) {
      // The stack's line numbers are in the code the dev server serves (with extra lines added),
      // not in the source file, so keep only the file. The CLI finds the line.
      const at = frameFromStack(typeof f._debugStack === 'string' ? f._debugStack : (f._debugStack.stack ?? ''));
      if (at) file = at.file;
    }
    const name = fiberName(f);
    if (name && !WRAPPERS.test(name) && !components.includes(name) && components.length < MAX_COMPONENTS) components.push(name);
  }
  return components.length || file ? { framework: 'react', components, ...(file ? { file } : {}), ...(file && line ? { line } : {}) } : null;
}

type VueInstance = { type?: { __file?: string; name?: string; __name?: string }; parent?: VueInstance | null };
type Vue2 = { $options?: { __file?: string; name?: string; _componentTag?: string }; $parent?: Vue2 | null };

function fromVue(el: Element): SourceHint | null {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const v3 = (node as unknown as { __vueParentComponent?: VueInstance }).__vueParentComponent;
    if (v3) {
      const components: string[] = [];
      let file: string | undefined;
      for (let c: VueInstance | null | undefined = v3, i = 0; c && i < 50; c = c.parent, i++) {
        if (!file && c.type?.__file) file = toProjectPath(c.type.__file) ?? undefined;
        const n = cleanName(c.type?.name ?? c.type?.__name ?? c.type?.__file?.split('/').pop()?.replace(/\.vue$/, ''));
        if (n && !WRAPPERS.test(n) && !components.includes(n) && components.length < MAX_COMPONENTS) components.push(n);
      }
      return { framework: 'vue', components, ...(file ? { file } : {}) };
    }
    const v2 = (node as unknown as { __vue__?: Vue2 }).__vue__;
    if (v2) {
      const components: string[] = [];
      let file: string | undefined;
      for (let c: Vue2 | null | undefined = v2, i = 0; c && i < 50; c = c.$parent, i++) {
        if (!file && c.$options?.__file) file = toProjectPath(c.$options.__file) ?? undefined;
        const n = cleanName(c.$options?.name ?? c.$options?._componentTag);
        if (n && !WRAPPERS.test(n) && !components.includes(n) && components.length < MAX_COMPONENTS) components.push(n);
      }
      return { framework: 'vue', components, ...(file ? { file } : {}) };
    }
  }
  return null;
}

function fromSvelte(el: Element): SourceHint | null {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const meta = (node as unknown as { __svelte_meta?: { loc?: { file?: string; line?: number } } }).__svelte_meta;
    const file = meta?.loc?.file ? toProjectPath(meta.loc.file) : null;
    if (file) {
      const n = cleanName(file.split('/').pop()!.replace(/\.svelte$/, ''));
      // Svelte lines are 0-based.
      return { framework: 'svelte', components: n ? [n] : [], file, ...(typeof meta!.loc!.line === 'number' ? { line: meta!.loc!.line + 1 } : {}) };
    }
  }
  return null;
}

const ATTRS = ['data-source', 'data-source-file', 'data-inspector-relative-path', 'data-pg-source', 'data-loc'];

function fromAttributes(el: Element): SourceHint | null {
  const node = el.closest(ATTRS.map((a) => `[${a}]`).join(','));
  if (!node) return null;
  const raw = ATTRS.map((a) => node.getAttribute(a)).find(Boolean)!;
  // "src/x.jsx:12:4", or a path with the line in its own attribute (react-dev-inspector).
  const m = /^(.*?)(?::(\d+))?(?::\d+)?$/.exec(raw)!;
  const file = toProjectPath(m[1]);
  if (!file) return null;
  const line = Number(m[2] ?? node.getAttribute('data-inspector-line') ?? NaN);
  const name = cleanName(node.getAttribute('data-component') ?? node.getAttribute('data-component-name'));
  return { framework: 'attribute', components: name ? [name] : [], file, ...(Number.isFinite(line) && line > 0 ? { line } : {}) };
}

/** Where the element comes from in the code, if the running app can tell. Never throws. */
export function sourceHint(el: Element): SourceHint | null {
  for (const read of [fromAttributes, fromReact, fromVue, fromSvelte]) {
    try {
      const h = read(el);
      if (h) return h;
    } catch {
      /* an unusual app shape: try the next way */
    }
  }
  return null;
}

/** "CartRow in src/pages/Cart.jsx:27" for issues and logs. */
export function sourceLabel(h: SourceHint | undefined): string {
  if (!h) return '';
  const where = h.file ? `\`${h.file}${h.line ? `:${h.line}` : ''}\`` : '';
  const who = h.components.length ? h.components.map((c) => `\`${c}\``).join(' › ') : '';
  return who && where ? `${who} in ${where}` : who || where;
}
