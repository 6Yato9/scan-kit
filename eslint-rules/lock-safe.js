// eslint-rules/lock-safe.js
//
// Keeps App Lock from being bypassed by new code (it was, by individual call
// sites, in three review rounds running). Two rules, wired up in
// eslint.config.js and also enforced by __tests__/lock-safe-lint.test.ts, so
// both `pnpm lint` and `pnpm test` fail on a regression.
//
// Background: while the app is locked, the top screen is the /lock route.
//   - A native sheet presented then (share sheet, print dialog, Photos
//     permission prompt) appears ABOVE the lock: usable without unlocking.
//   - router.back() closes the TOP screen, i.e. the lock itself; replace()
//     swaps the lock out; push() presents a screen above it.
// Neither can happen from a tap (nothing is tappable while locked), only from
// code that runs after slow work: after an `await`, or in a `.then()`.
//
// lock-safe/native-presenter
//   Sharing.shareAsync, Print.printAsync, MediaLibrary.saveToLibraryAsync /
//   createAssetAsync, Share.share (however Share is imported) and
//   ActionSheetIOS share sheets may only be
//   called from the lock-aware helpers: lib/share.ts (shareFile, printFile)
//   and lib/photos.ts (savePagesToPhotos). Those await whenUnlocked()
//   (lib/nav-guard.ts) internally, so callers can't forget.
//
// lock-safe/navigation-after-await
//   router.back / replace / push / navigate / dismiss / dismissTo /
//   dismissAll may not run "late", i.e. when the app may have locked since
//   the tap that started the work:
//     - after an `await` in the same function (or inside a loop that awaits);
//     - inside a .then / .catch / .finally callback;
//     - inside any function CREATED after an await or in such a callback — a
//       setTimeout / requestAnimationFrame / listener callback, an inner helper;
//     - through a local function that navigates, called or handed on late
//       (`.then(done)`, `await x; done()`, `setTimeout(done)`), or the method
//       itself handed on (`.then(router.back)`).
//   The router is recognised through aliases and destructuring
//   (`const r = router`, `const { back } = useRouter()`, `const go = router.push`,
//   `import { router as r } from 'expo-router'`), as far as one file shows.
//   ActionSheetIOS.showActionSheetWithOptions is held to the same rule: its
//   buttons are not covered by the alert guard. Wrap navigation in:
//       navigateWhenUnlocked(() => router.replace(...));
//   which runs it at once when unlocked, otherwise after unlock once the lock
//   screen has gone. Not reported: JSX event handlers, `onPress`-style keys
//   in object literals (toast actions, Alert buttons — the alert guard holds
//   those) and navigateWhenUnlocked callbacks — those only run from a tap or
//   once unlocked.
//
// ALLOWING A DELIBERATE EXCEPTION
//   Put a disable comment on the line before, WITH a reason after `--`:
//       // eslint-disable-next-line lock-safe/navigation-after-await -- runs only while unlocked: <why>
//   A whole file that implements the lock itself is allowlisted in
//   eslint.config.js (LOCK_SAFE_ALLOWLIST); add a file there only if it IS
//   lock machinery, and say why in a comment.
'use strict';

const PRESENTER_METHODS = new Set([
  'shareAsync', // expo-sharing
  'printAsync', // expo-print (printToFileAsync renders off-screen and is fine)
  'saveToLibraryAsync', // expo-media-library
  'createAssetAsync', // expo-media-library
  'showShareActionSheetWithOptions', // ActionSheetIOS
]);
const PRESENTER_IMPORTS = {
  'expo-sharing': new Set(['shareAsync']),
  'expo-print': new Set(['printAsync']),
  'expo-media-library': new Set(['saveToLibraryAsync', 'createAssetAsync']),
};

const NAV_METHODS = new Set(['back', 'replace', 'push', 'navigate', 'dismiss', 'dismissTo', 'dismissAll']);
const NAV_OBJECTS = new Set(['router', 'navigation', 'nav']);
const PROMISE_CALLBACKS = new Set(['then', 'catch', 'finally']);

