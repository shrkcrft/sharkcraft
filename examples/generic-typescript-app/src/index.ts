/**
 * Generic TypeScript app skeleton. Real source code lives in src/.
 * SharkCraft's project knowledge lives in ../sharkcraft/.
 */
export function main(): string {
  return 'hello, sharkcraft';
}

if (import.meta.main === true) {
  // eslint-disable-next-line no-console
  console.log(main());
}
