# Per-Bot models

Use one optional model ID per Bot; empty selects the server default. Fetch choices from the existing
server-side model endpoint, never exposing its credentials. Validate model changes, preserve saved
choices if the catalog is temporarily unavailable, and inherit selection in temporary helpers.

1. Add a SQLite migration, shared Bot contract, authenticated model catalog, and validated update route.
2. Add a selector in Bot Settings → General with loading, retry, default, and unavailable-choice states.
3. Use each Bot's choice in chat and memory work. Track the model used for history and remove opaque
   reasoning/compaction items on a change, preserving readable messages and tool results.
4. Test catalog/auth, persistence, invalid choices, inheritance, and history switching using a temporary
   database and local mock endpoint. Run existing tests, typecheck, and build; verify live catalog and
   a temporary Bot request, deploy, and push directly to the public fork's main branch.
