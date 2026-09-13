/**
 * Which directory a reference's `path` (and its `contains` / `matches` /
 * `count` reads) resolves against.
 *
 * - `project` (the default, and what an absent `root` means): the consuming
 *   project's root — every local entry, and a pack's reference to a file every
 *   consumer is guaranteed to have.
 * - `pack`: the CONTRIBUTING pack's package directory (its `packageRoot` as
 *   pack discovery resolved it), so a pack's docs can verify against files the
 *   pack itself ships. Valid only on a pack-contributed entry — a local entry
 *   has no pack directory, so `root: pack` there is a validation error and an
 *   INVALID stale-check row, never a silent fallback to the project root.
 *
 * Only path-based parts of a reference read it (`file` / `directory` /
 * `symbol` paths, content assertions, a `count` source); an id kind
 * (`template:`, `command:`, …) resolves wherever the pack is installed.
 */
export enum KnowledgeReferenceRoot {
  Project = 'project',
  Pack = 'pack',
}
