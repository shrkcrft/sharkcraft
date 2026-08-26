// A BARREL: consumers import `@x/ui`, which re-exports from generated/.
// This is the shape that makes `to.files` targeting return 0 edges — the
// import resolves to THIS file, not to the deep one.
export { NgeCardView } from './generated/NgeCardView';
export * from './generated/NgeListView';
