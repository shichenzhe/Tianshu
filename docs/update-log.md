# Update Log

## 0.1.2

- Fix: chat sessions and workflows invisible in the sidebar after upgrading from 0.1.0/0.1.1 (new columns missing in existing databases — now backfilled idempotently on startup; all data intact).
- Release page now ships unsigned-installation instructions (macOS Gatekeeper "damaged" notice / Windows SmartScreen bypass) — the installer is not actually corrupted.

## 0.1.1

- Automation run detail experience: right-side run board for quick switching, topology/steps dual view, node detail inspector dialog, per-run chat drafts.
- Fix: run graph canvas broken on session routes (collapsed height, no pan/zoom, node clicks ineffective).
- Fix: node detail dialog height jump on tab switch.

## 0.1.0

- Initial release.