function propName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  if (!member.computed && member.property.type === 'Identifier') return member.property.name;
  if (member.computed && member.property.type === 'Literal') return String(member.property.value);
  return null;
}

const nativePresenter = {
  meta: {
    type: 'problem',
    docs: { description: 'Native share / print / Photos calls must go through the lock-aware helpers in lib/share.ts and lib/photos.ts.' },
    schema: [],
    messages: {
      call:
        '{{name}}() presents native UI and would open above the App Lock screen. Use shareFile / printFile (lib/share.ts) or savePagesToPhotos (lib/photos.ts), which wait until the app is unlocked.',
    },
  },
  create(context) {
    // Local names React Native's Share is imported under (`import { Share as RNShare }`).
    const shareNames = new Set(['Share']);
    return {
      ImportDeclaration(node) {
        if (node.source.value === 'react-native') {
          for (const spec of node.specifiers) {
            if (spec.type === 'ImportSpecifier' && spec.imported.name === 'Share') shareNames.add(spec.local.name);
          }
        }
        const banned = PRESENTER_IMPORTS[node.source.value];
        if (!banned) return;
        for (const spec of node.specifiers) {
          if (spec.type === 'ImportSpecifier' && banned.has(spec.imported.name)) {
            context.report({ node: spec, messageId: 'call', data: { name: spec.imported.name } });
          }
        }
      },
      CallExpression(node) {
        const name = propName(node.callee);
        if (!name) return;
        const obj = node.callee.object;
        const isRnShare =
          name === 'share' &&
          ((obj.type === 'Identifier' && shareNames.has(obj.name)) ||
            (obj.type === 'MemberExpression' && propName(obj) === 'Share')); // RN.Share.share()
        if (PRESENTER_METHODS.has(name) || isRnShare) {
          context.report({ node, messageId: 'call', data: { name: isRnShare ? 'Share.share' : name } });
        }
      },
    };
  },
};

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);
/** Hooks that return a router / navigation object. */
const ROUTER_HOOKS = new Set(['useRouter', 'useNavigation']);
const ROUTER_MODULES = new Set(['expo-router', '@react-navigation/native', '@react-navigation/core']);
/** Wrappers whose callback is already held until unlocked. */
const GUARDS = new Set(['navigateWhenUnlocked']);
/** Object keys whose function is a tap handler (a toast action, an Alert button — the alert guard holds those). */
const TAP_KEYS = /^on(?:Press|LongPress|PressIn|PressOut)$/;
/** UI that is only safe from a tap: its buttons are not covered by the alert guard. */
const LATE_PRESENTERS = new Set(['showActionSheetWithOptions']);

function isPromiseCallback(fn) {
  const parent = fn.parent;
  return (
    !!parent &&
    parent.type === 'CallExpression' &&
    parent.arguments.includes(fn) &&
    PROMISE_CALLBACKS.has(propName(parent.callee) || '')
  );
}

function calleeName(call) {
  if (!call || call.type !== 'CallExpression') return null;
  if (call.callee.type === 'Identifier') return call.callee.name;
  return propName(call.callee);
}

/**
 * A function whose body is known to run only from a tap or once unlocked, so
 * nothing in it is "late" however late it was created: a JSX event handler,
 * a tap key in an object literal (toast actions, Alert buttons), or the
 * callback handed to navigateWhenUnlocked.
 */
function isExemptFunction(fn) {
  const parent = fn.parent;
  if (!parent) return false;
  if (parent.type === 'JSXExpressionContainer') return true;
  if (parent.type === 'Property' && parent.value === fn) {
    const key = parent.key.type === 'Identifier' ? parent.key.name : parent.key.type === 'Literal' ? String(parent.key.value) : '';
    if (TAP_KEYS.test(key)) return true;
  }
  if (parent.type === 'CallExpression' && parent.arguments.includes(fn) && GUARDS.has(calleeName(parent) || '')) return true;
  return false;
}

