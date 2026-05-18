import { describe, expect, it } from 'bun:test';
import {
  AgentContractTemplateMatch,
  getContractTemplate,
  listContractTemplates,
  recommendContractTemplate,
} from '../agent-contract-templates.ts';
import { RoleId } from '../role-views.ts';

describe('contract templates', () => {
  it('lists all built-in templates', () => {
    const list = listContractTemplates();
    // Engine ships 6 generic built-ins. Project-specific templates live in
    // the contributing pack, never in the engine.
    expect(list.length).toBe(6);
    const ids = list.map((t) => t.id);
    expect(ids).toContain('ai-agent-safe-change');
    expect(ids).toContain('public-api-change');
    expect(ids).toContain('release-task');
    expect(ids).toContain('migration-task');
    expect(ids).toContain('security-sensitive-change');
    expect(ids).toContain('polyglot-service-change');
  });

  it('get by id returns the template', () => {
    const t = getContractTemplate('release-task');
    expect(t?.role).toBe(RoleId.ReleaseManager);
  });

  it('recommends public-api template for an API task', () => {
    const recs = recommendContractTemplate('change the public api surface', RoleId.Developer);
    const ids = recs.map((r) => r.template.id);
    expect(ids).toContain('public-api-change');
  });

  it('recommends release template for a release task', () => {
    const recs = recommendContractTemplate('cut a release and publish version 0.2', RoleId.ReleaseManager, 'release');
    expect(recs[0]!.template.id).toBe('release-task');
    expect(recs[0]!.match).toBe(AgentContractTemplateMatch.Exact);
  });
});
