---
id: cz.kmd-bad
title:
  - K
  - Markdown
---
# Census Markdown knowledge

The census's Markdown knowledge file (round 15 follow-up, F12): its ONE entry is
invalid — `title` is a list where one value belongs — so the Markdown loader
refuses it through the rejection channel, like every other slot's last entry.
The list is a BLOCK list on purpose: since round 15 closing an inline
`title: [K, Markdown]` is the title text, the way the pre-round-15 line reader
read it.
