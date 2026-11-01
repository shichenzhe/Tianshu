# Mobile WeChat UX/UI Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Improve the mobile app's navigation, touch ergonomics, feedback, and visual hierarchy using WeChat-inspired patterns without changing functionality.

**Architecture:** Keep Expo Router, React Native, NativeWind, and the existing theme/store architecture. Make localized presentation-only edits in shared navigation and components, then apply them to the chats, connections, composer, and settings surfaces; add no runtime dependencies.

**Tech Stack:** Expo 57, React Native 0.86, React 19, NativeWind 4, expo-router, react-i18next, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-mobile-wechat-ux-design.md`

## Global Constraints

- Do not change routes, features, stores, transport behavior, API contracts, data shapes, or capability gates.
- Use existing theme variables and iOS semantic colors; do not hardcode a WeChat brand theme.
- Add user-visible strings to both `zh-CN` and `en-US`; no hardcoded user-visible copy.
- Keep the existing Prettier style: double quotes, semicolons, two-space indentation, 80-column target, no trailing commas.
- Do not install dependencies or create commits unless the user separately requests them.

## Review Focus

- Dark mode: navigation, pressed states, sheets, and form controls must retain readable contrast; Task 1 and Task 4 end with source inspection of both color branches.
- Long connection names/endpoints and English button labels: content must truncate or wrap without pushing actions off-screen; Task 3 explicitly adds truncation and wrapping.
- iPhone home indicator and Android back: sheets must respect safe-area insets and retain `onRequestClose`; Task 4 verifies both.
- Keyboard-visible connection forms: all fields and footer actions must remain reachable; Task 3 adds scrolling and keyboard avoidance.
- Screen readers and disabled states: icon-only controls need labels, buttons need roles, and selected/disabled states must be exposed where applicable; Tasks 1–5 include accessibility checks.

---

### Task 1: Theme-aware navigation and reusable list/header ergonomics

**Files:**

- Modify: `apps/tianshu-mobile/src/app/_layout.tsx`
- Modify: `apps/tianshu-mobile/src/app/(tabs)/_layout.tsx`
- Modify: `apps/tianshu-mobile/src/components/PageHeader.tsx`
- Modify: `apps/tianshu-mobile/src/components/ListItem.tsx`
- Modify: `apps/tianshu-mobile/src/components/chats-header-actions.tsx`

**Interfaces:**

- Consumes: existing `useThemeColors()` and NativeWind `useColorScheme()`.
- Produces: consistent stack/tab colors and 44pt shared header/list interactions; no new exported API.

- [x] **Step 1: Run the mobile baseline checks**

Run: `npm run typecheck -w apps/tianshu-mobile && npm run test -w apps/tianshu-mobile`
Expected: existing checks pass; record any pre-existing failure before editing.

- [x] **Step 2: Apply navigation colors and metrics**

Use light card/grouped and dark black/card backgrounds, theme tint for stack headers and active tabs, subtle hairlines, 17px semibold stack titles, and 11px tab labels. Preserve all screen options and routes.

- [x] **Step 3: Normalize shared controls**

Make `PageHeader` a 48px centered-title header with a 44pt back target. Add pressed feedback and button roles to `ListItem` and chat header actions while preserving callbacks.

- [x] **Step 4: Verify Task 1**

Run: `npm run typecheck -w apps/tianshu-mobile`
Expected: PASS. Inspect light/dark style branches and confirm no route or callback changed.

### Task 2: Chat list and composer touch/accessibility refinement

**Files:**

- Modify: `apps/tianshu-mobile/src/app/(tabs)/index.tsx`
- Modify: `apps/tianshu-mobile/src/components/SessionRow.tsx`
- Modify: `apps/tianshu-mobile/src/components/Composer.tsx`
- Modify: `apps/tianshu-mobile/src/i18n/locales/zh-CN/chat.json`
- Modify: `apps/tianshu-mobile/src/i18n/locales/en-US/chat.json`

**Interfaces:**

- Consumes: existing session callbacks, composer props, and `chat` namespace.
- Produces: localized attachment-removal labels and larger touch targets; component prop signatures remain unchanged.

- [x] **Step 1: Add the missing bilingual labels**

Add labels for removing an image, file reference, local file, and skill reference, using interpolation where the item name is included.

- [x] **Step 2: Refine chat list interactions**

Increase group/search/filter/clear controls to reliable touch targets, add pressed feedback and button roles, and retain all grouping, search, filtering, and pagination behavior.

- [x] **Step 3: Refine session rows and composer**

Expose swipe actions to accessibility, add row pressed/long-press semantics, increase composer icon/send/stop/remove targets, add pressed feedback, and replace hardcoded accessibility strings with the new labels.

- [x] **Step 4: Verify Task 2**

Run: `npm run typecheck -w apps/tianshu-mobile && npm run test -w apps/tianshu-mobile`
Expected: PASS with no changed chat/store test snapshots or behavior.

### Task 3: Connection list and keyboard-safe form

**Files:**

- Modify: `apps/tianshu-mobile/src/app/(tabs)/connections.tsx`
- Modify: `apps/tianshu-mobile/src/components/ConnectionCard.tsx`
- Modify: `apps/tianshu-mobile/src/components/ConnectionForm.tsx`

**Interfaces:**

- Consumes: existing connection store methods and form callbacks.
- Produces: responsive connection cards and a scrollable keyboard-aware modal; no store or transport changes.

- [x] **Step 1: Refine connection creation actions**

Use 44pt buttons, pressed states, roles, and clear hierarchy while retaining separate direct and relay entry points.

- [x] **Step 2: Make connection cards resilient**

Truncate long name/endpoint text, allow action wrapping, enlarge action targets and text, and expose active/testing/disabled states accessibly.

- [x] **Step 3: Make the form reachable above the keyboard**

Wrap the modal form in `KeyboardAvoidingView` and `ScrollView` with `keyboardShouldPersistTaps="handled"`; give fields and buttons 44pt minimum heights and pressed feedback without changing validation or save/test logic.

- [x] **Step 4: Verify Task 3**

Run: `npm run typecheck -w apps/tianshu-mobile && npm run test -w apps/tianshu-mobile`
Expected: PASS. Inspect that all connection methods and validation branches are unchanged.

### Task 4: Safe-area sheets and animated accessible toast

**Files:**

- Modify: `apps/tianshu-mobile/src/components/AppActionSheet.tsx`
- Modify: `apps/tianshu-mobile/src/components/PlusSheet.tsx`
- Modify: `apps/tianshu-mobile/src/components/toast.tsx`

**Interfaces:**

- Consumes: existing sheet item/callback contracts, toast bus payloads, and safe-area context.
- Produces: identical actions with safer layout and clearer cancellation/feedback; no public payload changes.

- [x] **Step 1: Normalize bottom sheets**

Use slide-up transitions, real bottom safe-area padding, 44–48pt action targets, accessibility roles, pressed feedback, and an explicit common cancel action while retaining backdrop and Android-back dismissal.

- [x] **Step 2: Normalize toast feedback**

Add a subtle vertical entrance/exit to the existing opacity animation, preserve replacement/timing/action behavior, enlarge the action target, and add alert/live-region accessibility.

- [x] **Step 3: Verify Task 4**

Run: `npm run typecheck -w apps/tianshu-mobile && npm run test -w apps/tianshu-mobile`
Expected: PASS. Confirm action callbacks still close exactly once and toast undo timing is unchanged.

### Task 5: Settings polish and final verification

**Files:**

- Modify: `apps/tianshu-mobile/src/app/(tabs)/settings.tsx`
- Modify: `docs/superpowers/specs/2026-11-01-mobile-wechat-ux-design.md` (only if implementation requires a documented adjustment)

**Interfaces:**

- Consumes: existing settings navigation, theme, locale, and notification setters.
- Produces: clearer navigation affordances and selection accessibility; no settings behavior changes.

- [x] **Step 1: Polish settings affordances**

Add current-host chevron/accessibility, pressed states and selected roles for theme choices, accessible toggle labels, and remove the fixed developer build timestamp from the about row.

- [x] **Step 2: Run full mobile verification**

Run: `npm run typecheck -w apps/tianshu-mobile && npm run test -w apps/tianshu-mobile`
Expected: PASS.

- [x] **Step 3: Audit the final diff**

Run: `git diff --check && git diff -- apps/tianshu-mobile docs/superpowers/specs/2026-11-01-mobile-wechat-ux-design.md docs/superpowers/plans/2026-11-01-mobile-wechat-ux.md`
Expected: no whitespace errors; only planned UX/UI, i18n, and documentation changes. Summarize improvements and any device-only checks not performed.
