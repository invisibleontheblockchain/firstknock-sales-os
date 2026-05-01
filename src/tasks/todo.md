# Current Task: Make saved routes render in distinct colors

## Plan
- [x] Find where route polylines/markers choose their colors.
- [x] Identify why routes fall back to grey.
- [x] Patch color assignment so every route gets a stable distinct color.
- [x] Verify the route-color logic and document the result.

## Review
Routes were grey because completed saved routes were explicitly forced to `#6b7280`. That override is removed, and both saved and generated routes now use a stable hue rotation based on route number so each visible route gets its own color instead of repeating a short palette.