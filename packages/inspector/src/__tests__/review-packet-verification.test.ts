import { describe, expect, test } from 'bun:test';
import { buildReviewPacket } from '../review-packet.ts';
import type { ISharkcraftInspection } from '../sharkcraft-inspector.ts';

function stub(config: unknown): ISharkcraftInspection {
  return {
    projectRoot: '/repo',
    knowledgeEntries: [],
    templates: [],
    pipelines: [],
    presetRegistry: { list: () => [] },
    workspace: { profiles: [] },
    ruleService: { list: () => [] },
    pathService: { list: () => [] },
    boundaryRegistry: { size: () => 0, list: () => [] },
    pipelineRegistry: { get: () => undefined },
    config,
  } as unknown as ISharkcraftInspection;
}

describe('review packet verification commands', () => {
  test('configured verificationCommands override the generic tsc/test default', () => {
    const packet = buildReviewPacket(
      stub({ verificationCommands: [{ id: 'v', command: 'make verify' }] }),
      { files: ['src/foo.ts'] },
    );
    expect(packet.verificationCommands).toContain('make verify');
    expect(packet.verificationCommands).not.toContain('bun x tsc -p tsconfig.base.json --noEmit');
    // SharkCraft's own engine meta-checks stay as a generic prefix.
    expect(packet.verificationCommands).toContain('shrk doctor');
    expect(packet.verificationCommands).toContain('shrk check boundaries');
  });

  test('falls back to the generic tsc/test pair when nothing is configured', () => {
    const packet = buildReviewPacket(stub(null), { files: ['src/foo.ts'] });
    expect(packet.verificationCommands).toContain('bun x tsc -p tsconfig.base.json --noEmit');
    expect(packet.verificationCommands).toContain('bun test');
  });
});
