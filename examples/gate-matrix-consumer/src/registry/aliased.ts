// An ALIASED sink: the local names are not the exported names, so the
// specifier for a new member cannot be derived from the name `--fix` would
// write. It must refuse (`needs-import`) and leave this file untouched.
import { ALPHA_HANDLER as Alpha } from '../handlers/ALPHA_HANDLER';
import { BETA_HANDLER as Beta } from '../handlers/BETA_HANDLER';

export const ALIASED_HANDLERS = [Alpha, Beta];
