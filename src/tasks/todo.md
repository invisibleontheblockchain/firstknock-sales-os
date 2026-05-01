# Plan

- [x] Confirm why the close route button changes zoom.
- [x] Update only the close button behavior so it closes the active route without changing map zoom.
- [x] Verify the code path no longer calls map zoom APIs.

## Review
The selected close button had an inline handler that called `mapRef.current.setZoom(Math.max(13, mapRef.current.getZoom() - 2))` after closing the active route. That forced a zoom change and could feel like a buggy zoom jump depending on the current map state. I removed only that map zoom call and kept the route close behavior intact, with `stopPropagation()` added so the click does not bubble into map/UI handlers.