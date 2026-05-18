import { toCamelCase, toKebabCase, toPascalCase, toSnakeCase } from '@shrkcrft/core';
import { NamingStrategy } from './overwrite-strategy.ts';
import type { TemplateVariableValues } from '@shrkcrft/templates';

export function applyNaming(name: string, strategy: NamingStrategy): string {
  switch (strategy) {
    case NamingStrategy.Kebab:
      return toKebabCase(name);
    case NamingStrategy.Pascal:
      return toPascalCase(name);
    case NamingStrategy.Camel:
      return toCamelCase(name);
    case NamingStrategy.Snake:
      return toSnakeCase(name);
    case NamingStrategy.AsIs:
    default:
      return name;
  }
}

export function buildNameVariables(name: string): TemplateVariableValues {
  return {
    name: toKebabCase(name),
    kebab: toKebabCase(name),
    pascal: toPascalCase(name),
    camel: toCamelCase(name),
    snake: toSnakeCase(name),
    className: toPascalCase(name),
    fileName: toKebabCase(name),
  };
}
