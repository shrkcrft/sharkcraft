/**
 * THE role measurement of a registration idiom — re-exported. Round 13 (P4):
 * the implementation moved to `@shrkcrft/boundaries`
 * (`packages/boundaries/src/wiring/measure-registration-roles.ts`) so the
 * registration-graph queries read the SAME authority `gates check` / `gates
 * coverage` read — MCP `get_wiring_graph` cannot import the CLI. Edit it
 * there; this path stays so every gates import is unchanged.
 */
export { measureRegistrationRoles } from '@shrkcrft/boundaries';
