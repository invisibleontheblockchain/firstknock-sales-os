# Plan

## Current Plan — Private Account Messaging + Mobile Input Fix
- [x] Identify the current message read/write path and mobile chat layout.
- [x] Add account/team ownership fields to TeamMessage and replace global read access with account-scoped RLS.
- [x] Stamp all newly sent messages with manager/team ownership and explicit participant emails.
- [x] Scope the old General channel per account instead of globally.
- [x] Add mobile bottom-nav-safe spacing so the message input remains visible.
- [x] Verify message privacy rules and mobile layout-sensitive classes.

### Review — Private Account Messaging + Mobile Input Fix
Team messages are now scoped by manager/account ID and participant emails at the entity rule level, new messages are stamped with that account ownership, General is now account-specific, and the mobile chat overlay/input reserves space above the bottom nav and safe area.