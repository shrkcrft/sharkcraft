/**
 * What kind of member {@link ISymbolMemberEntry} indexes — one level deep
 * under a top-level owner.
 */
export enum SymbolMemberKind {
  Method = 'method',
  Property = 'property',
  Accessor = 'accessor',
  EnumMember = 'enum-member',
  InterfaceMember = 'interface-member',
  NamespaceMember = 'namespace-member',
  ObjectKey = 'object-key',
}