const navigationAfterAwait = {
  meta: {
    type: 'problem',
    docs: { description: 'Navigation after async work must go through navigateWhenUnlocked (lib/nav-guard.ts).' },
    schema: [],
    messages: {
      afterAwait:
        '{{call}}() runs after an await: if the app was locked meanwhile it acts on the /lock screen. Wrap it in navigateWhenUnlocked(() => …) from lib/nav-guard.',
      inCallback:
        '{{call}}() runs in a promise callback: if the app was locked meanwhile it acts on the /lock screen. Wrap it in navigateWhenUnlocked(() => …) from lib/nav-guard.',
      deferred:
        '{{call}}() runs in a callback created after an await (a timer, a listener, a promise chain): if the app was locked meanwhile it acts on the /lock screen. Wrap it in navigateWhenUnlocked(() => …) from lib/nav-guard.',
      indirect:
        '{{call}} navigates, and runs here after async work: if the app was locked meanwhile it acts on the /lock screen. Wrap the call in navigateWhenUnlocked(() => …) from lib/nav-guard.',
      sheet:
        '{{call}}() opens an action sheet after async work: it would appear above the App Lock screen, and its buttons are not guarded. Open action sheets only from a tap.',
    },
  },
  create(context) {
    const sourceCode = context.sourceCode || context.getSourceCode();
    const frames = []; // every function, in source order
    const stack = [];
    const loops = []; // loop nodes, innermost last, with their function frame
    const lateUses = []; // identifiers / member refs used where a navigation would be late: { node, frame, loopsHere }
    const sheetCalls = [];
    const promiseRefArgs = []; // non-inline promise callbacks: .then(done), .then(router.back)
    const navCalls = []; // { node, frame, loopsHere, label }

    const scopeOf = node => (sourceCode.getScope ? sourceCode.getScope(node) : context.getScope());
    function findVariable(node) {
      let scope = scopeOf(node);
      while (scope) {
        const v = scope.set.get(node.name);
        if (v) return v;
        scope = scope.upper;
      }
      return null;
    }

    // ── What is a router, and what is a navigation call ──────────────────────
    function isRouterHookCall(expr) {
      if (!expr || expr.type !== 'CallExpression') return false;
      if (expr.callee.type !== 'Identifier') return false;
      if (ROUTER_HOOKS.has(expr.callee.name)) return true;
      const v = findVariable(expr.callee);
      const def = v && v.defs[0];
      return !!def && def.type === 'ImportBinding' && def.node.type === 'ImportSpecifier' &&
        ROUTER_HOOKS.has(def.node.imported.name) && ROUTER_MODULES.has(def.parent.source.value);
    }
    function isRouterObj(expr, seen = new Set()) {
      if (!expr) return false;
      if (expr.type === 'TSAsExpression' || expr.type === 'TSNonNullExpression') return isRouterObj(expr.expression, seen);
      if (expr.type === 'CallExpression') return isRouterHookCall(expr);
      if (expr.type === 'MemberExpression') return NAV_OBJECTS.has(propName(expr) || '');
      if (expr.type !== 'Identifier') return false;
      if (NAV_OBJECTS.has(expr.name)) return true;
      if (seen.has(expr.name)) return false;
      seen.add(expr.name);
      const v = findVariable(expr);
      const def = v && v.defs[0];
      if (!def) return false;
      if (def.type === 'ImportBinding') {
        return def.node.type === 'ImportSpecifier' && def.node.imported.name === 'router' && ROUTER_MODULES.has(def.parent.source.value);
      }
      if (def.type === 'Variable' && def.node.id.type === 'Identifier') return isRouterObj(def.node.init, seen);
      return false;
    }
    /** A bare identifier bound to a navigation method: `const { back } = router`, `const go = router.push`. */
    function isNavFunctionRef(id) {
      if (!id || id.type !== 'Identifier') return null;
      const v = findVariable(id);
      const def = v && v.defs[0];
      if (!def || def.type !== 'Variable') return null;
      const decl = def.node;
      if (decl.id.type === 'ObjectPattern') {
        const prop = decl.id.properties.find(p => p.type === 'Property' && p.value.type === 'Identifier' && p.value.name === id.name);
        const key = prop && (prop.key.type === 'Identifier' ? prop.key.name : prop.key.type === 'Literal' ? String(prop.key.value) : null);
        return key && NAV_METHODS.has(key) && isRouterObj(decl.init) ? `${sourceCode.getText(decl.init)}.${key}` : null;
      }
      if (decl.id.type === 'Identifier' && decl.init && decl.init.type === 'MemberExpression') {
        const name = propName(decl.init);
        return name && NAV_METHODS.has(name) && isRouterObj(decl.init.object) ? sourceCode.getText(decl.init) : null;
      }
      return null;
    }
    /** `router.back` as a value (not called): the method itself handed on. */
    function isNavMemberRef(expr) {
      return expr && expr.type === 'MemberExpression' && NAV_METHODS.has(propName(expr) || '') && isRouterObj(expr.object);
    }
    function navCallLabel(call) {
      const callee = call.callee;
      if (callee.type === 'MemberExpression') {
        const name = propName(callee);
        if (name && NAV_METHODS.has(name) && isRouterObj(callee.object)) return sourceCode.getText(callee);
        return null;
      }
      if (callee.type === 'Identifier') return isNavFunctionRef(callee);
      return null;
    }

    // ── Does a local function navigate (directly, or through another one)? ──
    const navigatesMemo = new Map();
    function functionOf(id, seen = new Set()) {
      if (!id || id.type !== 'Identifier' || seen.has(id.name)) return null;
      seen.add(id.name);
      const v = findVariable(id);
      const def = v && v.defs[0];
      if (!def) return null;
      if (def.type === 'FunctionName') return def.node;
      if (def.type === 'Variable' && def.node.id.type === 'Identifier') {
        let init = def.node.init;
        // useCallback(fn, deps) / useMemo-free wrappers: the function inside.
        if (init && init.type === 'CallExpression' && calleeName(init) === 'useCallback') init = init.arguments[0];
        if (!init) return null;
        if (FUNCTION_TYPES.has(init.type)) return init;
        if (init.type === 'Identifier') return functionOf(init, seen);
      }
      return null;
    }
    function navigates(fn, depth = 0) {
      if (!fn) return false;
      if (navigatesMemo.has(fn)) return navigatesMemo.get(fn);
      navigatesMemo.set(fn, false); // cycles
      let found = false;
      const visit = (node, top) => {
        if (found || !node || typeof node.type !== 'string') return;
        if (!top && FUNCTION_TYPES.has(node.type) && isExemptFunction(node)) return;
        if (node.type === 'CallExpression') {
          if (navCallLabel(node)) { found = true; return; }
          if (depth < 4 && node.callee.type === 'Identifier') {
            const inner = functionOf(node.callee);
            if (inner && inner !== fn && navigates(inner, depth + 1)) { found = true; return; }
          }
        }
        const keys = sourceCode.visitorKeys[node.type] || [];
        for (const k of keys) {
          const child = node[k];
          if (Array.isArray(child)) child.forEach(c => visit(c, false));
          else visit(child, false);
        }
      };
      visit(fn, true);
      navigatesMemo.set(fn, found);
      return found;
    }

    // ── Collection ───────────────────────────────────────────────────────────
    function currentLoops(frame) {
      return loops.filter(l => l.frame === frame).map(l => l.node);
    }
    function enterFn(node) {
      const parent = stack[stack.length - 1] || null;
      const frame = {
        node,
        parent,
        awaits: [],
        loopsWithAwait: new Set(),
        loopsAtCreation: parent ? currentLoops(parent) : [],
        promiseCb: isPromiseCallback(node),
        exempt: isExemptFunction(node),
      };
      frames.push(frame);
      stack.push(frame);
    }
    function exitFn() {
      stack.pop();
    }
    function noteAwait(start) {
      const frame = stack[stack.length - 1];
      if (!frame) return;
      frame.awaits.push(start);
      for (const l of loops) if (l.frame === frame) frame.loopsWithAwait.add(l.node);
    }

    const deferredMemo = new Map();
    /** Created after an await (or inside a promise callback / another such function), and not a tap handler. */
    function isDeferred(frame) {
      if (!frame || frame.exempt || !frame.parent) return false;
      if (deferredMemo.has(frame)) return deferredMemo.get(frame);
      const p = frame.parent;
      const result =
        p.promiseCb ||
        isDeferred(p) ||
        p.awaits.some(a => a < frame.node.range[0]) ||
        frame.loopsAtCreation.some(l => p.loopsWithAwait.has(l));
      deferredMemo.set(frame, result);
      return result;
    }
    /** Why code at `node` in `frame` may run while locked, or null. */
    function lateness(node, frame, loopsHere) {
      if (!frame || frame.exempt) return null;
      if (frame.promiseCb) return 'inCallback';
      if (frame.awaits.some(a => a < node.range[1]) || loopsHere.some(l => frame.loopsWithAwait.has(l))) return 'afterAwait';
      if (isDeferred(frame)) return 'deferred';
      return null;
    }

    const handlers = {
      AwaitExpression(node) {
        noteAwait(node.range[0]);
      },
      'ForOfStatement[await=true]'(node) {
        noteAwait(node.range[0]);
      },
      'CallExpression:exit'(node) {
        const name = propName(node.callee);
        // .then(done) / .then(router.back): late wherever it is written.
        if (PROMISE_CALLBACKS.has(name || '')) {
          for (const arg of node.arguments) {
            if (arg.type === 'Identifier' || arg.type === 'MemberExpression') promiseRefArgs.push(arg);
          }
        }
        const frame = stack[stack.length - 1];
        if (!frame) return;
        const loopsHere = currentLoops(frame);
        const label = navCallLabel(node);
        if (label) {
          navCalls.push({ node, frame, loopsHere, label });
          return;
        }
        if (name && LATE_PRESENTERS.has(name)) sheetCalls.push({ node, frame, loopsHere, label: sourceCode.getText(node.callee) });
        // A local function that navigates, called late: `await x; done();`
        if (node.callee.type === 'Identifier') lateUses.push({ node: node.callee, call: node, frame, loopsHere });
        // Handed to a timer / listener late: setTimeout(done, 0), setTimeout(router.back).
        if (!GUARDS.has(calleeName(node) || '') && !PROMISE_CALLBACKS.has(name || '')) {
          for (const arg of node.arguments) {
            if (arg.type === 'Identifier' || arg.type === 'MemberExpression') lateUses.push({ node: arg, call: node, frame, loopsHere });
          }
        }
      },
      'Program:exit'() {
        for (const { node, frame, loopsHere, label } of navCalls) {
          const why = lateness(node, frame, loopsHere);
          if (why) context.report({ node, messageId: why, data: { call: label } });
        }
        for (const { node, frame, loopsHere, label } of sheetCalls) {
          if (lateness(node, frame, loopsHere)) context.report({ node, messageId: 'sheet', data: { call: label } });
        }
        for (const arg of promiseRefArgs) {
          if (isNavMemberRef(arg)) context.report({ node: arg, messageId: 'inCallback', data: { call: sourceCode.getText(arg) } });
          else if (arg.type === 'Identifier' && (isNavFunctionRef(arg) || navigates(functionOf(arg)))) {
            context.report({ node: arg, messageId: 'indirect', data: { call: `${arg.name}` } });
          }
        }
        for (const { node, call, frame, loopsHere } of lateUses) {
          if (!lateness(call, frame, loopsHere)) continue;
          if (isNavMemberRef(node) || (node.type === 'Identifier' && (isNavFunctionRef(node) && call.callee !== node))) {
            context.report({ node, messageId: 'indirect', data: { call: sourceCode.getText(node) } });
          } else if (node.type === 'Identifier' && navigates(functionOf(node))) {
            context.report({ node, messageId: 'indirect', data: { call: `${node.name}` } });
          }
        }
      },
    };
    for (const t of FUNCTION_TYPES) {
      handlers[t] = enterFn;
      handlers[`${t}:exit`] = exitFn;
    }
    for (const t of LOOP_TYPES) {
      handlers[t] = node => loops.push({ node, frame: stack[stack.length - 1] });
      handlers[`${t}:exit`] = () => loops.pop();
    }
    return handlers;
  },
};

module.exports = {
  meta: { name: 'lock-safe' },
  rules: {
    'native-presenter': nativePresenter,
    'navigation-after-await': navigationAfterAwait,
  },
};
