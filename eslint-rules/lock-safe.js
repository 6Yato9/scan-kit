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
//   createAssetAsync, Share.share and ActionSheetIOS share sheets may only be
//   called from the lock-aware helpers: lib/share.ts (shareFile, printFile)
//   and lib/photos.ts (savePagesToPhotos). Those await whenUnlocked()
//   (lib/nav-guard.ts) internally, so callers can't forget.
//
// lock-safe/navigation-after-await
//   router.back / replace / push / navigate / dismiss / dismissTo /
//   dismissAll may not run after an `await` in the same function (or inside a
//   loop that awaits), nor inside a .then / .catch / .finally callback. Wrap it:
//       navigateWhenUnlocked(() => router.replace(...));
//   which runs it at once when unlocked, otherwise after unlock once the lock
//   screen has gone. (A navigation in a nested callback, such as a button's
//   onPress defined after an await, is a tap and is not reported.)
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
    return {
      ImportDeclaration(node) {
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
        const isRnShare = name === 'share' && obj.type === 'Identifier' && obj.name === 'Share';
        if (PRESENTER_METHODS.has(name) || isRnShare) {
          context.report({ node, messageId: 'call', data: { name: isRnShare ? 'Share.share' : name } });
        }
      },
    };
  },
};

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);
const LOOP_TYPES = new Set(['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement']);

function isPromiseCallback(fn) {
  const parent = fn.parent;
  return (
    !!parent &&
    parent.type === 'CallExpression' &&
    parent.arguments.includes(fn) &&
    PROMISE_CALLBACKS.has(propName(parent.callee) || '')
  );
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
    },
  },
  create(context) {
    // One frame per function: its awaits and navigation calls, checked on exit
    // (an await inside a loop also comes "before" a call earlier in the loop).
    const stack = [];
    const loops = []; // loop nodes, innermost last, with their function frame

    function enterFn(node) {
      stack.push({ node, awaits: [], calls: [], loopsWithAwait: new Set() });
    }
    function exitFn() {
      const frame = stack.pop();
      if (!frame) return;
      const promiseCb = isPromiseCallback(frame.node);
      for (const { node, label, loopsHere } of frame.calls) {
        if (promiseCb) {
          context.report({ node, messageId: 'inCallback', data: { call: label } });
          continue;
        }
        const after =
          frame.awaits.some(a => a < node.range[1]) /* also `router.push(await x)` */ || loopsHere.some(l => frame.loopsWithAwait.has(l));
        if (after) context.report({ node, messageId: 'afterAwait', data: { call: label } });
      }
    }
    function noteAwait(start) {
      const frame = stack[stack.length - 1];
      if (!frame) return;
      frame.awaits.push(start);
      for (const l of loops) if (l.frame === frame) frame.loopsWithAwait.add(l.node);
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
        if (!name || !NAV_METHODS.has(name)) return;
        const obj = node.callee.object;
        if (obj.type !== 'Identifier' || !NAV_OBJECTS.has(obj.name)) return;
        const frame = stack[stack.length - 1];
        if (!frame) return;
        const loopsHere = loops.filter(l => l.frame === frame).map(l => l.node);
        frame.calls.push({ node, label: `${obj.name}.${name}`, loopsHere });
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
