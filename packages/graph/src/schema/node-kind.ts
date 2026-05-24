/**
 * Node kinds in the code graph.
 *
 * MVP ships File / Symbol / Package. Bridge kinds are reserved but emitted
 * by the rule-graph package (Wave 2), not by graph itself.
 */
export enum NodeKind {
  File = 'file',
  Symbol = 'symbol',
  Package = 'package',

  // Reserved for @shrkcrft/rule-graph (Wave 2). Listed here so node ids stay
  // globally namespaced and the union surface is stable.
  Rule = 'rule',
  Path = 'path',
  Template = 'template',
  Pipeline = 'pipeline',
  Preset = 'preset',
  Pack = 'pack',
  Boundary = 'boundary',
  Knowledge = 'knowledge',

  // Framework-aware entities (Wave 7). The `data.framework` and
  // `data.subtype` fields distinguish nestjs:controller vs
  // react:component vs express:route. Single kind keeps the NodeKind
  // enum tight; consumers filter on data.
  FrameworkEntity = 'framework-entity',
}
