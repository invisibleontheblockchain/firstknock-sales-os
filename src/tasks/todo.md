# Current Task: Fix TerritoryPrompt JSX build error

## Plan
- [x] Inspect the Pull / Fill Gaps JSX block around the build error.
- [x] Correct the JSX grouping without changing behavior.
- [x] Document verification and lesson learned.

## Review
The build failed because the non-Pro branch of the conditional returned two sibling JSX nodes (`Pull` button plus conditional `Fill Gaps` button) without a wrapper. I wrapped them in a React fragment, preserving the same behavior while making the JSX valid.