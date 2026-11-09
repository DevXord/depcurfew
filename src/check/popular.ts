// The popular npm packages and PyPI projects that depcurfew check, the hook and depcurfew mcp compare look-alike names
// with (decision D-182), for programs that call checkSpecs themselves, also without the network: the look-alike check
// asks no registry. The lists are those of the knowledge base (src/knowledge/popular.ts and popular-python.ts); Python
// names are normalized as pip compares them, as checkSpecs expects.
import { values } from '../apply/facts.ts';
import { popularPackages } from '../knowledge/popular.ts';
import { popularPythonPackages } from '../knowledge/popular-python.ts';
import { normalizePythonName } from '../policy/python-names.ts';
import { PopularNames } from './similar.ts';

/** The popular names under the field names of CheckOptions, so that they can be spread into the options of checkSpecs. */
export interface DefaultPopularNames {
  /** The popular npm packages. */
  readonly popular: PopularNames;
  /** The popular PyPI projects, by normalized name. */
  readonly popularPython: PopularNames;
}

let built: DefaultPopularNames | undefined;

/** The popular names depcurfew's own commands use, built once: checkSpecs(specs, { ...defaultPopularNames(), policy, … }). */
export function defaultPopularNames(): DefaultPopularNames {
  built ??= Object.freeze({
    popular: new PopularNames(values(popularPackages)[0] ?? []),
    popularPython: new PopularNames((values(popularPythonPackages)[0] ?? []).map(normalizePythonName)),
  });
  return built;
}
