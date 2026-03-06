---
"conductor-oss": patch
---

Fix legacy project paths that point to Markdown files by healing them to the real repository directory during config load and dashboard sync. Also deduplicate canonical and symlinked board paths so the same repo board is not watched twice on macOS.
