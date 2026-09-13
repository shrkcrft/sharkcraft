/**
 * THE framework vocabulary (round 15, 15.1) — every id `detectFrameworks` can
 * report in `inspection.workspace.frameworks[].id`, and so every value a
 * convention's `appliesTo.frameworks` may name.
 *
 * It was a module-private list inside the detector, so nothing could validate
 * an id against it, and the profile detector tested `'next'` against a
 * detector that only ever emits `'nextjs'` (a branch that could never fire).
 * The detector's table is keyed by this enum, so a framework added here
 * without a definition is a compile error, and `hasFramework` only accepts a
 * member.
 *
 * Distinct from the WorkspaceProfile ids (`has-next`, `has-nestjs`): a profile
 * is derived evidence about the repo, a framework id is what the detector saw.
 */
export enum FrameworkId {
  Angular = 'angular',
  React = 'react',
  Vue = 'vue',
  Svelte = 'svelte',
  NextJs = 'nextjs',
  Nuxt = 'nuxt',
  NestJs = 'nestjs',
  Express = 'express',
  Fastify = 'fastify',
  Nx = 'nx',
  AwsLambda = 'aws-lambda',
  Electron = 'electron',
  TypeScript = 'typescript',
  Bun = 'bun',
}
